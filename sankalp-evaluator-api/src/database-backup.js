const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const zlib = require('zlib');
const { db } = require('./firebase');

async function restoreDatabaseBackups() {
  console.log('Checking for database backups in Firestore...');
  try {
    const snapshot = await db.collection('cutoffBackups').get();
    if (snapshot.empty) {
      console.log('No database backups found in Firestore. Keeping local git database.');
      return;
    }

    console.log(`Found ${snapshot.size} year backups in Firestore. Restoring to SQLite...`);
    const dbPath = path.join(__dirname, '..', 'cutoffs.db');
    const sqliteDb = new sqlite3.Database(dbPath);
    sqliteDb.configure("busyTimeout", 10000);

    return new Promise((resolve, reject) => {
      // Run in transaction
      sqliteDb.serialize(() => {
        // Ensure the table exists
        sqliteDb.run(`
          CREATE TABLE IF NOT EXISTS cutoffs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            year TEXT,
            round INTEGER,
            institute TEXT,
            program TEXT,
            category TEXT,
            opening_rank INTEGER,
            closing_rank INTEGER,
            stream TEXT,
            seat_type TEXT,
            quota TEXT,
            college_type TEXT
          )
        `);

        sqliteDb.run('BEGIN TRANSACTION');
        
        // Clear current sqlite table first before restoring backups
        sqliteDb.run('DELETE FROM cutoffs');

        const insertStmt = sqliteDb.prepare(`
          INSERT INTO cutoffs (year, round, institute, program, category, opening_rank, closing_rank, stream, seat_type, quota, college_type)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        snapshot.docs.forEach(doc => {
          const year = doc.id;
          const data = doc.data();
          if (data.records) {
            try {
              const rawBuffer = Buffer.isBuffer(data.records) ? data.records : (data.records.toBuffer ? data.records.toBuffer() : Buffer.from(data.records));
              const records = JSON.parse(zlib.gunzipSync(rawBuffer).toString());
              console.log(`Restoring ${records.length} records for year ${year}...`);
              records.forEach(rec => {
                insertStmt.run(
                  rec.year,
                  rec.round,
                  rec.institute,
                  rec.program,
                  rec.category,
                  rec.opening_rank,
                  rec.closing_rank,
                  rec.stream,
                  rec.seat_type,
                  rec.quota,
                  rec.college_type
                );
              });
            } catch (decompressErr) {
              console.error(`Failed to decompress backup for year ${year}:`, decompressErr);
            }
          }
        });

        insertStmt.finalize();

        sqliteDb.run('COMMIT', (commitErr) => {
          sqliteDb.close();
          if (commitErr) {
            console.error('Database restore transaction commit failed:', commitErr.message);
            reject(commitErr);
          } else {
            console.log('Database restore completed successfully.');
            resolve();
          }
        });
      });
    });
  } catch (err) {
    console.error('Failed to restore database backups from Firestore:', err);
    throw err;
  }
}

async function backupYearToFirestore(year, records) {
  try {
    console.log(`Creating Firestore backup for year ${year} (${records.length} records)...`);
    const zlib = require('zlib');
    const compressed = zlib.gzipSync(JSON.stringify(records));
    
    await db.collection('cutoffBackups').doc(String(year)).set({
      records: compressed,
      updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
    });
    console.log(`Backup for year ${year} saved successfully.`);
  } catch (err) {
    console.error(`Failed to save backup for year ${year}:`, err);
  }
}

module.exports = { restoreDatabaseBackups, backupYearToFirestore };
