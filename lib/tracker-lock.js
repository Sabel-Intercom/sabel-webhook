// -------------------------------------------------------------
// PER-KEY LOCK (8 Nov 2026).
//
// A tracker key can be LOCKED. A locked key answers only to:
//   - the team passcode   (header X-Team-Token = KICKOFF_TEAM_TOKEN), or
//   - that key's client token (header X-Client-Token), which is embedded
//     in the client's hub page. The page itself sits behind Cloudflare
//     Access, so only people the client's Access policy admits can see it.
//
// The lock lives in Redis under `lock:<key>` as { hash, setAt, label }.
// Only a SHA-256 of the client token is stored, never the token itself.
// `lock:*` keys are not in ALLOWED_KEYS, so /api/tracker cannot read or
// write them; /api/tracker-lock manages them and needs the team passcode.
//
// Keys with no lock behave exactly as before, so clients move over one
// at a time and nothing breaks for the ones not yet switched.
// -------------------------------------------------------------
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export const LOCK_PREFIX = 'lock:';
export const MIN_TOKEN_LENGTH = 16;

export function lockKey(key) {
  return LOCK_PREFIX + key;
}

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

// Constant-time string compare. Any non-string, or a length mismatch, is
// a mismatch; length is not secret here (hashes are fixed-width, and the
// team passcode's length is not what protects it).
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const A = Buffer.from(a, 'utf8');
  const B = Buffer.from(b, 'utf8');
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

export function newClientToken() {
  return randomBytes(24).toString('base64url');
}

function header(req, name) {
  const v = req && req.headers ? req.headers[name] : undefined;
  return typeof v === 'string' && v.length ? v : null;
}

// True only when KICKOFF_TEAM_TOKEN is set AND the request carries it.
// An unset passcode never opens anything.
export function isTeamRequest(req, teamToken = process.env.KICKOFF_TEAM_TOKEN) {
  if (!teamToken) return false;
  return safeEqual(header(req, 'x-team-token'), teamToken);
}

export function clientTokenFrom(req) {
  return header(req, 'x-client-token');
}

// Is this lock record well-formed? Anything else is treated as "locked
// with no valid token", i.e. team-only, never as open.
export function isLockRecord(lock) {
  return Boolean(lock) && typeof lock === 'object' && typeof lock.hash === 'string' && lock.hash.length === 64;
}

// Decide whether a request may touch `key` given its lock record (null or
// undefined = no lock). Returns { allowed, via } where via is one of
// 'open' (no lock), 'team', 'client'; or { allowed: false, reason }.
export function authorize({ lock, req, teamToken = process.env.KICKOFF_TEAM_TOKEN }) {
  if (lock === null || lock === undefined) return { allowed: true, via: 'open' };
  if (isTeamRequest(req, teamToken)) return { allowed: true, via: 'team' };
  if (!isLockRecord(lock)) return { allowed: false, reason: 'lock-malformed' };
  const token = clientTokenFrom(req);
  if (token && safeEqual(hashToken(token), lock.hash)) return { allowed: true, via: 'client' };
  return { allowed: false, reason: token ? 'client-token-wrong' : 'no-token' };
}

// Build the record stored under lock:<key>.
export function makeLockRecord(token, label) {
  return {
    hash: hashToken(token),
    setAt: new Date().toISOString(),
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : undefined,
  };
}
