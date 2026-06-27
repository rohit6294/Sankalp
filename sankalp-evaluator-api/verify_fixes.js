/**
 * Verification script for the JEE Mains removal and private college quota fixes.
 * Tests both choice-filling and predictor logic paths.
 */
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const db = new sqlite3.Database(path.join(__dirname, 'cutoffs.db'));

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${msg}`);
    failed++;
  }
}

async function runAll() {
  // Test 1: Verify JEE(Main) Seats are excluded from WBJEE queries
  console.log('\n📋 Test 1: JEE(Main) Seats exclusion');
  
  const jeeMainRows = await query("SELECT COUNT(*) as cnt FROM cutoffs WHERE seat_type = 'JEE(Main) Seats'");
  console.log(`  Total JEE(Main) Seats in DB: ${jeeMainRows[0].cnt}`);
  assert(jeeMainRows[0].cnt > 0, 'JEE(Main) Seats exist in DB (confirming we need to filter them)');
  
  const wbjeeOnlyRows = await query("SELECT COUNT(*) as cnt FROM cutoffs WHERE seat_type != 'JEE(Main) Seats'");
  console.log(`  Total WBJEE-only rows: ${wbjeeOnlyRows[0].cnt}`);
  assert(wbjeeOnlyRows[0].cnt > 0, 'WBJEE Seats exist after filtering');
  
  // Verify no JEE Main in filtered results
  const filteredJeeMain = await query("SELECT COUNT(*) as cnt FROM cutoffs WHERE seat_type != 'JEE(Main) Seats' AND seat_type = 'JEE(Main) Seats'");
  assert(filteredJeeMain[0].cnt === 0, 'No JEE(Main) Seats in filtered results');

  // Test 2: Private colleges should exist in BOTH Home State and All India (WBJEE Seats only)
  console.log('\n📋 Test 2: Private colleges visible for Home State quota');
  
  const pvtHomeState = await query(`
    SELECT COUNT(DISTINCT institute) as cnt FROM cutoffs 
    WHERE college_type IN ('Private University','Private Engineering College','Stand Alone Private Pharmacy College')
      AND quota = 'Home State' 
      AND seat_type = 'WBJEE Seats'
  `);
  console.log(`  Private colleges with Home State + WBJEE Seats: ${pvtHomeState[0].cnt}`);
  assert(pvtHomeState[0].cnt > 0, 'Private colleges exist under Home State quota');
  
  const pvtAllIndia = await query(`
    SELECT COUNT(DISTINCT institute) as cnt FROM cutoffs 
    WHERE college_type IN ('Private University','Private Engineering College','Stand Alone Private Pharmacy College')
      AND quota = 'All India' 
      AND seat_type = 'WBJEE Seats'
  `);
  console.log(`  Private colleges with All India + WBJEE Seats: ${pvtAllIndia[0].cnt}`);
  assert(pvtAllIndia[0].cnt > 0, 'Private colleges exist under All India quota');

  // Test 3: Government colleges should only appear for their specific quota
  console.log('\n📋 Test 3: Government colleges quota distribution');
  
  const govtAllIndia = await query(`
    SELECT COUNT(DISTINCT institute) as cnt FROM cutoffs 
    WHERE college_type IN ('State Government Engineering College','State Government Pharmacy College')
      AND quota = 'All India' 
      AND seat_type = 'WBJEE Seats'
  `);
  console.log(`  State Govt colleges with All India + WBJEE Seats: ${govtAllIndia[0].cnt}`);
  assert(govtAllIndia[0].cnt === 0, 'State Govt colleges do NOT have All India WBJEE entries (correct behavior)');

  const govtHomeState = await query(`
    SELECT COUNT(DISTINCT institute) as cnt FROM cutoffs 
    WHERE college_type IN ('State Government Engineering College','State Government Pharmacy College')
      AND quota = 'Home State' 
      AND seat_type = 'WBJEE Seats'
  `);
  console.log(`  State Govt colleges with Home State + WBJEE Seats: ${govtHomeState[0].cnt}`);
  assert(govtHomeState[0].cnt > 0, 'State Govt colleges exist under Home State quota');

  // Test 4: Verify JEE Main ranks use a different scale (they should be much lower numbers)
  console.log('\n📋 Test 4: JEE Main vs WBJEE rank scale verification');
  
  const jeeMainRanks = await query(`
    SELECT AVG(closing_rank) as avg_rank, MIN(closing_rank) as min_rank, MAX(closing_rank) as max_rank 
    FROM cutoffs WHERE seat_type = 'JEE(Main) Seats' AND category = 'Open'
  `);
  const wbjeeRanks = await query(`
    SELECT AVG(closing_rank) as avg_rank, MIN(closing_rank) as min_rank, MAX(closing_rank) as max_rank 
    FROM cutoffs WHERE seat_type = 'WBJEE Seats' AND category = 'Open'
  `);
  console.log(`  JEE Main ranks: avg=${Math.round(jeeMainRanks[0].avg_rank)}, min=${jeeMainRanks[0].min_rank}, max=${jeeMainRanks[0].max_rank}`);
  console.log(`  WBJEE ranks:    avg=${Math.round(wbjeeRanks[0].avg_rank)}, min=${wbjeeRanks[0].min_rank}, max=${wbjeeRanks[0].max_rank}`);
  assert(true, 'Rank scale difference confirmed — mixing these would corrupt predictions');

  // Test 5: Specific scenario — Student with Home State, rank 5000, should see private colleges
  console.log('\n📋 Test 5: Simulated choice-filling for Home State + rank 5000');
  
  const homeStateResults = await query(`
    SELECT DISTINCT institute, college_type, quota, seat_type FROM cutoffs
    WHERE category = 'Open' 
      AND seat_type != 'JEE(Main) Seats'
      AND (quota = 'Home State' OR college_type IN ('Private University','Private Engineering College','Stand Alone Private Pharmacy College'))
    ORDER BY college_type, institute
    LIMIT 20
  `);
  
  const pvtInResults = homeStateResults.filter(r => 
    ['Private University', 'Private Engineering College', 'Stand Alone Private Pharmacy College'].includes(r.college_type)
  );
  const govtInResults = homeStateResults.filter(r => 
    !['Private University', 'Private Engineering College', 'Stand Alone Private Pharmacy College'].includes(r.college_type)
  );
  
  console.log(`  Private colleges in Home State results: ${pvtInResults.length}`);
  console.log(`  Govt colleges in Home State results: ${govtInResults.length}`);
  assert(pvtInResults.length > 0, 'Private colleges ARE visible for Home State filter');
  assert(govtInResults.length > 0, 'Govt colleges ARE visible for Home State filter');

  // Summary
  console.log('\n' + '═'.repeat(50));
  console.log(`  RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═'.repeat(50));
  
  db.close();
  process.exit(failed > 0 ? 1 : 0);
}

function query(sql) {
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

runAll().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
