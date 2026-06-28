const https = require('https');

const data = JSON.stringify({});

const options = {
  hostname: 'sankalp-1vt4.onrender.com',
  port: 443,
  path: '/api/booking/lock-slot',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
};

const req = https.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.on('data', (d) => {
    process.stdout.write(d);
  });
});

req.on('error', (error) => {
  console.error(error);
});

req.write(data);
req.end();
