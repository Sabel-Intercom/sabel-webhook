// The calculator posts quotes from the hubs site and, for now, the older
// GitHub Pages site. Only those two origins are named in the CORS header.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/quote-notify.js';

const HUBS = 'https://hubs.sabelcustomersuccess.com';
const PAGES = 'https://sabel-intercom.github.io';

async function preflight(origin) {
  const headers = {};
  const res = {
    statusCode: 0,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    end() { return this; }, json() { return this; },
  };
  await handler({ method: 'OPTIONS', headers: origin === undefined ? {} : { origin } }, res);
  return { status: res.statusCode, headers };
}

test('preflight names the caller when it is one of the two calculator sites', async () => {
  for (const o of [HUBS, PAGES]) {
    const r = await preflight(o);
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], o);
    assert.equal(r.headers['vary'], 'Origin');
  }
});

test('any other origin is never named', async () => {
  for (const o of [undefined, '', 'null', 'https://example.com', 'http://hubs.sabelcustomersuccess.com',
    'https://hubs.sabelcustomersuccess.com.example.com', 'https://evil-sabel-intercom.github.io', 'https://sabel-intercom.github.io.example.com']) {
    const r = await preflight(o);
    assert.equal(r.headers['access-control-allow-origin'], HUBS, String(o));
  }
});
