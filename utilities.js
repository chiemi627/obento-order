function nextorderday(dt) {
  let date = new Date(dt.getTime());
  //曜日を出す
  const weekday = dt.getDay();
  if (weekday < 5) { //日から木
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

module.exports = date_jpn;
module.exports = get_datestr;
module.exports = nextorderday;