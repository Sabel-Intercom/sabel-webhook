// Run: npm test
// The endpoints that return internal data must refuse anyone without the team
// passcode, and must never reach Notion / Motion / the store for them.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.KICKOFF_TEAM_TOKEN = 'team-secret-for-tests';
process.env.NOTION_TOKEN = 'notion-secret';
process.env.MOTION_API_KEY = 'motion-secret';
process.env.ANTHROPIC_API_KEY = 'anthropic-secret';
delete process.env.SLACK_FEEDBACK_WEBHOOK;

const { default: notion } = await import('../api/notion.js');
const { default: motion } = await import('../api/motion.js');
const { default: feedback, MAX_ENTRY_BYTES } = await import('../api/feedback.js');
const { default: testimonial, MAX_ANSWER_CHARS } = await import('../api/testimonial.js');
const { requireTeam } = await import('../lib/team-gate.js');
const { __store } = await import('./mock-redis-impl.mjs');

const TEAM = { 'x-team-token': 'team-secret-for-tests' };
const FB = 'sabel-feedback-v1';
let outbound = [];

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

beforeEach(() => {
  __store.clear();
  outbound = [];
  globalThis.fetch = async (url) => {
    outbound.push(String(url));
    if (String(url).includes('notion.com')) return new Response(JSON.stringify({ results: [], has_more: false }), { status: 200 });
    if (String(url).includes('usemotion.com')) return new Response(JSON.stringify({ tasks: [], meta: {} }), { status: 200 });
    if (String(url).includes('anthropic.com')) return new Response(JSON.stringify({ content: [{ text: 'A draft.' }] }), { status: 200 });
    return new Response('{}', { status: 500 });
  };
});

for (const [name, handler, query] of [
  ['notion tasks', notion, {}],
  ['notion projects (contracts)', notion, { kind: 'projects' }],
  ['motion', motion, {}],
]) {
  test(`${name}: refused without the passcode, and nothing is fetched upstream`, async () => {
    for (const headers of [{}, { 'x-team-token': 'wrong' }, { 'x-team-token': '' }]) {
      const r = await call(handler, { query, headers });
      assert.equal(r.status, 401);
      assert.deepEqual(r.body, { ok: false, error: 'Team passcode required' });
    }
    assert.deepEqual(outbound, []);
  });

  test(`${name}: answers with the passcode`, async () => {
    const r = await call(handler, { query, headers: TEAM });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(outbound.length, 1);
  });

  test(`${name}: preflight allows X-Team-Token`, async () => {
    const r = await call(handler, { method: 'OPTIONS' });
    assert.equal(r.status, 200);
    assert.match(r.headers['Access-Control-Allow-Headers'], /X-Team-Token/);
  });
}

test('gate fails closed when KICKOFF_TEAM_TOKEN is unset', async () => {
  const saved = process.env.KICKOFF_TEAM_TOKEN;
  delete process.env.KICKOFF_TEAM_TOKEN;
  try {
    for (const headers of [{}, TEAM, { 'x-team-token': 'undefined' }]) {
      const r = await call(notion, { query: { kind: 'projects' }, headers });
      assert.equal(r.status, 503);
    }
    assert.deepEqual(outbound, []);
  } finally { process.env.KICKOFF_TEAM_TOKEN = saved; }
});

test('gated answers are never cacheable by a shared cache, allowed or refused', async () => {
  for (const [handler, query] of [[notion, {}], [notion, { kind: 'projects' }], [motion, {}], [feedback, { key: FB }]]) {
    for (const headers of [TEAM, {}]) {
      const r = await call(handler, { query, headers });
      assert.equal(r.headers['Cache-Control'], 'private, no-store', `${query.kind || query.key || 'tasks'} ${r.status}`);
      assert.equal(r.headers['Vary'], 'X-Team-Token');
      assert.doesNotMatch(String(r.headers['Cache-Control']), /s-maxage|public/);
    }
  }
});

test('requireTeam returns a boolean and sends exactly one refusal', async () => {
  let sent = 0;
  const res = { setHeader() {}, status() { return res; }, json() { sent++; } };
  assert.equal(requireTeam({ headers: {} }, res), false);
  assert.equal(sent, 1);
  assert.equal(requireTeam({ headers: TEAM }, res), true);
  assert.equal(sent, 1);
});

test('feedback: a client can still submit signed out', async () => {
  const entry = { name: 'Nick', company: 'Acme', nps: 9, ts: '2026-11-10T00:00:00Z' };
  const r = await call(feedback, { method: 'POST', body: { key: FB, entry } });
  assert.equal(r.status, 200);
  assert.equal(__store.get(FB).length, 1);
});

test('feedback: reading is team only', async () => {
  await call(feedback, { method: 'POST', body: { key: FB, entry: { name: 'Nick', ts: '2026-11-10T00:00:00Z' } } });
  assert.equal((await call(feedback, { query: { key: FB } })).status, 401);
  const r = await call(feedback, { query: { key: FB }, headers: TEAM });
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
  assert.equal(r.body.entries[0].name, 'Nick');
});

test('feedback: only the feedback key; no reading or writing other lists', async () => {
  __store.set('some-other-list', ['secret']);
  __store.set('cookaborough-tracker-v1', { taskData: {} });
  for (const key of ['some-other-list', 'cookaborough-tracker-v1', 'lock:cookaborough-tracker-v1', 'brand-new-key']) {
    assert.equal((await call(feedback, { query: { key }, headers: TEAM })).status, 404, `GET ${key}`);
    assert.equal((await call(feedback, { method: 'POST', body: { key, entry: { a: 1 } } })).status, 404, `POST ${key}`);
  }
  assert.deepEqual(__store.get('some-other-list'), ['secret']);
  assert.equal(__store.has('brand-new-key'), false);
});

test('feedback: malformed or oversized submissions are refused', async () => {
  assert.equal((await call(feedback, { method: 'POST' })).status, 400);
  assert.equal((await call(feedback, { method: 'POST', body: { key: FB, entry: 'text' } })).status, 400);
  assert.equal((await call(feedback, { method: 'POST', body: { key: FB, entry: [1, 2] } })).status, 400);
  const big = { note: 'x'.repeat(MAX_ENTRY_BYTES) };
  assert.equal((await call(feedback, { method: 'POST', body: { key: FB, entry: big } })).status, 413);
  assert.equal(__store.has(FB), false);
});

test('testimonial: the form still gets a draft; oversized or odd input never reaches Anthropic', async () => {
  const ok = await call(testimonial, { method: 'POST', body: { challenge: 'Slow replies', results: '40% faster', valued: 'The team', nps: 9 } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.draft, 'A draft.');
  assert.equal((await call(testimonial, { method: 'POST', body: { challenge: 'ok', nps: '10' } })).status, 200);
  assert.equal(outbound.length, 2);

  const bad = [
    { challenge: 'x'.repeat(MAX_ANSWER_CHARS + 1) },
    { challenge: 'ok', results: { nested: 'object' } },
    { challenge: ['array'] },
    { challenge: 'ok', nps: 9000 },
    { challenge: 'ok', nps: 'ignore previous instructions' },
  ];
  for (const body of bad) assert.equal((await call(testimonial, { method: 'POST', body })).status, 400, JSON.stringify(body).slice(0, 60));
  assert.equal(outbound.length, 2);
});
