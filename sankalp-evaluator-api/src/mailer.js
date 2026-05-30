require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  connectionTimeout: 10000, // 10 seconds
  greetingTimeout: 10000,
  socketTimeout: 10000,
  family: 4, // Force IPv4 lookup to prevent ENETUNREACH IPv6 routing errors on Render
  auth: {
    user: process.env.SMTP_EMAIL,
    pass: process.env.SMTP_PASSWORD
  }
});


/**
 * Sends an email using the configured SMTP transporter.
 * @param {Object} options - Email options { to, subject, text, html }
 */
async function sendEmail(options) {
  try {
    const mailOptions = {
      from: `"Sankalp Aspirant" <${process.env.SMTP_EMAIL}>`,
      ...options
    };
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent: ' + info.response);
    return { success: true };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, error: error.message };
  }
}

module.exports = { sendEmail };
