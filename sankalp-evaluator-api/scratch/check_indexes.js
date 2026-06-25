const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '..', 'cutoffs.db');
const db = new sqlite3.Database(dbPath);

db.all("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='cutoffs'", [], (err, rows) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log("Indexes found on 'cutoffs':");
  console.log(rows);
  
  db.all("PRAGMA table_info(cutoffs)", [], (err, info) => {
    console.log("\nTable structure:");
    console.log(info);
    db.close();
  });
});
