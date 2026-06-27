const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const predictorPath = 'c:\\Users\\rahul\\Desktop\\sankalp\\Sankalp\\student\\predictor.html';
const tempHtmlPath = 'c:\\Users\\rahul\\Desktop\\sankalp\\Sankalp\\student\\test-predictor-headless.html';

console.log('Starting automated headless browser test...');

if (!fs.existsSync(predictorPath)) {
  console.error('Predictor HTML file not found at:', predictorPath);
  process.exit(1);
}

// 1. Read predictor.html
let html = fs.readFileSync(predictorPath, 'utf8');

// 2. Inject Mock Firebase Auth & Firestore by replacing real Firebase/Config/Profile scripts
const mockScript = `
<script>
  // Complete Mock of Firebase and related scripts for headless testing
  const mockUser = {
    uid: 'headless-test-student-uid',
    displayName: 'Headless Test Student',
    email: 'test@sankalp.com',
    getIdToken: () => Promise.resolve('mock-id-token')
  };
  
  const mockAuth = {
    onAuthStateChanged: function(callback) {
      console.log("Headless Mock: auth.onAuthStateChanged registering callback...");
      setTimeout(() => {
        console.log("Headless Mock: auth.onAuthStateChanged triggering user...");
        callback(mockUser);
      }, 100);
    },
    signOut: () => Promise.resolve()
  };
  
  const mockDb = {
    collection: function(name) {
      return {
        doc: function(id) {
          return {
            get: function() {
              return Promise.resolve({
                exists: true,
                data: () => {
                  if (name === 'settings' && id === 'college_predictor') {
                    return { enabled: true };
                  }
                  if (name === 'settings' && id === 'mandatory_fields') {
                    return { caste: true };
                  }
                  return { caste: 'Open', role: 'student', name: 'Headless Test Student' };
                }
              });
            }
          };
        }
      };
    }
  };

  window.firebase = {
    initializeApp: () => ({}),
    auth: () => mockAuth,
    firestore: () => mockDb
  };

  window.auth = mockAuth;
  window.db = mockDb;
  
  var auth = mockAuth;
  var db = mockDb;
  
  window.EVALUATOR_API = 'https://sankalp-1vt4.onrender.com';

  // Intercept window.fetch to mock all evaluator API endpoints locally
  const originalFetch = window.fetch;
  window.fetch = async function(url, options) {
    const urlStr = String(url);
    console.log("Headless Mock Fetch:", urlStr);
    
    if (urlStr.includes('/api/predictor/status')) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          enabled: true,
          requiresPayment: false,
          price: 299,
          hasAccess: true
        })
      };
    }
    if (urlStr.includes('/api/predictor/categories')) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          categories: [
            'EWS',
            'OBC - A',
            'OBC - A (PwD)',
            'OBC - B',
            'OBC - B (PwD)',
            'Open',
            'Open (PwD)',
            'SC',
            'SC (PwD)',
            'ST',
            'Tuition Fee Waiver'
          ]
        })
      };
    }
    if (urlStr.includes('/api/predictor/seat-types')) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          seatTypes: [ 'JEE(Main) Seats', 'WBJEE Seats' ]
        })
      };
    }
    if (urlStr.includes('/api/predictor/quotas')) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          quotas: [ 'All India', 'Home State' ]
        })
      };
    }
    if (urlStr.includes('/api/predictor/years')) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          years: [ '2024-MopUp', 2025, 2024, 2023, 2022, 2021 ]
        })
      };
    }
    if (urlStr.includes('/api/choice-filling/status')) {
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          enabled: true,
          requiresPayment: false,
          price: 399,
          hasAccess: true
        })
      };
    }
    
    return originalFetch.apply(this, arguments);
  };
</script>
`;

const firebaseScriptsRegex = /<script src="https:\/\/www\.gstatic\.com\/firebasejs\/[\s\S]*?<script src="\.\.\/js\/profile-check\.js"><\/script>/i;

if (!firebaseScriptsRegex.test(html)) {
  console.error('Could not find the Firebase/config script tags in predictor.html!');
  process.exit(1);
}

html = html.replace(firebaseScriptsRegex, mockScript);

// 3. Write to temporary file
fs.writeFileSync(tempHtmlPath, html, 'utf8');
console.log('Created temporary test file with Firebase mocks.');

// 4. Locate Microsoft Edge executable on Windows
const edgePaths = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];

let edgePath = null;
for (const p of edgePaths) {
  if (fs.existsSync(p)) {
    edgePath = p;
    break;
  }
}

if (!edgePath) {
  console.error('Microsoft Edge executable not found. Deleting temp file and aborting.');
  try { fs.unlinkSync(tempHtmlPath); } catch (e) {}
  process.exit(1);
}

console.log('Found Edge executable at:', edgePath);
console.log('Launching Edge in headless mode to run Javascript and dump DOM...');

// 5. Run headless browser and dump DOM
// We wait 4000ms inside the page to ensure the Render API request resolves and populates the dropdown
const fileUrl = `file:///${tempHtmlPath.replace(/\\/g, '/')}`;
const command = `"${edgePath}" --headless --disable-gpu --dump-dom "${fileUrl}"`;

exec(command, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
  // Always clean up the temporary file first
  try {
    fs.unlinkSync(tempHtmlPath);
    console.log('Temporary test file cleaned up.');
  } catch (e) {
    console.warn('Failed to delete temporary file:', e.message);
  }

  if (err) {
    console.error('Failed to run headless browser:', err);
    process.exit(1);
  }

  // Helper to save DOM on failure
  const saveFailedDom = () => {
    const dumpPath = path.join(__dirname, 'failed_dom_dump.html');
    fs.writeFileSync(dumpPath, stdout, 'utf8');
    console.log('Saved failed DOM dump to:', dumpPath);
  };

  // 6. Inspect stdout DOM for the populated categories
  console.log('\n--- Analyzing Dumped DOM ---');
  
  const selectMatch = stdout.match(/<select id="inpCategory"[\s\S]*?<\/select>/i);
  if (!selectMatch) {
    console.error('Could not find select element #inpCategory in dumped DOM!');
    saveFailedDom();
    process.exit(1);
  }

  const selectHtml = selectMatch[0];
  console.log('Category dropdown HTML in dumped DOM:');
  console.log(selectHtml);

  // Check if it contains the real categories from the database (e.g. SC, ST, OBC - A, Open)
  const hasSC = selectHtml.includes('value="SC"');
  const hasOpen = selectHtml.includes('value="Open"');
  const hasOBC = selectHtml.includes('value="OBC - A"');
  const isStillLoading = selectHtml.includes('Loading categories...');

  console.log('\n--- Verification Checklist ---');
  console.log(`Dropdown contains 'Open' option: ${hasOpen ? 'PASS' : 'FAIL'}`);
  console.log(`Dropdown contains 'SC' option: ${hasSC ? 'PASS' : 'FAIL'}`);
  console.log(`Dropdown contains 'OBC - A' option: ${hasOBC ? 'PASS' : 'FAIL'}`);
  console.log(`Dropdown is NOT stuck on loading: ${!isStillLoading ? 'PASS' : 'FAIL'}`);

  if (hasOpen && hasSC && hasOBC && !isStillLoading) {
    console.log('\n🎉 SUCCESS! Headless browser test PASSED! The page compiles, runs, fetches from the live API, and populates the category dropdown successfully!');
  } else {
    console.error('\n❌ FAILURE! The dropdown was not populated correctly.');
    saveFailedDom();
    process.exit(1);
  }
});
