// -------------------------------------------------------------
// /api/tracker-lock  (8 Nov 2026)
//
// Team-only management of per-key locks. Every call needs the team
// passcode in X-Team-Token (= KICKOFF_TEAM_TOKEN in Vercel). If that env
// var is not set, every call is refused: locks can never be managed
// anonymously.
//
//   GET    /api/tracker-lock                 list locked keys { key, setAt, label }
//   GET    /api/tracker-lock?key=<k>         { locked, setAt, label }
//   POST   /api/tracker-lock  { key, token?, label? }
//            set (or replace) the lock on <k>. If `token` is omitted a new
//            client token is generated and returned ONCE in the response;
//            only its hash is stored. Put that token in the client's hub
//            build (X-Client-Token on every fetch to /api/tracker).
//   DELETE /api/tracker-lock?key=<k>         clear the lock; <k> is open again
//
// Rotating a client's token = POST again with no token: the old one stops
// working the moment the new hash is stored, so rebuild the hub first.
// -------------------------------------------------------------
import { Redis } from '@upstash/redis';
import { isAllowedKey } from './tracker.js';
import {
  LOCK_PREFIX, MIN_TOKEN_LENGTH, lockKey, isTeamRequest, isLockRecord,
  makeLockRecord, newClientToken,
} from '../lib/tracker-lock.js';

const redis = Redis.fromEnv();

function publicView(key, lock) {
  if (!isLockRecord(lock)) return { key, locked: false };
  return { key, locked: true, setAt: lock.setAt, label: lock.label };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Team-Token');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.KICKOFF_TEAM_TOKEN) {
    return res.status(503).json({ ok: false, error: 'KICKOFF_TEAM_TOKEN is not set in Vercel; locks cannot be managed.' });
  }
  if (!isTeamRequest(req)) {
    return res.status(401).json({ ok: false, error: 'Team passcode required' });
  }

  const body = req.body || {};
  const key = req.query.key || body.key;

  try {
    if (req.method === 'GET') {
      if (!key) {
        const names = await redis.keys(`${LOCK_PREFIX}*`);
        if (!names.length) return res.status(200).json({ ok: true, locks: [] });
        const records = await redis.mget(...names);
        const locks = names
          .map((n, i) => publicView(n.slice(LOCK_PREFIX.length), records[i]))
          .filter(v => v.locked)
          .sort((a, b) => a.key.localeCompare(b.key));
        return res.status(200).json({ ok: true, locks });
      }
      if (!isAllowedKey(key)) return res.status(404).json({ ok: false, error: `Unknown tracker key: ${key}` });
      const lock = await redis.get(lockKey(key));
      return res.status(200).json({ ok: true, ...publicView(key, lock) });
    }

    if (req.method === 'POST') {
      if (!key) return res.status(400).json({ ok: false, error: 'Missing key (body { key })' });
      if (!isAllowedKey(key)) return res.status(404).json({ ok: false, error: `Unknown tracker key: ${key}` });
      let token = body.token;
      let generated = false;
      if (token === undefined || token === null || token === '') {
        token = newClientToken();
        generated = true;
      } else if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH) {
        return res.status(400).json({ ok: false, error: `token must be a string of at least ${MIN_TOKEN_LENGTH} characters` });
      }
      const existing = await redis.get(lockKey(key));
      const record = makeLockRecord(token, body.label);
      await redis.set(lockKey(key), record);
      const out = { ok: true, key, locked: true, setAt: record.setAt, label: record.label, replaced: isLockRecord(existing) };
      if (generated) out.token = token; // shown once; only the hash is stored
      return res.status(200).json(out);
    }

    if (req.method === 'DELETE') {
      if (!key) return res.status(400).json({ ok: false, error: 'Missing key (query ?key= or body { key })' });
      if (!isAllowedKey(key)) return res.status(404).json({ ok: false, error: `Unknown tracker key: ${key}` });
      const removed = await redis.del(lockKey(key));
      return res.status(200).json({ ok: true, key, locked: false, cleared: removed > 0 });
    }
  } catch (err) {
    console.error('tracker-lock error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
