const fs = require('fs');
const path = require('path');
const vm = require('vm');

const files = [
  'c:\\Users\\rahul\\Desktop\\sankalp\\Sankalp\\student\\choice-filling.html',
  'c:\\Users\\rahul\\Desktop\\sankalp\\Sankalp\\student\\predictor.html',
  'c:\\Users\\rahul\\Desktop\\sankalp\\Sankalp\\admin\\evaluators.html'
];

files.forEach(filePath => {
  console.log('Checking file:', filePath);
  if (!fs.existsSync(filePath)) {
    console.error('File does not exist');
    return;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  
  // Extract script content
  const scriptRegex = /<script>([\s\S]*?)<\/script>/gi;
  let match;
  let scriptCount = 0;
  
  while ((match = scriptRegex.exec(content)) !== null) {
    scriptCount++;
    const jsCode = match[1];
    try {
      // Compile the JS code to check for syntax errors
      new vm.Script(jsCode);
      console.log(` - Script block #${scriptCount} compiles successfully.`);
    } catch (err) {
      console.error(` - Syntax Error in script block #${scriptCount}:`, err.message);
      // Print context around the error if possible
      if (err.stack) {
        console.error(err.stack);
      }
    }
  }
});
