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
  async lpush(k, ...vs) {
    const cur = store.get(k);
    if (cur !== undefined && !Array.isArray(cur)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    const list = cur || [];
    list.unshift(...vs.reverse());
    store.set(k, list);
    return list.length;
  }
  async lrange(k, start, stop) {
    const cur = store.get(k);
    if (cur === undefined) return [];
    if (!Array.isArray(cur)) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return cur.slice(start, stop === -1 ? undefined : stop + 1);
  }
}

export const __store = store;
