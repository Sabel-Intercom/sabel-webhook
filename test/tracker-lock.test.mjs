// Run: npm test   (node --import ./test/mock-redis.mjs --test test/)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.KICKOFF_TEAM_TOKEN = 'team-secret-for-tests';
delete process.env.TRACKER_WRITE_TOKEN;
delete process.env.SLACK_WEBHOOK_URL;
delete process.env.RESEND_API_KEY;

const { default: tracker } = await import('../api/tracker.js');
const { default: trackerLock } = await import('../api/tracker-lock.js');
const { __store } = await import('./mock-redis-impl.mjs');
const { authorize, hashToken, isLockRecord, safeEqual } = await import('../lib/tracker-lock.js');

const TEAM = { 'x-team-token': 'team-secret-for-tests' };
const KEY = 'cookaborough-tracker-v1';

function call(handler, { method = 'GET', query = {}, body, headers = {} } = {}) {
  const req = { method, query, body, headers };
  const out = { status: 0, body: undefined, headers: {} };
  const res = {
    setHeader(k, v) { out.headers[k] = v; },
    status(s) { out.status = s; return res; },
    json(b) { out.body = b; return out; },
    end() { return out; },
  };
  return Promise.resolve(handler(req, res)).then(() => out);
}

beforeEach(() => __store.clear());

// ---- pure helpers -------------------------------------------------------

test('safeEqual: equal strings only', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.equal(safeEqual('abc', null), false);
});

test('authorize: no lock is open; lock needs team or matching client token', () => {
  const req = (h) => ({ headers: h });
  assert.deepEqual(authorize({ lock: null, req: req({}), teamToken: 't' }), { allowed: true, via: 'open' });
  const lock = { hash: hashToken('client-token-1234567890'), setAt: 'x' };
  assert.equal(authorize({ lock, req: req({}), teamToken: 't' }).allowed, false);
  assert.equal(authorize({ lock, req: req({ 'x-client-token': 'wrong' }), teamToken: 't' }).allowed, false);
  assert.equal(authorize({ lock, req: req({ 'x-client-token': 'client-token-1234567890' }), teamToken: 't' }).via, 'client');
  assert.equal(authorize({ lock, req: req({ 'x-team-token': 't' }), teamToken: 't' }).via, 'team');
  // unset team token never opens a lock
  assert.equal(authorize({ lock, req: req({ 'x-team-token': '' }), teamToken: '' }).allowed, false);
  // a malformed lock record is team-only, never open
  assert.equal(authorize({ lock: { junk: 1 }, req: req({ 'x-client-token': 'anything' }), teamToken: 't' }).allowed, false);
  assert.equal(authorize({ lock: { junk: 1 }, req: req({ 'x-team-token': 't' }), teamToken: 't' }).allowed, true);
});

test('isLockRecord', () => {
  assert.equal(isLockRecord({ hash: hashToken('x') }), true);
  assert.equal(isLockRecord({ hash: 'short' }), false);
  assert.equal(isLockRecord(null), false);
  assert.equal(isLockRecord('string'), false);
});

// ---- /api/tracker with no lock: unchanged behaviour ---------------------

test('unlocked key: GET and POST work with no headers, as today', async () => {
  let r = await call(tracker, { query: { key: KEY } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, data: null, value: null });
  r = await call(tracker, { method: 'POST', body: { key: KEY, value: JSON.stringify({ statuses: {}, buildV: 1 }) } });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  r = await call(tracker, { query: { key: KEY } });
  assert.deepEqual(r.body.data, { statuses: {}, buildV: 1 });
  assert.equal(__store.get(`meta:${KEY}`).via, 'open');
});

test('unknown key still 404; lock:* and meta:* keys unreachable through /api/tracker', async () => {
  for (const k of ['nope-v1', `lock:${KEY}`, `meta:${KEY}`]) {
    const r = await call(tracker, { query: { key: k }, headers: TEAM });
    assert.equal(r.status, 404, k);
  }
});

test('team-only key still refuses without team passcode', async () => {
  let r = await call(tracker, { query: { key: 'sabel-kickoff-v1' } });
  assert.equal(r.status, 401);
  r = await call(tracker, { query: { key: 'sabel-kickoff-v1' }, headers: TEAM });
  assert.equal(r.status, 200);
});

// ---- /api/tracker-lock ----------------------------------------------------

test('lock endpoint: team passcode required on every method', async () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    const r = await call(trackerLock, { method, query: { key: KEY }, body: { key: KEY } });
    assert.equal(r.status, 401, method);
  }
  const r = await call(trackerLock, { method: 'GET', headers: { 'x-team-token': 'wrong' } });
  assert.equal(r.status, 401);
});

test('lock endpoint: refuses everything when KICKOFF_TEAM_TOKEN is unset', async () => {
  const saved = process.env.KICKOFF_TEAM_TOKEN;
  delete process.env.KICKOFF_TEAM_TOKEN;
  try {
    const r = await call(trackerLock, { method: 'GET', headers: TEAM });
    assert.equal(r.status, 503);
  } finally {
    process.env.KICKOFF_TEAM_TOKEN = saved;
  }
});

