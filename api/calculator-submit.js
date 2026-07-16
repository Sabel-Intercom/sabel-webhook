/**
 * Sabel pricing calculator — submission endpoint
 * 
 * Drop this file into your existing Vercel project at: api/calculator-submit.js
 * Add env var: RESEND_API_KEY (get from https://resend.com/api-keys)
 * Optionally: NOTIFY_EMAIL (defaults to richard@sabelcustomersuccess.com)
 * 
 * The HTML calculator POSTs JSON here. We format it as an email and fire via Resend.
 */

const RESEND_API = 'https://api.resend.com/emails';

// ---------- CORS / preflight ----------
const ALLOWED_ORIGINS = [
  'https://sabelcustomersuccess.com',
  'https://www.sabelcustomersuccess.com',
  'https://pricing.sabelcustomersuccess.com',
  'https://sabel-webhook.vercel.app',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

function setCors(res, origin) {
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ---------- Validation ----------
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function fmtMoney(amount, currency, symbol) {
  const cur = currency || 'USD';
  const sym = symbol || '$';
  const n = Math.round(Number(amount) || 0);
  return sym + n.toLocaleString('en-US') + ' ' + cur;
}

// ---------- Email body ----------
function buildEmailHtml(payload) {
  const {
    contact = {},
    setup = {},
    components = [],
    migration = null,
    retainer = null,
    pricing = {},
    meta = {},
  } = payload;

  const RED = '#E10600';
  const DARK = '#1E293B';
  const BODY = '#334155';
  const MUTED = '#64748B';
  const BG_ALT = '#F8FAFC';
  const BORDER = '#E2E8F0';

  const symbol = pricing.currencySymbol || '$';
  const currency = pricing.currency || 'USD';

  // Component rows
  const compRows = components.map(c => `
    <tr>
      <td style="padding:10px 12px; border-bottom:1px solid ${BORDER};">
        <div style="font-weight:700; color:${DARK};">${escapeHtml(c.name)}</div>
        <div style="font-size:12px; color:${MUTED}; margin-top:2px;">
          ${escapeHtml(c.count)} × ${escapeHtml(c.complexity || '')}
          ${c.hours != null ? ` &nbsp;·&nbsp; ${Number(c.hours).toFixed(1)} hrs` : ''}
        </div>
      </td>
      <td style="padding:10px 12px; border-bottom:1px solid ${BORDER}; text-align:right; font-weight:700; color:${DARK}; white-space:nowrap;">
        ${fmtMoney(c.priceClient, currency, symbol)}
      </td>
    </tr>
  `).join('');

  let migrationRow = '';
  if (migration) {
    migrationRow = `
      <tr>
        <td style="padding:10px 12px; border-bottom:1px solid ${BORDER};">
          <div style="font-weight:700; color:${DARK};">Migration</div>
          <div style="font-size:12px; color:${MUTED}; margin-top:2px;">
            ${Number(migration.ticketVolume || 0).toLocaleString('en-US')} tickets from ${escapeHtml(migration.sourcePlatform)}
            ${migration.surchargeUSD ? ` &nbsp;·&nbsp; surcharge $${Math.round(migration.surchargeUSD).toLocaleString('en-US')} USD` : ''}
          </div>
        </td>
        <td style="padding:10px 12px; border-bottom:1px solid ${BORDER}; text-align:right; font-weight:700; color:${DARK}; white-space:nowrap;">
          ${migration.bespoke ? 'Bespoke quote' : fmtMoney(migration.priceClient, currency, symbol)}
        </td>
      </tr>
    `;
  }

  let retainerBlock = '';
  if (retainer) {
    retainerBlock = `
      <tr>
        <td colspan="2" style="padding:18px 12px 8px;">
          <div style="font-family:'Courier New', monospace; font-size:11px; color:${RED}; letter-spacing:0.08em; border-bottom:2px solid ${RED}; display:inline-block; padding-bottom:4px;">
            ONGOING RETAINER
          </div>
        </td>
      </tr>
      <tr>
        <td style="padding:10px 12px; border-bottom:1px solid ${BORDER};">
          <div style="font-weight:700; color:${DARK};">${escapeHtml(retainer.tierName)}</div>
          <div style="font-size:12px; color:${MUTED}; margin-top:2px;">${retainer.hoursPerMonth} hrs / month, pooled quarterly</div>
        </td>
        <td style="padding:10px 12px; border-bottom:1px solid ${BORDER}; text-align:right; font-weight:700; color:${DARK}; white-space:nowrap;">
          ${fmtMoney(retainer.priceClient, currency, symbol)} / mo
        </td>
      </tr>
      <tr>
        <td style="padding:6px 12px;">
          <div style="font-size:12px; color:${MUTED};">First-quarter commitment</div>
        </td>
        <td style="padding:6px 12px; text-align:right; font-weight:700; color:${MUTED}; font-size:13px; white-space:nowrap;">
          ${fmtMoney((retainer.priceClient || 0) * 3, currency, symbol)}
        </td>
      </tr>
    `;
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0; padding:0; background:#F1F5F9; font-family:-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:${BODY};">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F1F5F9; padding:32px 0;">
    <tr><td align="center">
      <table width="640" cellpadding="0" cellspacing="0" style="background:#FFFFFF; border-radius:8px; box-shadow:0 1px 3px rgba(0,0,0,0.06); overflow:hidden;">

        <!-- Header strip -->
        <tr>
          <td style="background:#0B0B0C; padding:24px 32px;">
            <div style="font-family:'Courier New', monospace; font-size:11px; letter-spacing:0.14em; color:${RED};">SABEL CUSTOMER SUCCESS</div>
            <div style="color:#FFFFFF; font-size:22px; font-weight:700; margin-top:8px;">New pricing calculator submission</div>
          </td>
        </tr>

        <!-- Contact -->
        <tr>
          <td style="padding:28px 32px 8px;">
            <div style="font-family:'Courier New', monospace; font-size:11px; color:${RED}; letter-spacing:0.08em; border-bottom:2px solid ${RED}; display:inline-block; padding-bottom:4px;">CONTACT</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
              <tr>
                <td style="padding:6px 0; color:${MUTED}; font-size:13px; width:120px;">Name</td>
                <td style="padding:6px 0; color:${DARK}; font-weight:700;">${escapeHtml(contact.name)}</td>
              </tr>
              <tr>
                <td style="padding:6px 0; color:${MUTED}; font-size:13px;">Company</td>
                <td style="padding:6px 0; color:${DARK}; font-weight:700;">${escapeHtml(contact.company)}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Setup -->
        <tr>
          <td style="padding:24px 32px 8px;">
            <div style="font-family:'Courier New', monospace; font-size:11px; color:${RED}; letter-spacing:0.08em; border-bottom:2px solid ${RED}; display:inline-block; padding-bottom:4px;">SETUP</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;">
              <tr>
                <td style="padding:6px 0; color:${MUTED}; font-size:13px; width:160px;">Intercom situation</td>
                <td style="padding:6px 0; color:${DARK};">${escapeHtml(setup.label || '')}</td>
              </tr>
              <tr>
                <td style="padding:6px 0; color:${MUTED}; font-size:13px;">Team size</td>
                <td style="padding:6px 0; color:${DARK};">${escapeHtml(setup.teamSize || '')}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Engagement -->
        <tr>
          <td style="padding:24px 32px 8px;">
            <div style="font-family:'Courier New', monospace; font-size:11px; color:${RED}; letter-spacing:0.08em; border-bottom:2px solid ${RED}; display:inline-block; padding-bottom:4px;">ENGAGEMENT BUILD</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px; border-top:1px solid ${BORDER};">
              ${compRows}
              ${migrationRow}
              <tr>
                <td style="padding:14px 12px; background:${BG_ALT}; font-weight:700; color:${DARK}; font-size:15px;">
                  Project subtotal
                </td>
                <td style="padding:14px 12px; background:${BG_ALT}; text-align:right; font-weight:800; color:${RED}; font-size:18px; white-space:nowrap;">
                  From ${fmtMoney(pricing.projectSubtotalClient, currency, symbol)}
                </td>
              </tr>
              ${retainerBlock}
            </table>
          </td>
        </tr>

        <!-- Internal pricing breakdown -->
        <tr>
          <td style="padding:24px 32px 8px;">
            <div style="font-family:'Courier New', monospace; font-size:11px; color:${RED}; letter-spacing:0.08em; border-bottom:2px solid ${RED}; display:inline-block; padding-bottom:4px;">INTERNAL DETAIL</div>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px; font-size:13px;">
              <tr>
                <td style="padding:5px 0; color:${MUTED};">Total project hours</td>
                <td style="padding:5px 0; color:${DARK}; text-align:right; font-weight:700;">${(pricing.totalHours || 0).toFixed(1)} hrs</td>
              </tr>
              <tr>
                <td style="padding:5px 0; color:${MUTED};">Hourly rate (USD)</td>
                <td style="padding:5px 0; color:${DARK}; text-align:right; font-weight:700;">$${(pricing.hourlyRateUSD || 0).toLocaleString('en-US')}</td>
              </tr>
              <tr>
                <td style="padding:5px 0; color:${MUTED};">Project subtotal (USD)</td>
                <td style="padding:5px 0; color:${DARK}; text-align:right; font-weight:700;">$${Math.round(pricing.projectSubtotalUSD || 0).toLocaleString('en-US')}</td>
              </tr>
              ${retainer ? `
                <tr>
                  <td style="padding:5px 0; color:${MUTED};">Retainer (USD)</td>
                  <td style="padding:5px 0; color:${DARK}; text-align:right; font-weight:700;">$${Math.round(retainer.priceUSD || 0).toLocaleString('en-US')} / mo</td>
                </tr>
              ` : ''}
              <tr>
                <td style="padding:5px 0; color:${MUTED};">Currency shown to client</td>
                <td style="padding:5px 0; color:${DARK}; text-align:right; font-weight:700;">${escapeHtml(currency)}</td>
              </tr>
              <tr>
                <td style="padding:5px 0; color:${MUTED};">FX rate applied</td>
                <td style="padding:5px 0; color:${DARK}; text-align:right; font-weight:700;">${pricing.fxRate || 1}</td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Meta -->
        <tr>
          <td style="padding:24px 32px 32px;">
            <div style="font-family:'Courier New', monospace; font-size:10px; color:${MUTED}; letter-spacing:0.06em;">
              Submitted ${escapeHtml(meta.submittedAt || new Date().toISOString())}<br>
              ${meta.userAgent ? `User agent: ${escapeHtml(meta.userAgent)}<br>` : ''}
              ${meta.referrer ? `Referrer: ${escapeHtml(meta.referrer)}` : ''}
            </div>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#0B0B0C; padding:20px 32px; text-align:center;">
            <div style="font-family:'Courier New', monospace; font-size:10px; color:${RED}; letter-spacing:0.14em;">PERFECT MADE POSSIBLE</div>
            <div style="font-family:'Courier New', monospace; font-size:10px; color:${MUTED}; letter-spacing:0.06em; margin-top:6px;">sabelcustomersuccess.com</div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ---------- Handler ----------
module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  setCors(res, origin);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const { contact = {} } = body;
    const name = (contact.name || '').trim();
    const company = (contact.company || '').trim();

    // Validation
    if (!name || !company) {
      return res.status(400).json({ error: 'Missing required fields: name, company.' });
    }

    // Resend
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.error('RESEND_API_KEY env var not set');
      return res.status(500).json({ error: 'Email service not configured.' });
    }

    const notifyEmail = process.env.NOTIFY_EMAIL || 'richard@sabelcustomersuccess.com';
    const fromEmail = process.env.FROM_EMAIL || 'Sabel Pricing <pricing@sabelcustomersuccess.com>';

    body.contact = { name, company };
    body.meta = body.meta || {};
    body.meta.submittedAt = new Date().toISOString();
    body.meta.userAgent = req.headers['user-agent'] || '';
    body.meta.referrer = req.headers['referer'] || '';

    const html = buildEmailHtml(body);
    const subject = `New pricing submission · ${name} · ${company}`;

    const resendRes = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [notifyEmail],
        subject,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errorText = await resendRes.text();
      console.error('Resend error:', resendRes.status, errorText);
      return res.status(502).json({ error: 'Could not send notification email.' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Server error processing submission.' });
  }
};
