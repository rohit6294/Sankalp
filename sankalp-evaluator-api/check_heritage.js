const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('cutoffs.db');
db.all(`SELECT * FROM cutoffs WHERE institute LIKE '%Heritage%' AND program LIKE '%Computer Science%' AND category='Open' ORDER BY year DESC`, (err, rows) => {
  if (err) console.error(err);
  else console.table(rows);
  db.close();
});