test('lock endpoint: unknown key 404, short token 400', async () => {
  let r = await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: 'nope-v1' } });
  assert.equal(r.status, 404);
  r = await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: KEY, token: 'short' } });
  assert.equal(r.status, 400);
});

test('lock a key: generated token returned once, only the hash stored', async () => {
  const r = await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: KEY, label: 'Cookaborough hub' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.locked, true);
  assert.equal(r.body.replaced, false);
  assert.equal(typeof r.body.token, 'string');
  assert.ok(r.body.token.length >= 24);
  const stored = __store.get(`lock:${KEY}`);
  assert.equal(stored.hash, hashToken(r.body.token));
  assert.equal(stored.label, 'Cookaborough hub');
  assert.ok(!JSON.stringify(stored).includes(r.body.token));
  // GET never returns the token
  const g = await call(trackerLock, { method: 'GET', headers: TEAM, query: { key: KEY } });
  assert.deepEqual(Object.keys(g.body).sort(), ['key', 'label', 'locked', 'ok', 'setAt']);
});

test('locked key: /api/tracker refuses without a token, accepts client or team token', async () => {
  await call(tracker, { method: 'POST', body: { key: KEY, data: { statuses: {}, buildV: 5 } } });
  const { body: { token } } = await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: KEY } });

  let r = await call(tracker, { query: { key: KEY } });
  assert.equal(r.status, 401);
  assert.equal(r.body.locked, true);
  assert.equal(r.body.data, undefined);

  r = await call(tracker, { method: 'POST', body: { key: KEY, data: { statuses: { a: 1 }, buildV: 5 } } });
  assert.equal(r.status, 401);
  assert.deepEqual(__store.get(KEY), { statuses: {}, buildV: 5 }, 'refused write must not land');

  r = await call(tracker, { query: { key: KEY }, headers: { 'x-client-token': 'not-the-token-1234567' } });
  assert.equal(r.status, 401);

  r = await call(tracker, { query: { key: KEY }, headers: { 'x-client-token': token } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { statuses: {}, buildV: 5 });

  r = await call(tracker, { method: 'POST', headers: { 'x-client-token': token }, body: { key: KEY, data: { statuses: { a: 1 }, buildV: 5 } } });
  assert.equal(r.status, 200);
  assert.equal(__store.get(`meta:${KEY}`).via, 'client');

  r = await call(tracker, { query: { key: KEY }, headers: TEAM });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { statuses: { a: 1 }, buildV: 5 });
  await call(tracker, { method: 'POST', headers: TEAM, body: { key: KEY, data: { statuses: { a: 2 }, buildV: 5 } } });
  assert.equal(__store.get(`meta:${KEY}`).via, 'team');
});

test('clientToken in a raw-body post is stripped from the stored state', async () => {
  const r = await call(tracker, { method: 'POST', query: { key: KEY }, body: { phases: [1], clientToken: 'leak', token: 'leak2' } });
  assert.equal(r.status, 200);
  assert.deepEqual(__store.get(KEY), { phases: [1] });
});

test('rotate: a second POST replaces the lock and the old token stops working', async () => {
  const a = await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: KEY } });
  const b = await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: KEY } });
  assert.equal(b.body.replaced, true);
  assert.notEqual(a.body.token, b.body.token);
  assert.equal((await call(tracker, { query: { key: KEY }, headers: { 'x-client-token': a.body.token } })).status, 401);
  assert.equal((await call(tracker, { query: { key: KEY }, headers: { 'x-client-token': b.body.token } })).status, 200);
});

test('supplied token is honoured; clearing the lock reopens the key', async () => {
  const supplied = 'cookaborough-pilot-token-0001';
  const r = await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: KEY, token: supplied } });
  assert.equal(r.body.token, undefined, 'supplied token is not echoed');
  assert.equal((await call(tracker, { query: { key: KEY }, headers: { 'x-client-token': supplied } })).status, 200);
  assert.equal((await call(tracker, { query: { key: KEY } })).status, 401);

  const d = await call(trackerLock, { method: 'DELETE', headers: TEAM, query: { key: KEY } });
  assert.deepEqual(d.body, { ok: true, key: KEY, locked: false, cleared: true });
  assert.equal((await call(tracker, { query: { key: KEY } })).status, 200);
  const d2 = await call(trackerLock, { method: 'DELETE', headers: TEAM, query: { key: KEY } });
  assert.equal(d2.body.cleared, false);
});

test('list locks', async () => {
  await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: 'readiness-cookaborough-v1', label: 'r' } });
  await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: KEY } });
  const r = await call(trackerLock, { method: 'GET', headers: TEAM });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.locks.map(l => l.key), [KEY, 'readiness-cookaborough-v1']);
  assert.ok(r.body.locks.every(l => l.locked && !('token' in l) && !('hash' in l)));
});

test('a malformed lock record fails closed for clients, open for team', async () => {
  __store.set(`lock:${KEY}`, { garbage: true });
  assert.equal((await call(tracker, { query: { key: KEY }, headers: { 'x-client-token': 'anything-long-enough' } })).status, 401);
  assert.equal((await call(tracker, { query: { key: KEY }, headers: TEAM })).status, 200);
});
