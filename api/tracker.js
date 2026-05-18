import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();
const KEY = 'raiz-tracker-v1'; // ← update this per engagement

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    try {
      const data = await redis.get(KEY);
      return res.status(200).json({ ok: true, data: data || null });
    } catch (err) {
      console.error('Redis GET error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { data } = req.body;
      if (!data) return res.status(400).json({ ok: false, error: 'No data provided' });
      await redis.set(KEY, data);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Redis SET error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
