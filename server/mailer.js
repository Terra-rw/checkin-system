import nodemailer from 'nodemailer';

const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true', // true for port 465
      // On other ports (587, 2525) insist on STARTTLS so the password is never sent unencrypted.
      requireTLS: process.env.SMTP_SECURE !== 'true',
      connectionTimeout: 20000,
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
 * `fromName` shows the institution's name as the sender.
 * Returns { sent: true } when the SMTP server accepted it, otherwise { sent: false, error }.
 */
export async function sendMail({ to, subject, text, fromName, attachments }) {
  const recipients = [...new Set(to.map((e) => e && e.trim()).filter(Boolean))];
  if (recipients.length === 0) {
    console.warn(`[email] Not sent ("${subject}"): no recipients. Add alert emails in Admin > Settings.`);
    return { sent: false, error: 'No recipients.' };
  }

  if (!transporter) {
    const files = attachments?.length ? `\n[attachments: ${attachments.map((a) => a.filename).join(', ')}]` : '';
    console.log(`\n[email:console] To: ${recipients.join(', ')}\nSubject: ${subject}\n\n${text}${files}\n`);
    return { sent: false, error: null };
  }

  const fromAddress = process.env.MAIL_FROM || process.env.SMTP_USER;
  try {
    await transporter.sendMail({
      from: fromName ? { name: `${fromName} · Check-in`, address: extractAddress(fromAddress) } : fromAddress,
      to: recipients.join(', '),
      subject,
      text,
      attachments,
    });
    return { sent: true };
  } catch (err) {
    console.error('[email] Failed to send:', err.message);
    return { sent: false, error: err.message };
  }
}

function extractAddress(from) {
  const match = /<([^>]+)>/.exec(from || '');
  return match ? match[1] : from;
}

export const smtpConfigured = Boolean(transporter);

export function alertRecipients(settings) {
  return String(settings.alertEmails || '')
    .split(/[,;\s]+/)
    .filter(Boolean);
}
