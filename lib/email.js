// lib/email.js
//
// Reusable, server-side-only email helper built on Resend
// (https://resend.com). Used by api/submit-campaign.js (submission
// received) and api/admin/campaigns.js (approved / rejected), and
// nowhere else — this file is never imported by, or bundled into,
// anything that ships to the browser.
//
// SECURITY: process.env.RESEND_API_KEY only ever lives here, read at
// call time from the server's environment. It is never returned in any
// API response, never logged, and never passed to the client in any
// form.
//
// FAILURE HANDLING: every exported send*Email() function swallows its
// own errors and always resolves — it never throws. A Resend outage, a
// missing/invalid API key, or a malformed email address must NEVER turn
// an otherwise-successful campaign submission, approval, or rejection
// into a failed one. Callers can inspect the returned
// { ok, skipped, error } to log a warning, but are never required to
// (and never need to) wrap these calls in their own try/catch for that
// reason — the try/catch already lives in here.

import { Resend } from 'resend';

// ---------------------------------------------------------------------
// Configuration — read lazily (inside functions, not at module load
// time) so that a missing RESEND_API_KEY at import time can never crash
// a serverless function's cold start; it just means email sending is a
// documented, self-explaining no-op until the env var is set.
// ---------------------------------------------------------------------

function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

// Configurable sender address. Falls back to Resend's own shared
// "onboarding@resend.dev" sender, which works out of the box with no
// domain verification — the exact same email-sending code below works
// unchanged once a verified custom domain/address is put here instead.
function getFromAddress() {
  return process.env.RESEND_FROM_EMAIL || 'Lucy Fundraiser <onboarding@resend.dev>';
}

// The deployed site's base URL, used to build absolute links inside
// emails (a relative link like "/track.html?token=..." doesn't mean
// anything inside an email client). Never trust a client-provided
// origin/host for this — always the server's own known, configured
// site URL, with the real production URL as a safe fallback.
function getSiteUrl() {
  const raw = process.env.SITE_URL || 'https://fundraiser-bice.vercel.app/';
  return raw.replace(/\/+$/, ''); // strip trailing slash(es) for clean concatenation
}

function buildTrackingUrl(trackingToken) {
  return `${getSiteUrl()}/track.html?token=${encodeURIComponent(trackingToken)}`;
}

function buildPublicCampaignUrl(slug) {
  return `${getSiteUrl()}/campaign.html?slug=${encodeURIComponent(slug)}`;
}

// Deliberately simple, conservative email validation — good enough to
// avoid wasting a send attempt on an obviously-malformed address (e.g.
// a typo with no "@"), without trying to be a full RFC 5322 validator.
function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------
// Shared email layout — clean, mobile-friendly, table-based HTML (the
// only layout approach that renders reliably across real-world email
// clients, many of which still don't support modern CSS). Matches the
// site's own pink branding (#ff2e88).
// ---------------------------------------------------------------------

