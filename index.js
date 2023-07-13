const express = require('express');
const bcrypt = require('bcrypt');
const request = require('request');
const app = express();

const bodyParser = require("body-parser");
app.set("view_engine", "ejs");
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));
module.exports = app;

const sqlite3 = require('sqlite3').verbose();
const fs = require("fs");
const dbfile = "obento.db";
const exists = fs.existsSync(dbfile);
const db = new sqlite3.Database(dbfile);

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env['SENDGRID_API_KEY']);

const passport = require('passport');
const session = require('express-session');
const MicrosoftStrategy = require('passport-microsoft').Strategy;

app.use(session({
  secret: 'keyboard cat',
  resave: false,
  saveUninitialized: true
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});
passport.deserializeUser((obj, done) => {
  done(null, obj);
});

passport.use(new MicrosoftStrategy({
  clientID: process.env['MICROSOFT_CLIENT_ID'],
  clientSecret: process.env['MICROSOFT_CLIENT_SECRET'],
  callbackURL: process.env['SERVER_DOMAIN']+"/auth/microsoft/callback",
  scope: ['user.read'],
  tenant: 'common',
  },
  function(accessToken, refreshToken, profile, done) {
    process.nextTick(() => {
      return done(null, profile);
    });
  }
));


app.get('/auth/microsoft', passport.authenticate('microsoft', { prompt: 'select_account' }), (req, res) => { });

app.get('/auth/microsoft/callback',
  passport.authenticate('microsoft', { failureRedirect: '/login' }),
  (req, res) => { res.redirect("/"); }
);

app.get('/login', (req, res) => {
  res.render('login.ejs', {});
})

app.get('/logout',
  (req, res) => {
    req.logout((err) => {
      if (err) { return next(err); }
      res.redirect('/');
    });
  });

function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) { return next(); }
  res.redirect('/login');
}

const query_menu = "select m.id, m.name, m.price, m.description, m.price, m.weekdays,m.start_day,m.end_day from menu m where m.regular = 1 union all select m.id, m.name, m.price, m.description, m.price, m.weekdays,m.start_day,m.end_day from menu m join current_week c on m.start_day = c.start_day and m.end_day = c.end_day where m.regular=0;";


app.get('/', (req, res) => {
  db.all(query_menu, (err, rows) => {
    if (err) {
      console.log(err);
    }
    else {
      res.render("index.ejs", { results: rows });
    }
  })
});

app.get('/orderform', ensureAuthenticated, async (req, res) => {
  const current_week = await dbget("select * from current_week", []);
  let start_day = current_week.start_day;

  const next_day = nextorderday(date_jpn(new Date()));

  console.log(req.user);

  if (next_day > Date.parse(current_week.start_day)) {
    start_day = get_datestr(next_day);
  }

  db.all(query_menu, (err, rows) => {
    if (err) {
      console.log(err);
    }
    else {
      res.render("orderform.ejs", {
        user: req.user,
        start_day: start_day,
        end_day: current_week.end_day,
        results: rows
      });
    }
  })
});

app.post('/order', async function(req, res) {
  const name = req.body.name;
  const email = req.body.address;
  const obento_id = req.body.menu;
  const order_date = req.body.order_date;
  const number = req.body.number;
  const option = req.body.option;
  const password = await bcrypt.hash(req.body.password, 10);
  db.serialize(function() {
    db.run("begin transaction");
    db.run("insert into obento_order(user_name,obento_id,order_date,number,email,option,passwd) values(?,?,?,?,?,?,?);", [name, obento_id, order_date, number, email, option, password]);
    db.get("select * from obento_order o join menu m on o.obento_id=m.id where o.id = last_insert_rowid()", (err, row) => {
      if (err) {
        console.log(err);
        db.run("abort");
      }
      else {
        console.log(row);
        db.run("commit");
        send_confirmation_mail(row);
        res.render("ordered.ejs", row);
      }
    });
  });
});

app.get('/admin/updatemenu', ensureAuthenticated, (req, res) => {
  if(process.env['ADMIN_MEMBERS'].includes(req.user._json.mail)){
    res.render("updatemenu.ejs");
  }else{
    res.redirect(req.baseUrl+'/');
  }
});

