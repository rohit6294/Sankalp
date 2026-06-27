import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const rootDir = path.join(__dirname, '..');

function getHtmlFiles(dir, filesList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const name = path.join(dir, file);
    if (fs.statSync(name).isDirectory()) {
      if (file !== 'node_modules' && file !== '.git' && file !== '.firebase') {
        getHtmlFiles(name, filesList);
      }
    } else if (file.endsWith('.html')) {
      filesList.push(name);
    }
  }
  return filesList;
}

const htmlFiles = getHtmlFiles(rootDir);
console.log(`Found ${htmlFiles.length} HTML files to validate.`);

let hasErrors = false;

for (const file of htmlFiles) {
  const relativePath = path.relative(rootDir, file);
  const html = fs.readFileSync(file, 'utf8');
  
  // Find all <script> blocks and parse their opening tag as well to check type/src
  const scriptRegex = /(<script\b[^>]*>)([\s\S]*?)<\/script>/gi;
  let match;
  let blockIndex = 1;
  
  while ((match = scriptRegex.exec(html)) !== null) {
    const openingTag = match[1];
    const scriptContent = match[2];
    
    // Skip if it is an external script with src
    if (openingTag.includes('src=')) {
      continue;
    }
    
    // Skip if it is not JavaScript (e.g., application/ld+json)
    if (openingTag.includes('type="application/ld+json"') || 
        openingTag.includes('type=\'application/ld+json\'') ||
        openingTag.includes('type="importmap"')) {
      console.log(`Skipping non-JS script block in ${relativePath}`);
      continue;
    }
    
    try {
      new vm.Script(scriptContent, { filename: `${relativePath}#script-${blockIndex}` });
    } catch (e) {
      console.error(`\n❌ Syntax Error in ${relativePath} (Block ${blockIndex}):`, e.message);
      console.error(e.stack);
      hasErrors = true;
    }
    blockIndex++;
  }
}

if (hasErrors) {
  console.log('\n❌ Validation FAILED.');
  process.exit(1);
} else {
  console.log('\n✅ All HTML inline scripts are syntactically valid!');
}
