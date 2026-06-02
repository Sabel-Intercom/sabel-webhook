import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

// ─────────────────────────────────────────────────────────────
// ALLOWED_KEYS — add a new entry here every time a tracker is
// deployed. Trackers will fail safe (404) if their key isn't
// in this list, which stops typos from corrupting shared state.
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
  'bts-usa-tracker-v1',
  'flkitover-tracker-v1',
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = req.query.key;
  if (!key) {
    return res.status(400).json({ ok: false, error: 'Missing ?key= parameter' });
  }
  if (!ALLOWED_KEYS.includes(key)) {
    return res.status(404).json({ ok: false, error: `Unknown tracker key: ${key}` });
  }

  if (req.method === 'GET') {
    try {
      const data = await redis.get(key);
      return res.status(200).json({ ok: true, data: data || null });
    } catch (err) {
      console.error('Redis GET error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { data } = req.body;
      if (data === undefined) return res.status(400).json({ ok: false, error: 'No data provided' });
      await redis.set(key, data);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Redis SET error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