app.post('/admin/downloaddb', (req, res) => {
  if(req.body.token==process.env['ADMIN_TOKEN']){
    res.set('Content-disposition', 
          'attachment; filename=obento.db');
    const data = fs.readFileSync("obento.db");
    res.send(data);
  }else{
    res.redirect(req.baseUrl+'/');
  }
});


app.post('/admin/update', ensureAuthenticated, (req, res) => {
  const start_date = req.body.start_date;
  const end_date = req.body.end_date;
  const query = "insert into menu(name,description,weekdays,price,regular,start_day,end_day) values(?,?,?,?,?,?,?)";
  db.serialize(function() {
    for (let row of req.body.menu.split(/\n/)) {
      const data = row.split(',');
      data[3] = Number(data[3]);
      data.push(0, start_date, end_date);
      db.run(query, data);
    }
    db.run("delete from current_week");
    db.run("insert into current_week values(?,?)", [start_date, end_date]);
  });
  res.redirect(req.baseUrl + '/');
});

app.get('/sendorders', (req, res) => {

  let date = date_jpn(new Date());
  date.setDate(date.getDate() + 1);

  query = "select m.name,sum(o.number) as number,group_concat(o.user_name||'('||o.number||o.option||')') as details from obento_order o join menu m on o.obento_id = m.id where o.order_date = ? group by o.obento_id";
  db.all(query, [get_datestr(date)], (err, rows) => {
    if (err) {
      console.log(err);
    } else {
      const message = [`${get_datestr(date)}の注文は以下の通りです。<br/>`];
      for (let row of rows) {
        message.push(`${row.name}${row.number}個（${row.details}）`);
      }
      var options = {
        uri: "https://maker.ifttt.com/trigger/obento-order/with/key/"+process.env['IFTTT_TOKEN'],
        headers: {
          "Content-type": "application/json",
        },
        json: {
          "value1": message.join("<br/>")
        }
      }
      request.post(options, (error, ifttt_res, body) => {
        if (error) {
          console.log(error);
        }
        else {
          console.log(body);
          res.send(message.join("<br/>"));
        }
      })
    }
  });
});


app.listen(3000, () => {
  console.log('server started');
});


function nextorderday(dt) {
  let date = new Date(dt.getTime());
  //曜日を出す
  const weekday = dt.getDay();
  if (weekday < 5) { //日から木
    console.log(date.getHours() * 100 + date.getMinutes());
    if (date.getHours() * 100 + date.getMinutes() > 1800) {
      date.setDate(date.getDate() + 2); //18：00を過ぎたら2日後。
    }
    else {
      date.setDate(date.getDate() + 1);  //それより前なら1日後   
    }
  }
  else if (weekday == 5) {//金→来週の月曜（3日後）
    date.setDate(date.getDate() + 3);
  }
  else if (weekday == 6) {//土→来週の月曜（2日後）
    date.setDate(date.getDate() + 2);
  }
  return date;
}

function get_datestr(dt) {
  const y = dt.getFullYear();
  const m = ("00" + (dt.getMonth() + 1)).slice(-2);
  const d = ("00" + (dt.getDate())).slice(-2);
  return y + "-" + m + "-" + d;
}

function dbget(sql, params) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      resolve(row);
    })
  });
}

function date_jpn(dt) {
  let date = new Date(dt.getTime());
  date.setHours(date.getHours() + 9); //9時間後
  return date;
}

function send_confirmation_mail(row) {
  const message = {
    to: row.email,
    from: 'chiemi@a.tsukuba-tech.ac.jp',
    subject: `お弁当注文（${row.order_date}）`,
    text: `
お弁当のご予約内容は以下の通りです。
12:10-12:30の間に食堂に行き、
このメールの内容を担当者に見せてください。
お支払いはお弁当と引き換えにお支払いください。
===================================
購入日：${row.order_date}
メニュー：${row.name}　${row.price}円
個数：${row.number}個
===================================

注文内容の修正および取り消しはできません。
ご理解の程よろしくお願いいたします。
`
  }
  sgMail.send(message).then(() => { console.log("Email sent") });
}
