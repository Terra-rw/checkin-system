import nodemailer from 'nodemailer';

const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true', // true for port 465
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    })
  : null;

if (!transporter) {
  console.warn('[email] SMTP_HOST not set: emails will be printed to the console instead of sent.');
}

/**
 * Sends an email. Never throws: a mail failure must not block a check-in.
 * Returns true when the message was handed to the SMTP server.
 */
export async function sendMail({ to, subject, text }) {
  const recipients = [...new Set(to.map((e) => e && e.trim()).filter(Boolean))];
  if (recipients.length === 0) return false;

  if (!transporter) {
    console.log(`\n[email:console] To: ${recipients.join(', ')}\nSubject: ${subject}\n\n${text}\n`);
    return false;
  }

  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: recipients.join(', '),
      subject,
      text,
    });
    return true;
  } catch (err) {
    console.error('[email] Failed to send:', err.message);
    return false;
  }
}

export const smtpConfigured = Boolean(transporter);

export function alertRecipients(settings) {
  return String(settings.alertEmails || '')
    .split(/[,;\s]+/)
    .filter(Boolean);
}
