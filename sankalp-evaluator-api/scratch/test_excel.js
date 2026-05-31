const fs = require('fs');
const XLSX = require('xlsx');
const path = require('path');

const file2024 = "C:\\Users\\rahul\\Downloads\\wbjee 2024 latest.xlsx";
const file2025 = "C:\\Users\\rahul\\Downloads\\wbjee 2025 latest.xlsx";

function checkFile(filePath) {
  console.log(`Checking file: ${filePath}`);
  if (!fs.existsSync(filePath)) {
    console.log(`File does NOT exist!`);
    return;
  }
  const stats = fs.statSync(filePath);
  console.log(`Size: ${stats.size} bytes`);
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet);
    console.log(`Found ${rows.length} rows`);
    if (rows.length > 0) {
      console.log(`First row keys:`, Object.keys(rows[0]));
      console.log(`First row values:`, rows[0]);
    }
  } catch (err) {
    console.error(`Error reading file:`, err);
  }
  console.log('-----------------------------------');
}

checkFile(file2024);
checkFile(file2025);
