// Sabel Technical Readiness Check — submission endpoint.
// Deploy as api/readiness.js in the existing `sabel-webhook` Vercel project.
//
// WHAT IT DOES
//   POST  /api/readiness              store a submission, then notify
//   GET   /api/readiness?token=…      list submissions (newest first)
//   GET   /api/readiness?token=…&id=… fetch one full submission
//
// STORAGE (Upstash Redis, same instance the trackers use)
//   readiness:sub:<id>   one submission, JSON
//   readiness:index      array of {id, client, contactName, contactEmail,
//                        submittedAt, summary}, newest first
//
// ENV VARS
//   UPSTASH_REDIS_REST_URL     already set on sabel-webhook
//   UPSTASH_REDIS_REST_TOKEN   already set on sabel-webhook
//   READINESS_ADMIN_TOKEN      any long random string. Required for the GET
//                              endpoints and the admin page. Without it the
//                              GET endpoints refuse every request.
//   RESEND_API_KEY             optional. From resend.com. Enables the email.
//   RESEND_FROM                optional. e.g. "Sabel <forms@sabelcustomersuccess.com>"
//                              The domain must be verified in Resend.
//   NOTIFY_EMAIL               optional. Defaults to admin@sabelcustomersuccess.com
//   SLACK_WEBHOOK_URL          optional. Already set if the tracker pings Slack.
//
// Email and Slack are both best effort. Neither failing ever loses a submission:
// the store write happens first and is what the client's success screen reflects.

/* The Upstash credentials on this project are not guaranteed to be under the
   names Upstash's own docs use — Vercel's integration writes KV_REST_API_*,
   a manual setup usually writes UPSTASH_REDIS_REST_*, and older projects use
   REDIS_*. Read whichever pair is actually present rather than making Richard
   duplicate them. */
const BASE = process.env.UPSTASH_REDIS_REST_URL
          || process.env.KV_REST_API_URL
          || process.env.REDIS_REST_URL
          || process.env.STORAGE_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN
           || process.env.KV_REST_API_TOKEN
           || process.env.REDIS_REST_TOKEN
           || process.env.STORAGE_REST_API_TOKEN;
const ADMIN  = process.env.READINESS_ADMIN_TOKEN;
const RESEND = process.env.RESEND_API_KEY;
const FROM   = process.env.RESEND_FROM || 'Sabel Forms <onboarding@resend.dev>';
const TO     = process.env.NOTIFY_EMAIL || 'admin@sabelcustomersuccess.com';
const SLACK  = process.env.SLACK_WEBHOOK_URL;

/* ---------- Upstash helpers ---------- */
async function redisGet(key) {
  const r = await fetch(`${BASE}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const j = await r.json();
  return j.result ?? null;
}
async function redisSet(key, value) {
  // Value in the body, not the path — submissions are too big for a URL.
  const r = await fetch(`${BASE}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'text/plain' },
    body: typeof value === 'string' ? value : JSON.stringify(value)
  });
  return r.json();
}
function parse(v) {
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return null; }
}

/* ---------- formatting ---------- */
function slug(s) {
  return String(s || 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}
function newId(client) {
  const d = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15); // 20260903T041500
  return `${slug(client)}-${d}-${Math.random().toString(36).slice(2, 7)}`;
}

// Everything the client flagged as not-done, so the notification is actionable
// on its own rather than a "go and look" ping.
function attention(sub) {
  const out = [];
  Object.keys(sub.sections || {}).forEach(sec => {
    (sub.sections[sec] || []).forEach(i => {
      if (i.type === 'status' && (i.status === 'red' || i.status === 'amber')) {
        out.push({
          sec,
          status: i.status,
          question: i.question,
          answer: i.answer || '',
          owner: i.owner || '',
          dueBy: i.dueBy || '',
          note: i.note || ''
        });
      }
    });
  });
  out.sort(a => (a.status === 'red' ? -1 : 1));
  return out;
}

function textReport(sub, id) {
  const s = sub.summary || {};
  const L = [];
  L.push(`SABEL TECHNICAL READINESS CHECK`);
  L.push(`Company:      ${sub.client || '(not given)'}`);
  L.push(`Project type: ${sub.projectType || '(not given)'}`);
  L.push(`Completed by: ${sub.contactName || ''} <${sub.contactEmail || ''}>${sub.contactRole ? ' — ' + sub.contactRole : ''}`);
  L.push(`Backup:       ${sub.backupContact || '(none given)'}`);
  L.push(`Submitted:    ${new Date(sub.submittedAt || Date.now()).toUTCString()}`);
  L.push(`Reference:    ${id}`);
  L.push('');
  L.push(`Ready ${s.green || 0}  ·  In progress ${s.amber || 0}  ·  Not started ${s.red || 0}  ·  N/A ${s.na || 0}  ·  Unanswered ${s.unanswered || 0}`);

  const flags = attention(sub);
  if (flags.length) {
    L.push('', 'NEEDS ATTENTION', '---------------');
    flags.forEach(f => {
      L.push(`[${f.status.toUpperCase()}] ${f.sec} — ${f.question}${f.answer ? '  → ' + f.answer : ''}`);
      const bits = [];
      if (f.owner) bits.push('owner: ' + f.owner);
      if (f.dueBy) bits.push('by: ' + f.dueBy);
      if (f.note)  bits.push(f.note);
      if (bits.length) L.push('        ' + bits.join('  |  '));
    });
  } else {
    L.push('', 'Nothing flagged amber or red.');
  }

  L.push('', 'FULL ANSWERS', '------------');
  Object.keys(sub.sections || {}).forEach(sec => {
    L.push('', `SECTION ${sec}`);
    (sub.sections[sec] || []).forEach(i => {
      if (i.type === 'status') {
        L.push(`  [${(i.status || 'unanswered').toUpperCase()}] ${i.question}` +
          (i.answer ? `  → ${i.answer}` : '') +
          (i.owner ? `  | owner: ${i.owner}` : '') +
          (i.dueBy ? `  | by: ${i.dueBy}` : '') +
          (i.note ? `  | ${i.note}` : ''));
      } else {
        L.push(`  ${i.question}`);
        Object.keys(i.answers || {}).forEach(k => {
          L.push(`     ${k}: ${i.answers[k] || '(blank)'}`);
        });
      }
    });
  });
  if (sub.otherNotes) L.push('', 'ANYTHING ELSE', '-------------', sub.otherNotes);
  return L.join('\n');
}

