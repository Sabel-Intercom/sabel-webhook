// api/quote-notify.js
// Vercel serverless endpoint: receives a Migr8Now calculator quote and emails
// the job details to Sabel via Resend. No personal data is captured — only the
// parameters of the calculation.
//
// Environment variables required (set in Vercel project settings):
//   RESEND_API_KEY   - your Resend API key
//   NOTIFY_TO        - the address to send notifications to (e.g. richard@sabelcustomersuccess.com)
//   NOTIFY_FROM      - a verified Resend sender (e.g. info@sabelcustomersuccess.com)

export default async function handler(req, res) {
  // CORS: allow only the Sabel GitHub Pages site to POST here.
  // Origins are scheme + host only (no path), so the calculator at
  // /Intake-forms/... is covered by this host.
  res.setHeader('Access-Control-Allow-Origin', 'https://sabel-intercom.github.io');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Parse body (Vercel parses JSON automatically when Content-Type is set,
  // but guard for string bodies just in case).
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const {
    ticketVolume,
    sourcePlatform,
    deliveryModel,
    priceUSD,
    conversions  // { AUD, GBP, EUR } strings, optional
  } = body;

  // Basic validation
  if (ticketVolume === undefined || priceUSD === undefined) {
    return res.status(400).json({ error: 'Missing ticketVolume or priceUSD' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const NOTIFY_TO = process.env.NOTIFY_TO || 'richard@sabelcustomersuccess.com';
  const NOTIFY_FROM = process.env.NOTIFY_FROM || 'info@sabelcustomersuccess.com';

  if (!RESEND_API_KEY) {
    return res.status(500).json({ error: 'Email service not configured' });
  }

  // Build a tidy plain-text + HTML email
  const when = new Date().toISOString().replace('T', ' ').replace(/\..+/, '') + ' UTC';
  const volStr = Number(ticketVolume).toLocaleString('en-US');
  const fx = conversions || {};

  const subject = `Migr8Now quote run: ${volStr} tickets · ${priceUSD}`;

  const textLines = [
    'A Migr8Now price was calculated.',
    '',
    `Ticket volume:    ${volStr}`,
    `Source platform:  ${sourcePlatform || 'n/a'}`,
    `Delivery model:   ${deliveryModel || 'n/a'}`,
    `Price (USD):      ${priceUSD}`,
    fx.AUD ? `  AUD (est.):     ${fx.AUD}` : null,
    fx.GBP ? `  GBP (est.):     ${fx.GBP}` : null,
    fx.EUR ? `  EUR (est.):     ${fx.EUR}` : null,
    '',
    `Calculated at:    ${when}`,
  ].filter(Boolean);

  const text = textLines.join('\n');

  const html = `
    <div style="font-family: -apple-system, Helvetica, Arial, sans-serif; color: #111; max-width: 520px;">
      <h2 style="margin: 0 0 4px; font-size: 18px;">Migr8Now quote run</h2>
      <p style="margin: 0 0 16px; color: #666; font-size: 13px;">A price was calculated on the rate calculator.</p>
      <table style="border-collapse: collapse; font-size: 14px; width: 100%;">
        <tr><td style="padding: 6px 0; color: #666;">Ticket volume</td><td style="padding: 6px 0; font-weight: 600; text-align: right;">${volStr}</td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Source platform</td><td style="padding: 6px 0; font-weight: 600; text-align: right;">${sourcePlatform || 'n/a'}</td></tr>
        <tr><td style="padding: 6px 0; color: #666;">Delivery model</td><td style="padding: 6px 0; font-weight: 600; text-align: right;">${deliveryModel || 'n/a'}</td></tr>
        <tr><td style="padding: 6px 0; color: #666; border-top: 1px solid #eee;">Price (USD)</td><td style="padding: 6px 0; font-weight: 700; text-align: right; border-top: 1px solid #eee; font-size: 16px;">${priceUSD}</td></tr>
        ${fx.AUD ? `<tr><td style="padding: 4px 0; color: #999; font-size: 12px;">AUD (est.)</td><td style="padding: 4px 0; text-align: right; color: #999; font-size: 12px;">${fx.AUD}</td></tr>` : ''}
        ${fx.GBP ? `<tr><td style="padding: 4px 0; color: #999; font-size: 12px;">GBP (est.)</td><td style="padding: 4px 0; text-align: right; color: #999; font-size: 12px;">${fx.GBP}</td></tr>` : ''}
        ${fx.EUR ? `<tr><td style="padding: 4px 0; color: #999; font-size: 12px;">EUR (est.)</td><td style="padding: 4px 0; text-align: right; color: #999; font-size: 12px;">${fx.EUR}</td></tr>` : ''}
      </table>
      <p style="margin: 16px 0 0; color: #999; font-size: 12px;">Calculated at ${when}</p>
    </div>
  `;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: `Migr8Now Calculator <${NOTIFY_FROM}>`,
        to: [NOTIFY_TO],
        subject,
        text,
        html
      })
    });

    if (!r.ok) {
      const errText = await r.text();
      return res.status(502).json({ error: 'Email send failed', detail: errText });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: 'Unexpected error', detail: String(err) });
  }
}
