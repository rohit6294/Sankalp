const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('cutoffs.db');
db.all(`SELECT * FROM cutoffs WHERE category='Open' AND seat_type != 'JEE(Main) Seats' AND institute LIKE '%Heritage%' AND program = 'Computer Science & Engineering' ORDER BY year DESC, round DESC`, (err, rows) => {
  if (err) console.error(err);
  else console.table(rows);
  db.close();
});
