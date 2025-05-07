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
  ssl: {
    rejectUnauthorized: false,
  }
});

const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env['SENDGRID_API_KEY']);

const passport = require('passport');
const session = require('express-session');
const { error } = require('console');
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
  try {
    const result = await client.query(query_menu);
    res.render("index.ejs", {
      user: req.user,
      admin: req.user && process.env['ADMIN_MEMBERS'].includes(req.user._json.mail),
      results: result.rows
    });
  } catch (err) {
    console.log(err);
  } finally {
    client.release();
  }
});

app.get('/orderform', ensureAuthenticated, async (req, res) => {
  try {
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

app.post('/order', async function(req, res) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { name, address: email, menu: obento_id, order_date, number, option } = req.body;

    const result = await client.query(
      'insert into obento_order(user_name,obento_id,order_date,number,email,option) values($1,$2,$3,$4,$5,$6) RETURNING id', [name, obento_id, order_date, number, email, option]
    );
    const orderId = result.rows[0].id;
    const orderResult = await client.query(
      'select * from obento_order o join menu m on o.obento_id=m.id where o.id = $1', [orderId]
    );

    await client.query('COMMIT');

    const orderData = orderResult.rows[0];
    send_confirmation_mail(orderData);
    res.render("ordered.ejs", { user: req.user, result: orderData });

  } catch (err) {
    console.log(err);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

app.post('/cancel-order', ensureAuthenticated, async (req, res) => {
  const client = await pool.connect();
  try {
    const orderId = req.body.orderId;

    // 注文情報を取得
    const orderResult = await client.query(
      'SELECT order_date FROM obento_order WHERE id = $1 AND email = $2',
      [orderId, req.user._json.mail]
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: '注文が見つかりません' });
    }

    const orderDate = new Date(orderResult.rows[0].order_date);
    const now = new Date();
    const cancelDeadline = new Date(orderDate);
    cancelDeadline.setDate(cancelDeadline.getDate() - 1);
    cancelDeadline.setHours(18, 29, 0, 0);

    if (now >= cancelDeadline) {
      return res.status(400).json({ error: 'キャンセル期限を過ぎています' });
    }

    // 注文をキャンセル（数量を0に設定）
    await client.query(
      'UPDATE obento_order SET number = 0 WHERE id = $1 AND email = $2',
      [orderId, req.user._json.mail]
    );

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'サーバーエラーが発生しました' });
  } finally {
    client.release();
  }
});

app.get('/orderlist', ensureAuthenticated, async (req, res) => {
  try {
    const email = req.user._json.mail;
    const today = get_datestr(date_jpn(new Date()));
    const query = "select o.order_date,m.name,o.number,o.option from obento_order o join menu m on o.obento_id = m.id where o.email=$1 and o.order_date >= $2 and o.number > 0 order by order_date";

    const client = await pool.connect();
    try {
      const result = await client.query(query, [email, today]);
      res.render("orderlist.ejs", { user: req.user, today: today, results: result.rows });
    } finally {
      client.release();
    }
  }
  catch (err) {
    console.log(err);
    res.status(500).send('サーバーエラーが発生しました');
  }
});

app.get('/admin/updatemenu', ensureAuthenticated, (req, res) => {
  if (process.env['ADMIN_MEMBERS'].includes(req.user._json.mail)) {
    res.render("updatemenu.ejs", { user: req.user });
  } else {
    res.redirect(req.baseUrl + '/');
  }
});

// app.post('/admin/downloaddb', (req, res) => {
//   if (req.body.token == process.env['ADMIN_TOKEN']) {
//     res.set('Content-disposition',
//       'attachment; filename=obento.db');
//     const data = fs.readFileSync("obento.db");
//     res.send(data);
//   } else {
//     res.redirect(req.baseUrl + '/');
//   }
// });

app.get('/admin/showorders', ensureAuthenticated, async (req, res) => {
  if (process.env['ADMIN_MEMBERS'].includes(req.user._json.mail)) {
    try {
      const today = get_datestr(date_jpn(new Date()));
      const query = "select o.id as order_id,o.order_date,o.user_name,m.name,o.number from obento_order o join menu m on o.obento_id = m.id where o.order_date >= $1 and o.number > 0 order by order_date";

      const client = await pool.connect();
      try {
        const result = await client.query(query, [today]);
        res.render("orderlist_all.ejs", { today: today, results: result.rows });
      } finally {
        client.release();
      }
    }
    catch (err) {
      console.log(err);
      res.status(500).send('サーバーエラーが発生しました');
    }
  } else {
    res.redirect(req.baseUrl + '/');
  }
});


app.post('/admin/update', ensureAuthenticated, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const start_date = req.body.start_date;
    const end_date = req.body.end_date;
    const query = "insert into menu(name,description,weekdays,price,regular,start_day,end_day) values($1,$2,$3,$4,$5,$6,$7)";

    for (let row of req.body.menu.split(/\n/)) {
      const data = row.split(',');
      data[3] = Number(data[3]);
      if (data[0]?.trim() && data[0] != "お弁当名") {
        data.push(0, start_date, end_date);
        await client.query(query, data);
      }
    }

    client.query("delete from current_week");
    client.query("insert into current_week values($1,$2)", [start_date, end_date]);

    client.query('COMMIT');
    res.redirect(req.baseUrl + '/');

  }
  catch (err) {
    await client.query('ROLLBACK');
    console.log(err);
    res.status(500).send('メニュー更新中にエラーが発生しました');
  }
  finally {
    client.release();
  }
});

app.post('/sendorders', async (req, res) => {
  if (req.body.token == process.env['ADMIN_TOKEN']) {
    try {
      let date = date_jpn(new Date());
      date.setDate(date.getDate() + 1);
      const orderDate = get_datestr(date);

      const query = `
        SELECT 
          m.name,
          SUM(o.number) as number,
          STRING_AGG(o.user_name || '(' || o.number || o.option || ')', ', ') as details 
        FROM obento_order o 
        JOIN menu m ON o.obento_id = m.id 
        WHERE o.order_date = $1 AND o.number > 0 
        GROUP BY o.obento_id, m.name`;

      const client = await pool.connect();
      try {
        const result = client.query(query, [orderDate]);
        const message = [`${get_datestr(date)}の注文は以下の通りです。<br/>`];
        for (let row of result.rows) {
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
            res.status(500).send('IFTTTへの送信中にエラーが発生しました');
          }
          else {
            res.send(message.join("<br/>"));
          }
        });
      } finally {
        client.release();
      }
    }
    catch (err) {
      console.log(err);
      res.status(500).send('IFTTTへの送信中にエラーが発生しました');
    }
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
12:10-12:30の間に食堂に行き、お弁当を受け取ってください。
お支払いはPaypayでお支払いください。支払いURLはTeamsにてお知らせしています。
不明な場合は渡辺のTeamsチャット（chiemi@a.tsukuba-tech.ac.jp）でご連絡ください。
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
