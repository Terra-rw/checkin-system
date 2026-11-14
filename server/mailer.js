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

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** HTML version of a plain-text email, with the institution's logo and name on top. */
function brandedHtml(brand, text) {
  const base = (process.env.APP_URL || '').replace(/\/+$/, '');
  const logo =
    brand.logo_file && base
      ? `<img src="${escapeHtml(`${base}/media/${brand.logo_file}`)}" width="36" height="36" alt="" style="display:block;border:0;width:36px;height:36px;object-fit:contain">`
      : '';
  const body = escapeHtml(text.trim()).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#0f766e;word-break:break-all">$1</a>');
  return `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#eef1f4;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#17202a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #d5dbe1;border-radius:12px">
<tr><td style="padding:16px 22px;border-bottom:3px solid #0f766e">
<table role="presentation" cellpadding="0" cellspacing="0"><tr>
${logo ? `<td style="padding-right:12px">${logo}</td>` : ''}
<td style="font-size:16px;font-weight:700">${escapeHtml(brand.name)}<div style="font-size:12px;font-weight:400;color:#4b5563">Check-in</div></td>
</tr></table></td></tr>
<tr><td style="padding:20px 22px;font-size:15px;line-height:1.55;white-space:pre-wrap">${body}</td></tr>
</table></body></html>`;
}

/**
 * Sends an email. Never throws: a mail failure must not block a check-in.
 * `brand` is the institution row: its name becomes the sender name and its logo heads the HTML version.
 * Returns { sent: true } when the SMTP server accepted it, otherwise { sent: false, error }.
 */
export async function sendMail({ to, subject, text, brand, fromName = brand?.name, attachments }) {
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
      html: brand ? brandedHtml(brand, text) : undefined,
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
