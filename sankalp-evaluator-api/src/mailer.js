require('dotenv').config();
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
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
      from: `"Sankalp Learning" <${process.env.SMTP_EMAIL}>`,
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
