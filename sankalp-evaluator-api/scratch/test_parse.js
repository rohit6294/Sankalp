const fs = require('fs');
const XLSX = require('xlsx');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { classifyCollegeType } = require('../src/college-types');

const file2024 = "C:\\Users\\rahul\\Downloads\\wbjee 2024 latest.xlsx";
const file2025 = "C:\\Users\\rahul\\Downloads\\wbjee 2025 latest.xlsx";

function testParseAndInsert(filePath, year) {
  console.log(`\n=================== Testing Year ${year} ===================`);
  if (!fs.existsSync(filePath)) {
    console.error(`File ${filePath} does not exist.`);
    return;
  }
  
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet);
    
    console.log(`Parsed workbook. Rows: ${rawRows.length}`);
    if (!rawRows || !rawRows.length) {
      console.error("Empty sheet!");
      return;
    }

    // Connect to in-memory/temp SQLite database to test SQL
    const dbPath = path.join(__dirname, 'test_cutoffs.db');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const sqliteDb = new sqlite3.Database(dbPath);

    // Create table
    sqliteDb.serialize(() => {
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

      const firstRow = rawRows[0];
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

      function findValue(row, subStrKeywords, defaultVal = '') {
        const foundKey = Object.keys(row).find(k => {
          const kLower = k.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, '');
          return subStrKeywords.some(kw => kLower.includes(kw.toLowerCase().replace(/\s+/g, '')));
        });
        return foundKey !== undefined ? row[foundKey] : defaultVal;
      }

      const cleanedRecords = [];

      mappedRows.forEach((row) => {
        const institute = String(findValue(row, ['institute', 'college', 'school', 'inst'], '')).trim();
        const program = String(findValue(row, ['program', 'branch', 'course', 'prog'], '')).trim();
        
        if (!institute || !program) return; 

        const category = String(findValue(row, ['category', 'caste', 'reservation'], 'Open')).trim();
        const opening_rank = parseInt(findValue(row, ['opening', 'op'], 0), 10) || 0;
        const closing_rank = parseInt(findValue(row, ['closing', 'cl'], 0), 10) || 0;

        if (closing_rank <= 0) return; 

        let roundVal = findValue(row, ['round', 'phase'], '');
        let roundNum = 2;
        if (roundVal) {
          const match = String(roundVal).match(/\d+/);
          if (match) roundNum = parseInt(match[0], 10);
        }

        let stream = String(findValue(row, ['stream', 'degree'], '')).trim();
        if (!stream) {
          const isPharm = program.toLowerCase().includes('pharma') || program.toLowerCase().includes('pharmacy');
          stream = isPharm 
            ? 'B.Pharm' 
            : 'B.E/B.Tech (WBJEE/JEE(Main) Seats)/B.Arch (WBJEE Seats)';
        }

        const seat_type = String(findValue(row, ['seat_type', 'seat type', 'type'], 'WBJEE Seats')).trim();
        const quota = String(findValue(row, ['quota', 'state'], 'Home State')).trim();

        let college_type = String(findValue(row, ['college_type', 'college type', 'institute_type', 'institute type'], '')).trim();
        if (!college_type) {
          college_type = classifyCollegeType(institute, program);
        }

        cleanedRecords.push({
          year,
          round: roundNum,
          institute,
          program,
          category,
          opening_rank: opening_rank || closing_rank,
          closing_rank,
          stream,
          seat_type,
          quota,
          college_type
        });
      });

      console.log(`Cleaned rows to insert: ${cleanedRecords.length}`);

      sqliteDb.run('BEGIN TRANSACTION');

      const insertStmt = sqliteDb.prepare(`
        INSERT INTO cutoffs (year, round, institute, program, category, opening_rank, closing_rank, stream, seat_type, quota, college_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      cleanedRecords.forEach(rec => {
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

      insertStmt.finalize();

      sqliteDb.run('COMMIT', (err) => {
        if (err) {
          console.error(`COMMIT Error:`, err);
        } else {
          console.log(`COMMIT Success! Imported ${cleanedRecords.length} records successfully.`);
        }
        sqliteDb.close();
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      });
    });

  } catch (err) {
    console.error(`Error during processing ${year}:`, err);
  }
}

testParseAndInsert(file2024, 2024);
testParseAndInsert(file2025, 2025);
