import { Redis } from '@upstash/redis';

const redis = Redis.fromEnv();

// Sabel client feedback endpoint.
// Submissions are appended to a Redis list so nothing is ever overwritten.
//   save:  POST /api/feedback  { key, entry }        -> { ok: true }
//   load:  GET  /api/feedback?key=sabel-feedback-v1  -> { ok: true, entries: [...] }
//          optional &since=ISO-timestamp to return only newer entries
//
// Optional instant Slack alert: set SLACK_FEEDBACK_WEBHOOK in Vercel env vars
// (Slack > Apps > Incoming Webhooks) and every submission pings Slack immediately.
//
// SECURITY (10 Nov 2026):
//   - Only the keys in FEEDBACK_KEYS are accepted. Before this, any key name
//     worked, so anyone could read or append to any list in the store.
//   - GET (reading what clients said) is TEAM ONLY: X-Team-Token, see
//     lib/team-gate.js. POST stays open: clients submit the form signed out.
//   - A submission must be a JSON object of at most MAX_ENTRY_BYTES.
import { requireTeam, TEAM_HEADERS } from '../lib/team-gate.js';

export const FEEDBACK_KEYS = ['sabel-feedback-v1'];
export const MAX_ENTRY_BYTES = 20000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', TEAM_HEADERS);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    if (!requireTeam(req, res)) return;
    try {
      const key = req.query.key;
      if (!key) return res.status(400).json({ ok: false, error: 'No key provided' });
      if (!FEEDBACK_KEYS.includes(key)) return res.status(404).json({ ok: false, error: 'Unknown feedback key' });
      const raw = await redis.lrange(key, 0, -1);
      let entries = raw.map(e => (typeof e === 'string' ? JSON.parse(e) : e));
      if (req.query.since) {
        entries = entries.filter(e => e.ts && e.ts > req.query.since);
      }
      return res.status(200).json({ ok: true, count: entries.length, entries });
    } catch (err) {
      console.error('Feedback GET error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  if (req.method === 'POST') {
    try {
      const { key, entry } = req.body || {};
      if (!key || !entry) return res.status(400).json({ ok: false, error: 'Missing key or entry' });
      if (!FEEDBACK_KEYS.includes(key)) return res.status(404).json({ ok: false, error: 'Unknown feedback key' });
      if (typeof entry !== 'object' || Array.isArray(entry)) return res.status(400).json({ ok: false, error: 'entry must be an object' });
      if (JSON.stringify(entry).length > MAX_ENTRY_BYTES) return res.status(413).json({ ok: false, error: 'Submission too large' });
      await redis.lpush(key, JSON.stringify(entry));

      // Optional instant Slack notification
      if (process.env.SLACK_FEEDBACK_WEBHOOK) {
        const stars = n => (n ? '★'.repeat(n) + '☆'.repeat(5 - n) : 'not rated');
        const c = entry.consent || {};
        const perms = [
          c.intercom && 'Intercom/Fin',
          c.marketing && 'Marketing',
          c.social && 'LinkedIn/Social',
          c.anonymise && 'ANONYMISE',
          c.casestudy && 'Case study OK'
        ].filter(Boolean).join(', ') || 'None given';
        const text =
          `:tada: *New client feedback received*\n` +
          `*${entry.name}*${entry.role ? ', ' + entry.role : ''} — *${entry.company}*\n` +
          `NPS: *${entry.nps}/10* · Overall: ${stars(entry.ratings?.r_overall)}\n` +
          `Permissions: ${perms}\n` +
          (entry.testimonial ? `>"${entry.testimonial}"\n` : '') +
          (entry.referral?.name ? `:handshake: *Referral:* ${entry.referral.name}${entry.referral.contact ? ' (' + entry.referral.contact + ')' : ''}${entry.referral.mention_ok ? ', name-drop OK' : ', do not mention their name'}\n` : '') +
          (entry.improve_internal_only ? `_Internal-only note included — check the full entry._` : '');
        await fetch(process.env.SLACK_FEEDBACK_WEBHOOK, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        }).catch(e => console.error('Slack webhook error:', e));
      }

      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Feedback POST error:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
