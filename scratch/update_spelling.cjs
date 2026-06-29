const fs = require('fs');
const path = require('path');

const directories = [
  path.join(__dirname, '../student'),
  path.join(__dirname, '../admin'),
  path.join(__dirname, '..')
];

const filesToUpdate = [];

function scanDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== 'scratch' && file !== 'sankalp-evaluator-api') {
        scanDir(fullPath);
      }
    } else if (file.endsWith('.html') || file.endsWith('.js') || file.endsWith('.cjs')) {
      filesToUpdate.push(fullPath);
    }
  }
}

directories.forEach(scanDir);

filesToUpdate.forEach(filePath => {
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  // Replace counseling.html with counselling.html
  if (content.includes('counseling.html')) {
    content = content.replace(/counseling\.html/g, 'counselling.html');
    changed = true;
  }

  // Replace 1-on-1 Counseling with 1-on-1 Counselling
  if (content.includes('1-on-1 Counseling')) {
    content = content.replace(/1-on-1\s+Counseling/g, '1-on-1 Counselling');
    changed = true;
  }
  if (content.includes('1-on-1 counseling')) {
    content = content.replace(/1-on-1\s+counseling/g, '1-on-1 counselling');
    changed = true;
  }

  // Replace other user-facing "counseling" with "counselling"
  if (content.includes('Counseling')) {
    content = content.replace(/Counseling/g, 'Counselling');
    changed = true;
  }
  if (content.includes('counseling')) {
    content = content.replace(/counseling/g, 'counselling');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated: ${filePath}`);
  }
});
