import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();
// ─────────────────────────────────────────────────────────────
// ALLOWED_KEYS — add a new entry here every time a tracker is
// deployed. Trackers will fail safe (404) if their key isn't
// in this list, which stops typos from corrupting shared state.
//
// WRITES: when the TRACKER_WRITE_TOKEN env var is set in Vercel,
// every POST must carry that token (header `X-Tracker-Token`,
// or `token` in the JSON body for older form-style posts).
// While the env var is unset the API behaves exactly as before
// (open writes, with a console.warn) — set the env var only
// AFTER every tracker/portal frontend has been updated to send
// the token, so live saves never break mid-rollout.
// ─────────────────────────────────────────────────────────────
const ALLOWED_KEYS = [
  'raiz-tracker-v1',
  'huuuge-tracker-v1',
  'cirqul-tracker-v1',
  'education-perfect-tracker-v1',
  'spartans-tracker-v1',
  'donkey-republic-tracker-v1',
  'bts-tracker-v1',
  'aftership-tracker-v1',
  'bts-usa-june-tracker-v1',
  'hero-tolk-tracker-v1',
  'bts-usa-tracker-v1',
  'yfood-tracker-v1',
  'flkitover-tracker-v1',
  'client-portal-v1',                // ← Client Onboarding/Offboarding Portal (whole-portal state)
  'thegivingmovement-tracker-v1',    // ← The Giving Movement project tracker
  'gps-insight-tracker-v1',          // ← GPS Insight project tracker
  'cronos-tracker-v1',
  'tulka-tracker-v1',
  'sabel-weekly-notes-v1',
  'sabel-golive-overrides-v1',
  'positive-salary-packaging-tracker-v1',
  'sabel-weekly-updates-v1',
  'soundingboard-tracker-v1',
  'sabel-client-info-v1',
  'eugenelabs-tracker-v1',
  'sabel-hours-v1',                  // ← internal hours tracker + menu bar widget
  'synchronest-tracker-v1'
];

// ─────────────────────────────────────────────────────────────
// SLACK NOTIFICATIONS (optional).
//
// On each save we diff the incoming state against what is currently
// stored, BEFORE writing it. Any CLIENT task that has just flipped to
// Complete triggers one Slack message. Detection is server-side, so
// there is exactly one notification per real event no matter how many
// people have the tracker open, and nothing is exposed in the
// client-facing HTML.
//
// Only fires for trackers whose payload uses the { statuses, buildV,
// taskData } shape with `-c-` client task ids. Trackers with any other
// payload shape (e.g. FlkitOver's { phases, colWidths }) never match and
// are unaffected.
//
// Set SLACK_WEBHOOK_URL in Vercel env vars to enable. Without it, saves
// behave exactly as before. Notification failures never block a save.
// ─────────────────────────────────────────────────────────────
const SLACK = process.env.SLACK_WEBHOOK_URL;

// Newly-Complete CLIENT tasks between the stored state and the incoming
// save. Skips first-ever saves and rebuilds (different buildV), where a
// diff would be meaningless or would mass-fire.
function clientCompletions(oldP, newP) {
  if (!oldP || !newP || typeof oldP !== 'object' || typeof newP !== 'object') return [];
  if (!oldP.statuses || !newP.statuses) return [];
  if (oldP.buildV !== newP.buildV) return [];
  const out = [];
  for (const cid of Object.keys(newP.statuses)) {
    if (!cid.includes('-c-')) continue; // client tasks only
    if (newP.statuses[cid] === 'Complete' && oldP.statuses[cid] !== undefined && oldP.statuses[cid] !== 'Complete') {
      const m = cid.match(/^(.*)-c-(\d+)$/);
      let title = cid, owner = '', week = '', pillar = m ? m[1] : '';
      if (m && newP.taskData && newP.taskData[m[1]] && Array.isArray(newP.taskData[m[1]].client)) {
        const t = newP.taskData[m[1]].client[parseInt(m[2], 10)];
        if (t) {
          title = t.t || title;
          owner = t.o || '';
          week = t.week ? ('Week ' + t.week + (t.wkEnd ? '-' + t.wkEnd : '')) : '';
        }
      }
      out.push({ pillar, title, owner, week });
    }
  }
  return out;
}

