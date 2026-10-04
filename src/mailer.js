import os from 'node:os';
import nodemailer from 'nodemailer';

const recipients = (process.env.ALERT_TO || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const mailEnabled = Boolean(process.env.SMTP_HOST && recipients.length);

const transport = mailEnabled
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    })
  : null;

export async function sendMail(subject, text) {
  if (!transport) throw new Error('Mail is not configured (set SMTP_HOST and ALERT_TO)');
  await transport.sendMail({
    from: process.env.ALERT_FROM || process.env.SMTP_USER || `nodeadmin@${os.hostname()}`,
    to: recipients,
    subject: `[NodeAdmin@${os.hostname()}] ${subject}`,
    text,
  });
}
