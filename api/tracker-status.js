import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

// ─────────────────────────────────────────────────────────────
// tracker-status — authenticated, targeted status merge.
//
// Used by the Sabel sync service (Fly, sabel-reclaim-mcp): when a
// Sabel-side task is completed in Notion/Reclaim, this flips just
// that task's status in the tracker state, leaving everything else
// (taskData, notes, buildV, ...) untouched. Read→write window is
// milliseconds, unlike the full-blob saves the tracker pages do.
//
// POST { key, updates: { "<taskId>": "Complete", ... }, token }
// Token via X-Tracker-Token header or body.token. FAIL-CLOSED:
// requests are rejected unless TRACKER_STATUS_TOKEN is set in the
// env AND matches. This is deliberately a separate env var from
// TRACKER_WRITE_TOKEN so the tracker.js rollout stays independent.
//
// Task ids: modern trackers use "<phase>-<s|c>-<idx>" (statuses
// map); legacy phased trackers (Raiz) use the task's own id inside
// data.phases[].tasks[].
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
  'thegivingmovement-tracker-v1',
  'gps-insight-tracker-v1',
  'cronos-tracker-v1',
  'tulka-tracker-v1',
  'positive-salary-packaging-tracker-v1',
  'soundingboard-tracker-v1',
  'eugenelabs-tracker-v1',
  'synchronest-tracker-v1',
  'demo-tracker-v1', // test sandbox — never shipped to a client
];

const VALID_STATUSES = ['Pending', 'In Progress', 'Complete', 'Dependency', 'Blocked'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Tracker-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const expectedToken = process.env.TRACKER_STATUS_TOKEN;
  const body = req.body || {};
  const providedToken = req.headers['x-tracker-token'] || body.token;
  if (!expectedToken || providedToken !== expectedToken) {
    return res.status(401).json({ ok: false, error: 'Missing or invalid status token' });
  }

  const { key, updates } = body;
  if (!key || !updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return res.status(400).json({ ok: false, error: 'Expected { key, updates: { taskId: status } }' });
  }
  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(404).json({ ok: false, error: `Unknown tracker key: ${key}` });
  }
  for (const status of Object.values(updates)) {
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ ok: false, error: `Invalid status: ${status}` });
    }
  }

  try {
    const state = await redis.get(key);
    if (state == null || typeof state !== 'object') {
      return res.status(409).json({ ok: false, error: 'No saved state for this tracker yet' });
    }

    const applied = [];
    const missing = [];
    if (Array.isArray(state.phases)) {
      // Legacy phased shape (e.g. Raiz): mutate the task objects in place.
      const byId = {};
      for (const phase of state.phases) {
        for (const t of phase.tasks || []) byId[t.id] = t;
      }
      for (const [taskId, status] of Object.entries(updates)) {
        if (byId[taskId]) { byId[taskId].status = status; applied.push(taskId); }
        else missing.push(taskId);
      }
    } else {
      // Modern shape: statuses overlay map, flattened into tasks at page load.
      if (!state.statuses || typeof state.statuses !== 'object') state.statuses = {};
      for (const [taskId, status] of Object.entries(updates)) {
        // Only ids the tracker actually renders should be written; ids follow
        // "<phase>-<s|c>-<idx>". Unknown phases are still written (harmless:
        // load-time flattening ignores ids with no matching task), but flag
        // clearly malformed ids instead.
        if (/^.+-(s|c)-\d+$/.test(taskId)) { state.statuses[taskId] = status; applied.push(taskId); }
        else missing.push(taskId);
      }
    }

    if (applied.length) await redis.set(key, state);
    try {
      await redis.set(`meta:${key}`, {
        lastWrite: new Date().toISOString(),
        tokenPresent: true,
        source: 'tracker-status',
        applied,
      });
    } catch (metaErr) {
      console.error('Redis meta SET error (write itself succeeded):', metaErr);
    }
    return res.status(200).json({ ok: true, applied, missing });
  } catch (err) {
    console.error('tracker-status error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
