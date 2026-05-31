const XLSX = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { classifyCollegeType } = require('../src/college-types');

const files = [
  { year: 2024, path: 'C:\\Users\\rahul\\Downloads\\wbjee 2024 latest.xlsx' },
  { year: 2025, path: 'C:\\Users\\rahul\\Downloads\\wbjee 2025 latest.xlsx' }
];

const dbPath = path.join(__dirname, '..', 'cutoffs.db');
const sqliteDb = new sqlite3.Database(dbPath);

sqliteDb.serialize(() => {
  // Ensure the table exists
  sqliteDb.run(`
    CREATE TABLE IF NOT EXISTS cutoffs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      year INTEGER,
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

  console.log('Clearing old cutoff table records...');
  sqliteDb.run('DELETE FROM cutoffs');

  sqliteDb.run('BEGIN TRANSACTION');

  const insertStmt = sqliteDb.prepare(`
    INSERT INTO cutoffs (year, round, institute, program, category, opening_rank, closing_rank, stream, seat_type, quota, college_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalCount = 0;

  files.forEach(f => {
    console.log(`Processing WBJEE ${f.year} Excel sheet...`);
    try {
      const workbook = XLSX.readFile(f.path);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const rawRows = XLSX.utils.sheet_to_json(sheet);
      
      console.log(`Loaded ${rawRows.length} rows for year ${f.year}.`);

      // Read column mapping by cleaning keys
      const firstRow = rawRows[0] || {};
      const keyMap = {};
      Object.keys(firstRow).forEach(key => {
        const clean = String(key)
          .replace(/_▲▼/g, '')
          .replace(/_Γû▓Γû╝/g, '')
          .trim();
        keyMap[key] = clean;
      });

      const mappedRows = rawRows.map(row => {
        const mapped = {};
        Object.keys(row).forEach(key => {
          mapped[keyMap[key] || key] = row[key];
        });
        return mapped;
      });

      // Helper to find column case-insensitively
      function findValue(row, subStrKeywords, defaultVal = '') {
        const foundKey = Object.keys(row).find(k => {
          const kLower = k.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, '');
          return subStrKeywords.some(kw => kLower.includes(kw.toLowerCase().replace(/\s+/g, '')));
        });
        return foundKey !== undefined ? row[foundKey] : defaultVal;
      }

      mappedRows.forEach((row) => {
        const institute = String(findValue(row, ['institute', 'college', 'school', 'inst'], '')).trim();
        const program = String(findValue(row, ['program', 'branch', 'course', 'prog'], '')).trim();
        
        if (!institute || !program) return; // skip header or invalid rows

        const category = String(findValue(row, ['category', 'caste', 'reservation'], 'Open')).trim();
        const opening_rank = parseInt(findValue(row, ['opening', 'op'], 0), 10) || 0;
        const closing_rank = parseInt(findValue(row, ['closing', 'cl'], 0), 10) || 0;

        if (closing_rank <= 0) return; // skip rows without a valid closing rank

        // Round (default to 2 if not present)
        let roundVal = findValue(row, ['round', 'phase'], '');
        let roundNum = 2;
        if (roundVal) {
          const match = String(roundVal).match(/\d+/);
          if (match) roundNum = parseInt(match[0], 10);
        }

        // Stream (default to B.E/B.Tech or B.Pharm)
        let stream = String(findValue(row, ['stream', 'degree'], '')).trim();
        if (!stream) {
          const isPharm = program.toLowerCase().includes('pharma') || program.toLowerCase().includes('pharmacy');
          stream = isPharm 
            ? 'B.Pharm' 
            : 'B.E/B.Tech (WBJEE/JEE(Main) Seats)/B.Arch (WBJEE Seats)';
        }

        // Seat Type (default to WBJEE Seats)
        const seat_type = String(findValue(row, ['seat_type', 'seat type', 'type'], 'WBJEE Seats')).trim();

        // Quota (default to Home State)
        const quota = String(findValue(row, ['quota', 'state'], 'Home State')).trim();

        // College Type (calculate if not present)
        let college_type = String(findValue(row, ['college_type', 'college type', 'institute_type', 'institute type'], '')).trim();
        if (!college_type) {
          college_type = classifyCollegeType(institute, program);
        }

        insertStmt.run(
          f.year,
          roundNum,
          institute,
          program,
          category,
          opening_rank || closing_rank,
          closing_rank,
          stream,
          seat_type,
          quota,
          college_type
        );
        totalCount++;
      });
    } catch (err) {
      console.error(`Error processing file ${f.path}:`, err.message);
    }
  });

  insertStmt.finalize();

  sqliteDb.run('COMMIT', (err) => {
    sqliteDb.close();
    if (err) {
      console.error('FAILED TO COMMIT TRANSACTION:', err.message);
    } else {
      console.log('='.repeat(80));
      console.log(`DATABASE POPULATION SUCCESSFUL!`);
      console.log(`Imported total of ${totalCount} records into cutoffs.db!`);
      console.log('='.repeat(80));
    }
  });
});
