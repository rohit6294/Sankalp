const http = require('https');

const url = 'https://sankalp-1vt4.onrender.com/api/debug-routes';

function check() {
  console.log(`[${new Date().toLocaleTimeString()}] Checking live routes...`);
  http.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        if (json.routes) {
          console.log(`Routes loaded: ${json.routes.length} endpoints active.`);
          const studentsRoute = json.routes.find(r => r.includes('GET /api/admin/students'));
          if (studentsRoute) {
            console.log('\n🎉 SUCCESS! GET /api/admin/students is FULLY LIVE on Render!');
            process.exit(0);
          } else {
            console.log('Wait... /api/admin/students route not found in active routes yet. Deployed version might be older.');
          }
        } else {
          console.log('Endpoint returned non-route data:', data.slice(0, 100));
        }
      } catch (err) {
        console.log(`Cannot parse JSON yet. Render is probably rebuilding/restarting...`);
      }
    });
  }).on('error', (err) => {
    console.log(`Connection error: ${err.message}. Render is likely building or offline...`);
  });
}

// Check every 10 seconds
check();
const interval = setInterval(check, 10000);

// Stop after 5 minutes
setTimeout(() => {
  clearInterval(interval);
  console.log('Timeout. Deploy is taking longer than 5 minutes.');
  process.exit(1);
}, 300000);
