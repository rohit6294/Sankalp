const fs = require('fs');
const path = require('path');

const studentDir = path.join(__dirname, 'student');
const files = fs.readdirSync(studentDir).filter(f => f.endsWith('.html'));

const linkToAdd = `\n    <a href="counselling.html" class="sidebar-link"><i class="fas fa-comments" style="width:18px"></i> 1-on-1 Counselling</a>`;
const activeLinkToAdd = `\n    <a href="counselling.html" class="sidebar-link active"><i class="fas fa-comments" style="width:18px"></i> 1-on-1 Counselling</a>`;
const predictorLink = `<a href="predictor.html" class="sidebar-link"><i class="fas fa-graduation-cap" style="width:18px"></i> College Predictor</a>`;
const predictorActiveLink = `<a href="predictor.html" class="sidebar-link active"><i class="fas fa-graduation-cap" style="width:18px"></i> College Predictor</a>`;

let updatedCount = 0;

for (const file of files) {
  if (file === 'counselling.html') continue; // already has it
  const filePath = path.join(studentDir, file);
  let content = fs.readFileSync(filePath, 'utf8');

  if (content.includes('href="counselling.html" class="sidebar-link')) {
    continue;
  }

  if (content.includes(predictorLink)) {
    content = content.replace(predictorLink, predictorLink + linkToAdd);
    fs.writeFileSync(filePath, content, 'utf8');
    updatedCount++;
    console.log(`Updated ${file}`);
  } else if (content.includes(predictorActiveLink)) {
    content = content.replace(predictorActiveLink, predictorActiveLink + linkToAdd);
    fs.writeFileSync(filePath, content, 'utf8');
    updatedCount++;
    console.log(`Updated ${file} (predictor active)`);
  } else {
    console.log(`Could not find anchor in ${file}`);
  }
}

console.log(`Finished updating ${updatedCount} files.`);
