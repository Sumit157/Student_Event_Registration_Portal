'use strict';

/**
 * services/mailer.js
 * All outbound email for the portal.
 *
 * Two modes, decided by configuration at boot:
 *   * SMTP mode   - SMTP_HOST and SMTP_USER are set. Real messages are sent.
 *   * DEV MODE    - no SMTP configured. Every message is printed to the server
 *                   console inside a clearly delimited block, including the
 *                   clickable verification / reset URL. Nothing external is
 *                   contacted, so this is safe for offline development.
 *
 * The caller never has to know which mode is active - sendMail() behaves the
 * same in both.
 */

const nodemailer = require('nodemailer');
const { env } = require('../config/env');

let transporter = null;

function getTransporter() {
  if (!env.mail.configured) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth: env.mail.user ? { user: env.mail.user, pass: env.mail.pass } : undefined,
    // Do not verify self signed dev certificates.
    tls: env.isProduction ? { rejectUnauthorized: true } : { rejectUnauthorized: false },
  });
  return transporter;
}

/** Escape text for inclusion in an HTML email body. */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wrap plain content in the shared college-branded email shell. */
function layout(title, introHtml, buttonText, buttonUrl, outroText) {
  const button = buttonText && buttonUrl
    ? `<p style="margin:24px 0"><a href="${esc(buttonUrl)}"
        style="background:#1d4ed8;color:#ffffff;padding:12px 22px;border-radius:8px;
               text-decoration:none;display:inline-block;font-weight:600">${esc(buttonText)}</a></p>
       <p style="font-size:12px;color:#64748b;word-break:break-all">If the button does not work, copy and paste this link:<br>${esc(buttonUrl)}</p>`
    : '';

  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0">
      <div style="background:#1d4ed8;padding:20px 28px">
        <h1 style="color:#ffffff;margin:0;font-size:18px">Campus Portal</h1>
        <p style="color:#bfdbfe;margin:4px 0 0;font-size:13px">Student Events &amp; Alumni Network</p>
      </div>
      <div style="padding:28px">
        <h2 style="margin:0 0 12px;font-size:20px;color:#0f172a">${esc(title)}</h2>
        <div style="color:#334155;font-size:15px;line-height:1.6">${introHtml}</div>
        ${button}
        ${outroText ? `<p style="color:#64748b;font-size:13px;margin-top:28px">${esc(outroText)}</p>` : ''}
      </div>
      <div style="padding:16px 28px;background:#f8fafc;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px">
        This is an automated message from your college portal. Please do not reply.
      </div>
    </div>
  </body></html>`;
}

/**
 * Send (or, in dev mode, print) a message.
 * Always resolves - a mail failure must never break the business transaction
 * that triggered it. Failures are logged and reported in the return value.
 *
 * @returns {Promise<{sent:boolean, mode:'smtp'|'dev', error?:string}>}
 */
async function sendMail({ to, subject, text, html }) {
  const safeTo = String(to || '').trim();
  if (!safeTo) {
    return { sent: false, mode: env.mail.devMode ? 'dev' : 'smtp', error: 'No recipient supplied.' };
  }

  if (!env.mail.configured) {
    const bar = '='.repeat(74);
    console.log(`\n${bar}`);
    console.log('[MAIL:DEV MODE] SMTP is not configured - printing message to console.');
    console.log(`To:      ${safeTo}`);
    console.log(`Subject: ${subject}`);
    console.log('-'.repeat(74));
    // The plain text body carries the clickable link for dev convenience.
    console.log(text);
    console.log(`${bar}\n`);
    return { sent: true, mode: 'dev' };
  }

  try {
    await getTransporter().sendMail({
      from: env.mail.from,
      to: safeTo,
      subject,
      text,
      html: html || undefined,
    });
    return { sent: true, mode: 'smtp' };
  } catch (error) {
    console.error(`[MAIL] Failed to send "${subject}" to ${safeTo}: ${error.message}`);
    return { sent: false, mode: 'smtp', error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Domain specific messages
// ---------------------------------------------------------------------------

function buildVerificationUrl(token) {
  return `${env.clientOrigin}/verify-email.html?token=${encodeURIComponent(token)}`;
}

function buildResetUrl(token) {
  return `${env.clientOrigin}/reset-password.html?token=${encodeURIComponent(token)}`;
}

async function sendVerificationEmail(user, token) {
  const url = buildVerificationUrl(token);
  return sendMail({
    to: user.email,
    subject: 'Verify your college portal email address',
    text:
      `Hello ${user.name},\n\n` +
      `Please confirm your email address by opening this link (valid for ${env.jwt.refreshExpiresDays === 7 ? 24 : 24} hours):\n\n${url}\n\n` +
      `If you did not create this account you can ignore this message.`,
    html: layout(
      'Confirm your email address',
      `<p>Hello ${esc(user.name)},</p>
       <p>Welcome to the campus portal. Please confirm your email address to activate your account.</p>
       <p style="font-size:13px;color:#64748b">This link expires in 24 hours and can only be used once.</p>`,
      'Verify my email',
      url,
      'If you did not create this account you can safely ignore this message.'
    ),
  });
}

async function sendPasswordResetEmail(user, token) {
  const url = buildResetUrl(token);
  return sendMail({
    to: user.email,
    subject: 'Reset your college portal password',
    text:
      `Hello ${user.name},\n\n` +
      `We received a request to reset your password. Open this link within 30 minutes to choose a new one:\n\n${url}\n\n` +
      `The link is single use. If you did not request this, no action is needed.`,
    html: layout(
      'Reset your password',
      `<p>Hello ${esc(user.name)},</p>
       <p>We received a request to reset the password for your portal account.</p>
       <p style="font-size:13px;color:#64748b">This link expires in 30 minutes and can only be used once.</p>`,
      'Choose a new password',
      url,
      'If you did not request a password reset you can ignore this message.'
    ),
  });
}

async function sendRegistrationConfirmationEmail(user, event, seatsRemaining) {
  return sendMail({
    to: user.email,
    subject: `Registration confirmed: ${event.title}`,
    text:
      `Hello ${user.name},\n\n` +
      `Your place at "${event.title}" is confirmed.\n\n` +
      `Date:   ${new Date(event.event_date).toUTCString()}\n` +
      `Venue:  ${event.venue || 'To be announced'}\n` +
      `Seats remaining: ${seatsRemaining}\n\n` +
      `You can view or cancel it under "My Registrations".`,
    html: layout(
      'Registration confirmed',
      `<p>Hello ${esc(user.name)},</p>
       <p>Your place at <strong>${esc(event.title)}</strong> is confirmed.</p>
       <p><strong>Date:</strong> ${esc(new Date(event.event_date).toUTCString())}<br>
          <strong>Venue:</strong> ${esc(event.venue || 'To be announced')}<br>
          <strong>Seats remaining:</strong> ${esc(String(seatsRemaining))}</p>`,
      'View my registrations',
      `${env.clientOrigin}/my-registrations.html`,
      'You can cancel your place at any time from the My Registrations page.'
    ),
  });
}

async function sendWaitlistEmail(user, event, position) {
  return sendMail({
    to: user.email,
    subject: `Added to the waitlist: ${event.title}`,
    text:
      `Hello ${user.name},\n\n` +
      `"${event.title}" is currently full, so you have been added to the waitlist at position ${position}.\n` +
      `If a place is freed you will be promoted automatically and notified by email.`,
    html: layout(
      'You are on the waitlist',
      `<p>Hello ${esc(user.name)},</p>
       <p><strong>${esc(event.title)}</strong> is currently full, so you have been added to the waitlist.</p>
       <p><strong>Your position:</strong> ${esc(String(position))}</p>
       <p>If a place is freed you will be promoted automatically and notified by email.</p>`,
      'View my registrations',
      `${env.clientOrigin}/my-registrations.html`,
      ''
    ),
  });
}

async function sendWaitlistPromotionEmail(user, event) {
  return sendMail({
    to: user.email,
    subject: `A place opened up: ${event.title}`,
    text:
      `Hello ${user.name},\n\n` +
      `Good news - a place has become available at "${event.title}" and you have been moved from the waitlist to a CONFIRMED place.\n\n` +
      `Date:  ${new Date(event.event_date).toUTCString()}\n` +
      `Venue: ${event.venue || 'To be announced'}`,
    html: layout(
      'You have been promoted from the waitlist',
      `<p>Hello ${esc(user.name)},</p>
       <p>Good news - a place became available at <strong>${esc(event.title)}</strong> and your registration is now <strong>confirmed</strong>.</p>
       <p><strong>Date:</strong> ${esc(new Date(event.event_date).toUTCString())}<br>
          <strong>Venue:</strong> ${esc(event.venue || 'To be announced')}</p>`,
      'View my registrations',
      `${env.clientOrigin}/my-registrations.html`,
      'Please let the organisers know if you can no longer attend so the place can be offered to the next person.'
    ),
  });
}

async function sendCancellationEmail(user, event, reason) {
  return sendMail({
    to: user.email,
    subject: `Registration cancelled: ${event.title}`,
    text:
      `Hello ${user.name},\n\n` +
      `Your registration for "${event.title}" has been cancelled${reason ? ` (${reason})` : ''}.`,
    html: layout(
      'Registration cancelled',
      `<p>Hello ${esc(user.name)},</p>
       <p>Your registration for <strong>${esc(event.title)}</strong> has been cancelled${reason ? ` - ${esc(reason)}` : ''}.</p>`,
      'Browse other events',
      `${env.clientOrigin}/events.html`,
      ''
    ),
  });
}

async function sendBulkEventNotification(recipients, event, subjectSuffix, message) {
  const results = [];
  for (const recipient of recipients) {
    // Sequential with a tiny delay so a bulk send is less likely to trip an
    // SMTP provider's per-minute throttle.
    results.push(await sendMail({
      to: recipient.email,
      subject: `Update about ${event.title}${subjectSuffix ? ` - ${subjectSuffix}` : ''}`,
      text:
        `Hello ${recipient.name},\n\n` +
        `There is an update regarding "${event.title}".\n\n${message}\n\n` +
        `Event date: ${new Date(event.event_date).toUTCString()}`,
      html: layout(
        `Update: ${event.title}`,
        `<p>Hello ${esc(recipient.name)},</p>
         <p>There is an update regarding <strong>${esc(event.title)}</strong>.</p>
         <div style="background:#f8fafc;border-left:4px solid #1d4ed8;padding:12px 16px;border-radius:6px;margin:16px 0">${esc(message)}</div>`,
        'Open the event',
        `${env.clientOrigin}/event-detail.html?id=${event.id}`,
        ''
      ),
    }));
  }
  return results;
}

async function sendAccountStatusEmail(user, status, reason) {
  const approved = status === 'approved';
  return sendMail({
    to: user.email,
    subject: approved
      ? 'Your alumni profile has been approved'
      : 'An update about your alumni application',
    text: approved
      ? `Hello ${user.name},\n\nYour alumni profile has been approved. You now appear in the public alumni directory and can post jobs and connect with other alumni.`
      : `Hello ${user.name},\n\nYour alumni profile was not approved${reason ? `: ${reason}` : ''}. Please contact the alumni cell if you believe this is a mistake.`,
    html: approved
      ? layout('Alumni profile approved',
          `<p>Hello ${esc(user.name)},</p><p>Your alumni profile has been <strong>approved</strong>. You now appear in the public alumni directory and can post jobs and connect with other alumni.</p>`,
          'Open the alumni directory', `${env.clientOrigin}/alumni-directory.html`, '')
      : layout('Alumni application update',
          `<p>Hello ${esc(user.name)},</p><p>Your alumni profile was not approved${reason ? `: ${esc(reason)}` : ''}.</p>`,
          '', '', 'Please contact the alumni cell if you believe this is a mistake.')
  });
}

module.exports = {
  sendMail,
  getTransporter,
  sendVerificationEmail,
  sendPasswordResetEmail,
  sendRegistrationConfirmationEmail,
  sendWaitlistEmail,
  sendWaitlistPromotionEmail,
  sendCancellationEmail,
  sendBulkEventNotification,
  sendAccountStatusEmail,
  buildVerificationUrl,
  buildResetUrl,
};
