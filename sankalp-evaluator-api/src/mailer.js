require('dotenv').config();
const nodemailer = require('nodemailer');

// Load all configured SMTP accounts
const accounts = [];

// Default account
if (process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
  accounts.push({
    user: process.env.SMTP_EMAIL.trim(),
    pass: process.env.SMTP_PASSWORD.trim()
  });
}

// Additional accounts for rotation (SMTP_EMAIL_1, SMTP_EMAIL_2, etc.)
for (let i = 1; i <= 10; i++) {
  const user = process.env[`SMTP_EMAIL_${i}`];
  const pass = process.env[`SMTP_PASSWORD_${i}`];
  if (user && pass) {
    accounts.push({
      user: user.trim(),
      pass: pass.trim()
    });
  }
}

// In-memory tracker for exhausted accounts (temporary daily ban)
const exhaustedUntil = {};

// Helper to create a nodemailer transporter
function createTransporter(account) {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
    family: 4, // Force IPv4 to prevent connection issues on Render/IPv6
    auth: {
      user: account.user,
      pass: account.pass
    }
  });
}

/**
 * Sends an email using the configured SMTP transporter pool with automatic failover.
 * @param {Object} options - Email options { to, subject, text, html }
 */
async function sendEmail(options) {
  if (accounts.length === 0) {
    console.error('No SMTP accounts configured.');
    return { success: false, error: 'No SMTP accounts configured' };
  }

  const now = Date.now();
  
  // Find the first available (non-exhausted) account
  let accountIndex = -1;
  for (let i = 0; i < accounts.length; i++) {
    const email = accounts[i].user;
    if (!exhaustedUntil[email] || now > exhaustedUntil[email]) {
      accountIndex = i;
      break;
    }
  }

  // If all are exhausted, clear the list (force reset) and try the first one
  if (accountIndex === -1) {
    console.warn('All SMTP accounts marked as exhausted. Resetting exhaustion status.');
    for (const key of Object.keys(exhaustedUntil)) {
      delete exhaustedUntil[key];
    }
    accountIndex = 0;
  }

  // Try sending, rotating to the next account if a daily limit or similar error occurs
  let attempts = 0;
  const maxAttempts = accounts.length;

  while (attempts < maxAttempts) {
    const idx = (accountIndex + attempts) % accounts.length;
    const account = accounts[idx];
    const email = account.user;
    
    console.log(`Attempting to send email via account ${idx + 1}/${accounts.length} (${email})...`);

    try {
      const transporter = createTransporter(account);
      const mailOptions = {
        from: `"Sankalp Aspirant" <${email}>`,
        ...options
      };
      
      const info = await transporter.sendMail(mailOptions);
      console.log(`Email sent successfully via ${email}: ` + info.response);
      return { success: true, sentVia: email };
    } catch (error) {
      console.error(`Error sending email via ${email}:`, error.message);
      
      // Check if error is due to daily sending limits
      const isLimitExceeded = 
        error.message.includes('550 5.4.5') ||
        error.message.toLowerCase().includes('limit') ||
        error.message.toLowerCase().includes('quota') ||
        error.message.toLowerCase().includes('exceeded');
        
      if (isLimitExceeded) {
        console.warn(`Daily limit exceeded for ${email}. Marking as exhausted for 24 hours.`);
        exhaustedUntil[email] = Date.now() + 24 * 60 * 60 * 1000; // block for 24 hours
      } else {
        // For other temporary errors, we might still try the next account
        console.warn(`Temporary error on ${email}. Attempting failover.`);
      }
      
      attempts++;
    }
  }

  return { success: false, error: 'All configured SMTP accounts failed to send email.' };
}

module.exports = { sendEmail };
