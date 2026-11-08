// In-memory stand-in for the subset of @upstash/redis the tracker routes use.
const store = new Map();

export class Redis {
  static fromEnv() { return new Redis(); }
  async get(k) { return store.has(k) ? structuredClone(store.get(k)) : null; }
  async set(k, v) { store.set(k, structuredClone(v)); return 'OK'; }
  async del(...ks) { let n = 0; for (const k of ks) if (store.delete(k)) n++; return n; }
  async keys(pattern) {
    const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return [...store.keys()].filter(k => re.test(k));
  }
  async mget(...ks) { return ks.map(k => (store.has(k) ? structuredClone(store.get(k)) : null)); }
}

export const __store = store;
