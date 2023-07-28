-- menu お弁当のメニュー
-- drop table menu;
-- create table if not exists menu(
-- id integer primary key autoincrement,
-- name text,
-- description text,
-- price integer,
-- weekdays text,
-- regular integer,
-- start_day text, 
-- end_day text
-- );

-- drop table current_week;
-- create table if not exists  current_week(
-- start_day text,
-- end_day text
-- );


-- drop table obento_order;
-- create table if not exists obento_order(
-- id integer primary key autoincrement,
-- user_name text,
-- order_date text,
-- obento_id text,
-- number integer,
-- email text,
-- option text,
-- passwd text
--   );


-- insert into menu(name,description,price,regular)
-- values('日替わり弁当','',450,1),('カレーライス','',450,1),('カツカレー','',500,1),('チキンカツカレー','',500,1);

-- insert into menu(name,description,price,weekdays,regular,start_day,end_day)
-- values('チーズハンバーグ弁当','手作りデミソースがけ',500,'月,水,金',0,'2023-06-19','2023-06-23'),('コンビ丼','鳥のガーリック照り焼き・天ぷら・煮卵付き',600,'月,水,金',0,'2023-06-19','2023-06-23');

-- select m.id, m.name, m.price, m.description, m.price, m.weekdays
-- from menu m left outer join current_week c on m.start_day = c.start_day and m.end_day = c.end_day;

select m.name,sum(o.number),group_concat(o.user_name||'('||o.number||' '|| o.option||')')
from obento_order o join menu m on o.obento_id = m.id
where o.order_date = '2023-06-26'
group by o.obento_id

select o.order_date,m.name,o.number
from obento_order o join menu m on o.obento_id = m.id
where o.email='chiemi@a.tsukuba-tech.ac.jp'
 and o.order_date >= '2023-07-14';