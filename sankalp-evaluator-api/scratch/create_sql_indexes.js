const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const dbPath = path.join(__dirname, '..', 'cutoffs.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  console.log("Creating indexes on 'cutoffs' table...");
  
  db.run("CREATE INDEX IF NOT EXISTS idx_cutoffs_category ON cutoffs(category)", (err) => {
    if (err) console.error("Error category index:", err.message);
    else console.log("Created index on 'category'");
  });
  
  db.run("CREATE INDEX IF NOT EXISTS idx_cutoffs_seat_type ON cutoffs(seat_type)", (err) => {
    if (err) console.error("Error seat_type index:", err.message);
    else console.log("Created index on 'seat_type'");
  });
  
  db.run("CREATE INDEX IF NOT EXISTS idx_cutoffs_quota ON cutoffs(quota)", (err) => {
    if (err) console.error("Error quota index:", err.message);
    else console.log("Created index on 'quota'");
  });

  db.run("CREATE INDEX IF NOT EXISTS idx_cutoffs_college_type ON cutoffs(college_type)", (err) => {
    if (err) console.error("Error college_type index:", err.message);
    else console.log("Created index on 'college_type'");
  });

  db.run("CREATE INDEX IF NOT EXISTS idx_cutoffs_year_round ON cutoffs(year, round)", (err) => {
    if (err) console.error("Error year_round index:", err.message);
    else console.log("Created index on '(year, round)'");
  });
});

db.close((err) => {
  if (err) console.error("Error closing database:", err.message);
  else console.log("Database connection closed. Indexes created successfully!");
});
