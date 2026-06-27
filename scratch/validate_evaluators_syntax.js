import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const filePath = path.join(__dirname, '..', 'admin', 'evaluators.html');
console.log('Reading file:', filePath);
const html = fs.readFileSync(filePath, 'utf8');

// Find all <script> blocks
const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let blockIndex = 1;
let hasErrors = false;

while ((match = scriptRegex.exec(html)) !== null) {
  const scriptContent = match[1];
  // Skip external scripts with src
  if (match[0].includes('src=')) {
    console.log(`Skipping external script block ${blockIndex}`);
    blockIndex++;
    continue;
  }
  
  console.log(`Validating inline script block ${blockIndex}...`);
  try {
    new vm.Script(scriptContent, { filename: `evaluators.html#script-${blockIndex}` });
    console.log(`Script block ${blockIndex} is syntactically valid.`);
  } catch (e) {
    console.error(`Syntax Error in block ${blockIndex}:`, e.message);
    console.error(e.stack);
    hasErrors = true;
  }
  blockIndex++;
}

if (hasErrors) {
  process.exit(1);
} else {
  console.log('All script blocks are syntactically valid!');
}