async function notifySlack(key, items) {
  if (!SLACK || !items.length) return;
  const lines = items.map(i =>
    `:white_check_mark: *${i.owner || 'Client'}* completed: "${i.title}"` +
    (i.week ? ` · ${i.week}` : '') + (i.pillar ? ` · ${i.pillar}` : ''));
  const text = `Client progress on \`${key}\`:\n` + lines.join('\n');
  try {
    await fetch(SLACK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch (e) { /* notifications must never block saves */ }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tracker-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  // Accept the key from the query string (?key=) OR the POST body {key},
  // so both the older and newer tracker styles work.
  const body = req.body || {};
  const key = req.query.key || body.key;
  if (!key) {
    return res.status(400).json({ ok: false, error: 'Missing key (query ?key= or body { key })' });
  }
  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(404).json({ ok: false, error: `Unknown tracker key: ${key}` });
  }
  if (req.method === 'GET') {
    try {
      const data = await redis.get(key);
      // Return the state under BOTH `data` (object — read by the dashboard and
      // newer trackers) and `value` (JSON string — read by V2 skill trackers),
      // so every frontend can load regardless of which field it expects.
      return res.status(200).json({
        ok: true,
        data: data ?? null,
        value: data == null ? null : JSON.stringify(data),
      });
    } catch (err) {
      console.error('Redis GET error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  if (req.method === 'POST') {
    try {
      // ── Write-token gate (zero-downtime rollout) ──────────────
      // Enforced ONLY when TRACKER_WRITE_TOKEN is set in the env.
      // Token is accepted from the X-Tracker-Token header (preferred)
      // or a `token` field in the JSON body (old-style form posts).
      const expectedToken = process.env.TRACKER_WRITE_TOKEN;
      const providedToken = req.headers['x-tracker-token'] || body.token;
      if (expectedToken) {
        if (providedToken !== expectedToken) {
          return res.status(401).json({ ok: false, error: 'Missing or invalid write token' });
        }
      } else {
        console.warn(
          `tracker: unauthenticated write to "${key}" — TRACKER_WRITE_TOKEN not set, write gate is OFF`
        );
      }
      // Accept the payload as { data } (newer trackers), { value } (V2 skill
      // trackers), OR the raw posted body itself (older trackers that POST their
      // whole state object directly, with the key in the query string). The raw
      // fallback strips the wrapper fields (key, token) so they never pollute
      // the stored state.
      let payload;
      if (body.data !== undefined) {
        payload = body.data;
      } else if (body.value !== undefined) {
        payload = body.value;
      } else {
        const { key: _k, token: _t, ...rest } = body;
        payload = Object.keys(rest).length ? rest : undefined;
      }
      // Reject empty saves: a POST of nothing/null must never overwrite state.
      if (payload === undefined || payload === null) {
        return res.status(400).json({ ok: false, error: 'No data provided (expected { data }, { value }, or a state body)' });
      }
      // If a JSON string was sent (some skill trackers send value as a string),
      // store the parsed object so the dashboard can read it directly.
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch (_) { /* keep as-is if not JSON */ }
      }
      // Diff BEFORE writing so we can detect newly-Complete client tasks.
      // Any failure here must never block the save.
      let notifyItems = [];
      try {
        const prev = await redis.get(key);
        notifyItems = clientCompletions(prev, payload);
      } catch (diffErr) {
        console.error('tracker: completion diff failed (save unaffected):', diffErr);
      }
      await redis.set(key, payload);
      // Audit stamp — stored under a parallel meta:<key> so the tracker
      // payload shape (read back raw by every frontend) is never altered.
      // meta:* keys are not in ALLOWED_KEYS, so they are unreachable via this API.
      try {
        await redis.set(`meta:${key}`, {
          lastWrite: new Date().toISOString(),
          tokenPresent: Boolean(providedToken),
        });
      } catch (metaErr) {
        console.error('Redis meta SET error (write itself succeeded):', metaErr);
      }
      // Fire Slack notifications AFTER the write is durable. Awaited because
      // serverless functions freeze after the response is sent.
      await notifySlack(key, notifyItems);
      return res.status(200).json({ ok: true, notified: notifyItems.length });
    } catch (err) {
      console.error('Redis SET error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
