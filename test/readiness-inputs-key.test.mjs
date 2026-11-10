// Run: npm test   (node --import ./test/mock-redis.mjs --test test/)
// Per-client readiness inputs keys: readiness-inputs-<slug>-v1.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.KICKOFF_TEAM_TOKEN = 'team-secret-for-tests';
delete process.env.TRACKER_WRITE_TOKEN;
delete process.env.SLACK_WEBHOOK_URL;
delete process.env.RESEND_API_KEY;

const { default: tracker, isAllowedKey, READINESS_INPUTS_CLIENT_KEY, ALLOWED_KEYS } = await import('../api/tracker.js');
const { default: trackerLock } = await import('../api/tracker-lock.js');
const { __store } = await import('./mock-redis-impl.mjs');

const TEAM = { 'x-team-token': 'team-secret-for-tests' };
const A = 'readiness-inputs-acme-v1';
const B = 'readiness-inputs-other-co-v1';
const ALL = 'readiness-inputs-v1';
const SLICE_A = { v: 1, slug: 'acme', name: 'Acme', items: ['one', 'two'], access: { a1: { at: 't', by: 'Sabel' } } };
const SLICE_B = { v: 1, slug: 'other-co', name: 'Other Co', items: ['three'], access: {} };

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
const lock = async (key) => (await call(trackerLock, { method: 'POST', headers: TEAM, body: { key } })).body.token;

beforeEach(() => __store.clear());

test('pattern: per-client keys are allowed with no ALLOWED_KEYS entry; look-alikes are not', () => {
  for (const k of [A, B, 'readiness-inputs-a-v1', 'readiness-inputs-a1-b2-v1', `readiness-inputs-${'a'.repeat(60)}-v1`]) {
    assert.equal(isAllowedKey(k), true, k);
    assert.equal(ALLOWED_KEYS.includes(k), false, k);
  }
  for (const k of [
    'readiness-inputs--v1', 'readiness-inputs-v2', 'readiness-inputs-acme-v2', 'readiness-inputs-Acme-v1',
    'readiness-inputs-acme_co-v1', 'readiness-inputs--acme-v1', 'readiness-inputs-acme--v1', 'readiness-inputs-acme-v1 ',
    'xreadiness-inputs-acme-v1', 'readiness-inputs-acme-v1x', 'readiness-inputs-a/b-v1', 'readiness-inputs-a:b-v1',
    `readiness-inputs-${'a'.repeat(61)}-v1`, 'lock:readiness-inputs-acme-v1', 'meta:readiness-inputs-acme-v1',
  ]) assert.equal(isAllowedKey(k), false, k);
});

test('pattern: the combined key is a listed key, not a per-client one', () => {
  assert.equal(READINESS_INPUTS_CLIENT_KEY.test(ALL), false);
  assert.equal(ALLOWED_KEYS.includes(ALL), true);
});

test('unlocked per-client key: anyone reads (null until written), only the team writes', async () => {
  let r = await call(tracker, { query: { key: A } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, data: null, value: null });

  r = await call(tracker, { method: 'POST', query: { key: A }, body: { data: SLICE_A } });
  assert.equal(r.status, 401);
  assert.equal(__store.has(A), false, 'refused write must not land');
  r = await call(tracker, { method: 'POST', query: { key: A }, headers: { 'x-client-token': 'any-client-token-123456' }, body: { data: SLICE_A } });
  assert.equal(r.status, 401);
  r = await call(tracker, { method: 'POST', query: { key: A }, headers: { 'x-team-token': 'wrong' }, body: { data: SLICE_A } });
  assert.equal(r.status, 401);
  assert.equal(__store.has(A), false);

  r = await call(tracker, { method: 'POST', query: { key: A }, headers: TEAM, body: { data: SLICE_A } });
  assert.equal(r.status, 200);
  r = await call(tracker, { query: { key: A } });
  assert.deepEqual(r.body.data, SLICE_A);
});

