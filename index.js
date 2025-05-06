const express = require('express');
const bcrypt = require('bcrypt');
const request = require('request');
const app = express();

const { date_jpn, dbget, get_datestr, nextorderday } = require('./utilities');

const bodyParser = require("body-parser");
app.set("view_engine", "ejs");
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));
module.exports = app;

const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10
});

// const sqlite3 = require('sqlite3').verbose();
// const fs = require("fs");
// const dbfile = "obento.db";
// const exists = fs.existsSync(dbfile);
// const db = new sqlite3.Database(dbfile);

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
  callbackURL: process.env['SERVER_DOMAIN'] + "/auth/microsoft/callback",
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
  res.render('login.ejs', { user: req.user });
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


app.get('/', async (req, res) => {
  const client = await pool.connect();
  try{
    const result = await client.query(query_menu);
    res.render("index.ejs",{
      user: req.user,
      admin: req.user && process.env['ADMIN_MEMBERS'].includes(req.user._json.mail),
      results: rows
    });
  } catch (err) {
    console.log(err);
  } finally {
    client.release();
  }
  // db.all(query_menu, (err, rows) => {
  //   if (err) {
  //     console.log(err);
  //   }
  //   else {
  //     res.render("index.ejs", {
  //       user: req.user,
  //       admin: req.user && process.env['ADMIN_MEMBERS'].includes(req.user._json.mail),
  //       results: rows
  //     });
  //   }
  // })
});

app.get('/orderform', ensureAuthenticated, async (req, res) => {
  try{
    const current_week = await dbget(pool, "select * from current_week", []);
    let start_day = current_week.start_day;
    const next_day = nextorderday(date_jpn(new Date()));
    if (next_day > Date.parse(current_week.start_day)) {
      start_day = get_datestr(next_day);
    }

    const client = await pool.connect();
    try {
      const result = await client.query(query_menu);
      res.render("orderform.ejs", {
        user: req.user,
        start_day: start_day,
        end_day: current_week.end_day,
        results: result.rows
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.log(err);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

app.post('/order', function(req, res) {
  const name = req.body.name;
  const email = req.body.address;
  const obento_id = req.body.menu;
  const order_date = req.body.order_date;
  const number = req.body.number;
  const option = req.body.option;
  db.serialize(function() {
    db.run("begin transaction");
    db.run("insert into obento_order(user_name,obento_id,order_date,number,email,option) values(?,?,?,?,?,?);", [name, obento_id, order_date, number, email, option]);
    db.get("select * from obento_order o join menu m on o.obento_id=m.id where o.id = last_insert_rowid()", (err, row) => {
      if (err) {
        console.log(err);
        db.run("abort");
      }
      else {
        db.run("commit");
        send_confirmation_mail(row);
        res.render("ordered.ejs", { user: req.user, result: row });
      }
    });
  });
});

app.get('/orderlist', ensureAuthenticated, (req, res) => {
  const email = req.user._json.mail;
  const today = get_datestr(date_jpn(new Date()));
  const query = "select o.order_date,m.name,o.number,o.option from obento_order o join menu m on o.obento_id = m.id where o.email=? and o.order_date >= ? and o.number > 0 order by order_date";
  db.all(query, [email, today], (err, rows) => {
    if (err) {
      console.log(err);
    }
    else {
      res.render("orderlist.ejs", { user: req.user, today: today, results: rows });
    }
  });
});

app.get('/admin/updatemenu', ensureAuthenticated, (req, res) => {
  if (process.env['ADMIN_MEMBERS'].includes(req.user._json.mail)) {
    res.render("updatemenu.ejs", { user: req.user });
  } else {
    res.redirect(req.baseUrl + '/');
  }
});

app.post('/admin/downloaddb', (req, res) => {
  if (req.body.token == process.env['ADMIN_TOKEN']) {
    res.set('Content-disposition',
      'attachment; filename=obento.db');
    const data = fs.readFileSync("obento.db");
    res.send(data);
  } else {
    res.redirect(req.baseUrl + '/');
  }
});

app.get('/admin/showorders', ensureAuthenticated, (req, res) => {
  if (process.env['ADMIN_MEMBERS'].includes(req.user._json.mail)) {
    const today = get_datestr(date_jpn(new Date()));
    const query = "select o.id as order_id,o.order_date,o.user_name,m.name,o.number from obento_order o join menu m on o.obento_id = m.id where o.order_date >= ? and o.number > 0 order by order_date";
    db.all(query, [today], (err, rows) => {
      if (err) {
        console.log(err);
      }
      else {
        res.render("orderlist_all.ejs", { today: today, results: rows });
      }
    });

  } else {
    res.redirect(req.baseUrl + '/');
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
      if (data[0]?.trim() && data[0] != "お弁当名") {
        data.push(0, start_date, end_date);
        db.run(query, data);
      }
    }
    db.run("delete from current_week");
    db.run("insert into current_week values(?,?)", [start_date, end_date]);
  });
  res.redirect(req.baseUrl + '/');
});

app.get('/admin/cancel', (req, res) => {
  if (req.query.admin_token == process.env['ADMIN_TOKEN']) {
    const order_id = req.query.order_id;
    const query = 'update obento_order set number = 0 where id=?';
    db.run(query, [order_id]);
  }
  res.redirect(req.baseUrl + '/admin/showorders');
});

app.post('/sendorders', (req, res) => {
  if (req.body.token == process.env['ADMIN_TOKEN']) {

    let date = date_jpn(new Date());
    date.setDate(date.getDate() + 1);

    query = "select m.name,sum(o.number) as number,group_concat(o.user_name||'('||o.number||o.option||')') as details from obento_order o join menu m on o.obento_id = m.id where o.order_date = ? and o.number > 0 group by o.obento_id";
    db.all(query, [get_datestr(date)], (err, rows) => {
      if (err) {
        console.log(err);
      } else {
        const message = [`${get_datestr(date)}の注文は以下の通りです。<br/>`];
        for (let row of rows) {
          message.push(`${row.name}${row.number}個（${row.details}）`);
        }
        var options = {
          uri: process.env['IFTTT_URL'] + process.env['IFTTT_TOKEN'],
          headers: {
            "Content-type": "application/json",
          },
          json: {
            "value1": message.join("\n")
          }
        }
        request.post(options, (error, ifttt_res, body) => {
          if (error) {
            console.log(error);
          }
          else {
            res.send(message.join("<br/>"));
          }
        })
      }
    });
  }
});


app.listen(3000, () => {
  console.log('server started');
});


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
備考：${row.option}
===================================

注文内容の修正および取り消しはできません。
ご理解の程よろしくお願いいたします。
`
  }
  sgMail.send(message).then(() => { console.log("Email sent") });
}