function wrapEmailHtml({ heading, bodyHtml, buttonLabel, buttonUrl, plainUrlLabel, plainUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0; padding:0; background-color:#f6f7fb; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f6f7fb; padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background-color:#ffffff; border-radius:16px; overflow:hidden;">
          <tr>
            <td style="background-color:#ff2e88; padding:22px 24px; text-align:center;">
              <span style="color:#ffffff; font-size:1.15rem; font-weight:700;">Lucy Fundraiser</span>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 24px 8px;">
              <h1 style="margin:0 0 14px; font-size:1.2rem; color:#1f2937;">${escapeHtml(heading)}</h1>
              <div style="font-size:0.95rem; line-height:1.6; color:#1f2937;">
                ${bodyHtml}
              </div>
            </td>
          </tr>
          ${
            buttonUrl
              ? `<tr>
            <td style="padding:8px 24px 4px;" align="center">
              <a href="${buttonUrl}" style="display:inline-block; width:100%; max-width:320px; box-sizing:border-box; background-color:#ff2e88; color:#ffffff; text-decoration:none; font-weight:700; font-size:0.95rem; padding:14px; border-radius:12px; text-align:center;">${escapeHtml(buttonLabel)}</a>
            </td>
          </tr>`
              : ''
          }
          ${
            plainUrl
              ? `<tr>
            <td style="padding:14px 24px 28px;">
              <p style="margin:0 0 4px; font-size:0.8rem; color:#6b7280;">${escapeHtml(plainUrlLabel)}</p>
              <p style="margin:0; font-size:0.82rem; color:#374151; word-break:break-all; background-color:#f9fafb; border-radius:8px; padding:10px 12px;">${escapeHtml(plainUrl)}</p>
            </td>
          </tr>`
              : `<tr><td style="padding:0 24px 28px;"></td></tr>`
          }
        </table>
        <p style="max-width:480px; margin:16px 0 0; font-size:0.72rem; color:#9ca3af; text-align:center;">
          This is an automated message from Lucy Fundraiser. Please do not reply directly to this email.
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// Every send*Email() function below shares this same safe-call
// wrapper: build the message, try to send it, never throw, always log
// enough server-side detail (via console.error) to debug a failure
// without ever surfacing Resend/API internals to any HTTP response.
async function sendEmail({ to, subject, html, logLabel }) {
  if (!isValidEmail(to)) {
    console.warn(`[email:${logLabel}] Skipped — no valid recipient email address.`);
    return { ok: false, skipped: true };
  }

  const resend = getResendClient();
  if (!resend) {
    console.warn(
      `[email:${logLabel}] Skipped — RESEND_API_KEY is not configured. ` +
        `Set it in your environment variables to enable email notifications.`
    );
    return { ok: false, skipped: true };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: getFromAddress(),
      to,
      subject,
      html,
    });

    if (error) {
      console.error(`[email:${logLabel}] Resend returned an error:`, error);
      return { ok: false, error };
    }

    return { ok: true, id: data?.id };
  } catch (err) {
    // Network failure, Resend outage, malformed request, etc. — never
    // let this propagate up and break the caller's own success path.
    console.error(`[email:${logLabel}] Failed to send:`, err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
}

// =========================================================================
// EMAIL 1 — Submission received (sent by api/submit-campaign.js right
// after a new 'pending' campaign is successfully created)
// =========================================================================
export async function sendSubmissionReceivedEmail({ to, submitterName, patientName, trackingToken }) {
  const trackingUrl = buildTrackingUrl(trackingToken);
  const greetingName = submitterName ? escapeHtml(submitterName) : 'there';

  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${greetingName},</p>
    <p style="margin:0 0 14px;">
      Thank you for submitting a fundraiser for <strong>${escapeHtml(patientName)}</strong>.
      We've received it and it is now <strong>under review</strong> by our team.
    </p>
    <p style="margin:0 0 14px;">
      You can check the status of your submission at any time using your own
      private tracking link below — no account or login needed.
    </p>
  `;

  return sendEmail({
    to,
    subject: 'Your Fundraiser Submission Has Been Received',
    html: wrapEmailHtml({
      heading: 'Submission Received',
      bodyHtml,
      buttonLabel: 'Track Your Submission',
      buttonUrl: trackingUrl,
      plainUrlLabel: "If the button above doesn't work, copy and paste this link into your browser:",
      plainUrl: trackingUrl,
    }),
    logLabel: 'submission-received',
  });
}

// =========================================================================
// EMAIL 2 — Campaign approved (sent by api/admin/campaigns.js when a
// campaign's status transitions to 'active')
// =========================================================================
export async function sendCampaignApprovedEmail({ to, submitterName, patientName, slug }) {
  const publicUrl = buildPublicCampaignUrl(slug);
  const greetingName = submitterName ? escapeHtml(submitterName) : 'there';

  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${greetingName},</p>
    <p style="margin:0 0 14px;">
      Great news — the fundraiser for <strong>${escapeHtml(patientName)}</strong> has been
      <strong>approved and is now live</strong>!
    </p>
    <p style="margin:0 0 14px;">
      Please share the public campaign link below with family, friends, and
      supporters to help spread the word and reach the fundraising goal.
    </p>
  `;

  return sendEmail({
    to,
    subject: 'Your Fundraiser Has Been Approved',
    html: wrapEmailHtml({
      heading: 'Fundraiser Approved 🎉',
      bodyHtml,
      buttonLabel: 'View Public Campaign',
      buttonUrl: publicUrl,
      plainUrlLabel: 'Share this link, or copy and paste it into your browser:',
      plainUrl: publicUrl,
    }),
    logLabel: 'campaign-approved',
  });
}

// =========================================================================
// EMAIL 3 — Campaign rejected (sent by api/admin/campaigns.js when a
// campaign's status transitions to 'rejected')
// =========================================================================
export async function sendCampaignRejectedEmail({ to, submitterName, patientName, trackingToken, rejectionReason }) {
  const trackingUrl = buildTrackingUrl(trackingToken);
  const greetingName = submitterName ? escapeHtml(submitterName) : 'there';
  const reason = (rejectionReason || '').trim() || 'Your submission was not approved at this time.';

  const bodyHtml = `
    <p style="margin:0 0 14px;">Hi ${greetingName},</p>
    <p style="margin:0 0 14px;">
      We've reviewed the fundraiser submission for <strong>${escapeHtml(patientName)}</strong>,
      and unfortunately it was <strong>not approved</strong>.
    </p>
    <p style="margin:0 0 4px; font-size:0.85rem; color:#6b7280;">Reason given:</p>
    <p style="margin:0 0 14px; background-color:#fef2f2; color:#7f1d1d; border-radius:8px; padding:10px 12px; font-size:0.9rem;">
      ${escapeHtml(reason)}
    </p>
    <p style="margin:0 0 14px;">
      You can check your submission's status at any time using your private
      tracking link below.
    </p>
  `;

  return sendEmail({
    to,
    subject: 'Update on Your Fundraiser Submission',
    html: wrapEmailHtml({
      heading: 'Submission Update',
      bodyHtml,
      buttonLabel: 'Track Your Submission',
      buttonUrl: trackingUrl,
      plainUrlLabel: "If the button above doesn't work, copy and paste this link into your browser:",
      plainUrl: trackingUrl,
    }),
    logLabel: 'campaign-rejected',
  });
}

export default {
  sendSubmissionReceivedEmail,
  sendCampaignApprovedEmail,
  sendCampaignRejectedEmail,
};