test('locked per-client key: the client token reads its own key only, and cannot write it', async () => {
  await call(tracker, { method: 'POST', query: { key: A }, headers: TEAM, body: { data: SLICE_A } });
  await call(tracker, { method: 'POST', query: { key: B }, headers: TEAM, body: { data: SLICE_B } });
  const tokenA = await lock(A);
  const tokenB = await lock(B);

  // no token: nothing
  assert.equal((await call(tracker, { query: { key: A } })).status, 401);
  // own token: own key
  let r = await call(tracker, { query: { key: A }, headers: { 'x-client-token': tokenA } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, SLICE_A);
  // own token on another client's key: refused, no data in the answer
  r = await call(tracker, { query: { key: B }, headers: { 'x-client-token': tokenA } });
  assert.equal(r.status, 401);
  assert.equal(r.body.data, undefined);
  assert.ok(!JSON.stringify(r.body).includes('three'));
  // and the other way round
  assert.equal((await call(tracker, { query: { key: A }, headers: { 'x-client-token': tokenB } })).status, 401);

  // own token cannot overwrite own key
  r = await call(tracker, { method: 'POST', query: { key: A }, headers: { 'x-client-token': tokenA }, body: { data: { items: ['changed'] } } });
  assert.equal(r.status, 401);
  assert.deepEqual(__store.get(A), SLICE_A);

  // team reads and writes both
  r = await call(tracker, { query: { key: B }, headers: TEAM });
  assert.deepEqual(r.body.data, SLICE_B);
  r = await call(tracker, { method: 'POST', query: { key: A }, headers: TEAM, body: { data: { ...SLICE_A, items: ['new'] } } });
  assert.equal(r.status, 200);
  assert.deepEqual(__store.get(A).items, ['new']);
});

test('one client token on several of that client\'s keys: opens those, not the combined key', async () => {
  const shared = 'acme-client-token-0000000001';
  for (const key of ['readiness-cookaborough-v1', A]) await call(trackerLock, { method: 'POST', headers: TEAM, body: { key, token: shared } });
  await call(tracker, { method: 'POST', query: { key: ALL }, headers: TEAM, body: { data: { clients: { acme: SLICE_A, 'other co': SLICE_B } } } });
  await lock(ALL); // staff only: its generated token is thrown away

  assert.equal((await call(tracker, { query: { key: A }, headers: { 'x-client-token': shared } })).status, 200);
  const r = await call(tracker, { query: { key: ALL }, headers: { 'x-client-token': shared } });
  assert.equal(r.status, 401);
  assert.equal(r.body.data, undefined);
  assert.equal((await call(tracker, { query: { key: ALL }, headers: TEAM })).status, 200);
});

test('combined key keeps its behaviour: open until locked, writable when open', async () => {
  let r = await call(tracker, { method: 'POST', query: { key: ALL }, body: { data: { clients: {} } } });
  assert.equal(r.status, 200);
  r = await call(tracker, { query: { key: ALL } });
  assert.deepEqual(r.body.data, { clients: {} });
});

test('lock endpoint manages per-client keys with no ALLOWED_KEYS entry', async () => {
  let r = await call(trackerLock, { method: 'GET', headers: TEAM, query: { key: A } });
  assert.deepEqual(r.body, { ok: true, key: A, locked: false });
  r = await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: A, label: 'Acme hub' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.locked, true);
  r = await call(trackerLock, { method: 'POST', body: { key: A } });
  assert.equal(r.status, 401);
  r = await call(trackerLock, { method: 'DELETE', headers: TEAM, query: { key: A } });
  assert.equal(r.body.cleared, true);
  r = await call(trackerLock, { method: 'POST', headers: TEAM, body: { key: 'readiness-inputs--v1' } });
  assert.equal(r.status, 404);
});

test('team-only write does not touch other keys: an open listed key still saves with no headers', async () => {
  const r = await call(tracker, { method: 'POST', body: { key: 'readiness-cookaborough-v1', data: { a: 1 } } });
  assert.equal(r.status, 200);
});

test('per-client write is refused for everyone when the team passcode is not configured', async () => {
  const saved = process.env.KICKOFF_TEAM_TOKEN;
  delete process.env.KICKOFF_TEAM_TOKEN;
  try {
    const r = await call(tracker, { method: 'POST', query: { key: A }, headers: TEAM, body: { data: SLICE_A } });
    assert.equal(r.status, 401);
    assert.equal(__store.has(A), false);
  } finally {
    process.env.KICKOFF_TEAM_TOKEN = saved;
  }
});
