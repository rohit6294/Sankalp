const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
require('dotenv').config();

const accounts = [];
if (process.env.SMTP_EMAIL && process.env.SMTP_PASSWORD) {
  accounts.push({
    user: process.env.SMTP_EMAIL.trim(),
    pass: process.env.SMTP_PASSWORD.trim()
  });
}
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

async function fetchEmailsFromAccount(account, index) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: account.user,
      pass: account.pass
    },
    logger: false
  });

  const messages = [];

  try {
    await client.connect();
    
    // Select INBOX
    let lock = await client.getMailboxLock('INBOX');
    try {
      const status = await client.status('INBOX', { messages: true });
      const totalMessages = status.messages;
      
      if (totalMessages > 0) {
        // Fetch last 15 messages (from newest backward)
        const fetchRange = `${Math.max(1, totalMessages - 14)}:${totalMessages}`;
        
        for await (let msg of client.fetch(fetchRange, { source: true, envelope: true })) {
          try {
            const parsed = await simpleParser(msg.source);
            messages.push({
              uid: msg.uid,
              seq: msg.seq,
              accountEmail: account.user,
              accountIndex: index + 1,
              id: `${account.user}_${msg.uid}`,
              from: parsed.from ? parsed.from.text : (msg.envelope.from ? msg.envelope.from.map(f => `${f.name || ''} <${f.address}>`).join(', ') : 'Unknown'),
              to: parsed.to ? parsed.to.text : (msg.envelope.to ? msg.envelope.to.map(t => `${t.name || ''} <${t.address}>`).join(', ') : 'Unknown'),
              subject: parsed.subject || msg.envelope.subject || '(No Subject)',
              date: parsed.date || msg.envelope.date || new Date(),
              text: parsed.text || '',
              html: parsed.html || parsed.textAsHtml || ''
            });
          } catch (parseErr) {
            console.error(`Failed to parse message UID ${msg.uid} on ${account.user}:`, parseErr);
          }
        }
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.error(`IMAP error on account ${account.user}:`, err.message);
  }

  return messages;
}

async function fetchAllIncomingEmails() {
  if (accounts.length === 0) {
    console.error('No IMAP accounts configured.');
    return [];
  }

  const allEmails = [];
  const promises = accounts.map((acc, idx) => fetchEmailsFromAccount(acc, idx));
  const results = await Promise.all(promises);

  for (const res of results) {
    allEmails.push(...res);
  }

  // Sort by date descending (newest first)
  allEmails.sort((a, b) => new Date(b.date) - new Date(a.date));
  return allEmails;
}

module.exports = { fetchAllIncomingEmails, accounts };