/* ---------- notifications ---------- */
async function sendEmail(sub, id, report) {
  if (!RESEND) return { sent: false, reason: 'RESEND_API_KEY not set' };
  const s = sub.summary || {};
  const reds = attention(sub).filter(f => f.status === 'red').length;
  const subject = `Readiness check completed — ${sub.client || 'Unknown client'}` +
    (reds ? ` (${reds} not started)` : '');
  const body =
`${sub.contactName || 'Someone'} at ${sub.client || 'an unnamed company'} has completed the Technical Readiness Check.

Project type: ${sub.projectType || 'not given'}
Ready ${s.green || 0}  ·  In progress ${s.amber || 0}  ·  Not started ${s.red || 0}  ·  N/A ${s.na || 0}  ·  Unanswered ${s.unanswered || 0}

Reference: ${id}

${report}
`;
  const recipients = [TO];
  if (sub.copyTo && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sub.copyTo)) recipients.push(sub.copyTo);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: recipients,
        reply_to: sub.contactEmail || undefined,
        subject,
        text: body
      })
    });
    if (!r.ok) return { sent: false, reason: 'resend ' + r.status };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: String(e) };
  }
}

async function sendSlack(sub, id) {
  if (!SLACK) return { sent: false };
  const s = sub.summary || {};
  const flags = attention(sub).filter(f => f.status === 'red').slice(0, 6);
  let text = `:clipboard: *Readiness check completed* — *${sub.client || 'Unknown client'}*\n` +
    `${sub.contactName || ''} <${sub.contactEmail || ''}>\n` +
    `${sub.projectType || ''}\nReady ${s.green || 0} · In progress ${s.amber || 0} · Not started ${s.red || 0} · N/A ${s.na || 0} · Unanswered ${s.unanswered || 0}\n` +
    `Ref \`${id}\``;
  if (flags.length) {
    text += `\n\n*Not started:*\n` + flags.map(f => `• ${f.question}`).join('\n');
  }
  try {
    await fetch(SLACK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    return { sent: true };
  } catch (e) {
    return { sent: false };
  }
}

/* ---------- handler ---------- */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!BASE || !TOKEN) {
    return res.status(503).json({
      error: 'Storage is not configured for this function.',
      detail: 'No Upstash REST URL/token found. Set UPSTASH_REDIS_REST_URL and ' +
              'UPSTASH_REDIS_REST_TOKEN on the sabel-webhook project (or tell us which ' +
              'names the existing tracker endpoint uses and we will read those).',
      sawUrl: !!BASE, sawToken: !!TOKEN
    });
  }

  try {
    /* ---- read: the admin page ---- */
    if (req.method === 'GET') {
      if (!ADMIN) return res.status(503).json({ error: 'READINESS_ADMIN_TOKEN not configured' });
      if (req.query.token !== ADMIN) return res.status(401).json({ error: 'unauthorised' });

      if (req.query.id) {
        const raw = await redisGet('readiness:sub:' + req.query.id);
        if (!raw) return res.status(404).json({ error: 'not found' });
        const sub = parse(raw);
        return res.status(200).json({ id: req.query.id, submission: sub, report: textReport(sub, req.query.id) });
      }
      const index = parse(await redisGet('readiness:index')) || [];
      return res.status(200).json({ count: index.length, submissions: index });
    }

    /* ---- write: the client's submit ---- */
    if (req.method === 'POST') {
      const sub = typeof req.body === 'string' ? parse(req.body) : req.body;
      if (!sub || typeof sub !== 'object') return res.status(400).json({ error: 'bad payload' });
      if (!sub.client || !sub.contactEmail) return res.status(400).json({ error: 'missing client or contactEmail' });

      const id = newId(sub.client);
      sub.receivedAt = new Date().toISOString();

      // Store first. Everything after this is best effort.
      await redisSet('readiness:sub:' + id, JSON.stringify(sub));

      const index = parse(await redisGet('readiness:index')) || [];
      index.unshift({
        id,
        client: sub.client,
        projectType: sub.projectType || '',
        contactName: sub.contactName || '',
        contactEmail: sub.contactEmail || '',
        submittedAt: sub.receivedAt,
        summary: sub.summary || {}
      });
      await redisSet('readiness:index', JSON.stringify(index.slice(0, 500)));

      // Awaited, not fire and forget: serverless functions freeze after the response.
      const report = textReport(sub, id);
      const mail = await sendEmail(sub, id, report);
      const slack = await sendSlack(sub, id);

      return res.status(200).json({ ok: true, id, emailed: mail.sent, slacked: slack.sent });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
