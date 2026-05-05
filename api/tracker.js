import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Whitelist of allowed tracker keys. Add new clients here.
const ALLOWED_KEYS = new Set([
  'spartans-tracker-v1',
  'education-perfect-tracker-v1',
  'huuuge-tracker-v1',
  'aftership-tracker-v1',
  'bts-usa-tracker-v1',
  'donkey-republic-tracker-v1',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Key MUST come from the query param. No fallback, no default.
  const key = req.query.key;
  if (!key) {
    return res.status(400).json({ ok: false, error: 'Missing required ?key= parameter' });
  }
  if (!ALLOWED_KEYS.has(key)) {
    return res.status(403).json({ ok: false, error: `Unknown key: ${key}` });
  }

  if (req.method === 'GET') {
    try {
      const data = await redis.get(key);
      return res.status(200).json({ ok: true, key, data: data || null });
    } catch (err) {
      console.error('Redis GET error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { data } = req.body;
      if (!data) return res.status(400).json({ ok: false, error: 'No data provided' });
      await redis.set(key, data);
      return res.status(200).json({ ok: true, key });
    } catch (err) {
      console.error('Redis SET error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
