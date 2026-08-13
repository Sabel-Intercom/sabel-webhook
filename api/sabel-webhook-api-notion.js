// api/notion.js — drop this into the sabel-webhook project alongside api/motion.js
//
// Replaces the Motion bridge for the Weekly Updates screen. Same shape as
// api/motion.js so the front end treats them the same way.
//
//   GET /api/notion?since=2026-08-10T00:00:00.000Z
//   -> { ok, since, scanned, count, tasks: [ {...} ] }
//
// Each task:
//   { id, title, trackerKey, trackerTaskId, owner, status, clientSide, completedAt, url }
//
// completedAt is Notion's last_edited_time. The Tasks database has no
// "completed on" property, so a task counts as completed this week if its
// status is Complete/Done AND it was last touched inside the window. Good
// enough in practice; re-editing an old completed task will pull it back in.
// If that ever becomes annoying, add a real "Completed on" date property and
// switch DATE_FILTER below to use it.
//
// Env: NOTION_TOKEN — an internal integration token with read access to the
// Sabel Ops > Tasks database. Share the database with the integration in
// Notion, otherwise every query comes back empty with no error.

const NOTION_DB = '3b6335ee-d1ea-81fa-86ff-e2c08605d805';   // Sabel Ops › Tasks
const NOTION_VERSION = '2022-06-28';
const DONE_STATUSES = ['Complete', 'Done'];

function txt(prop) {
  if (!prop) return '';
  if (prop.type === 'title') return (prop.title || []).map(t => t.plain_text).join('').trim();
  if (prop.type === 'rich_text') return (prop.rich_text || []).map(t => t.plain_text).join('').trim();
  if (prop.type === 'select') return prop.select ? prop.select.name : '';
  if (prop.type === 'formula') return prop.formula ? (prop.formula.string || '') : '';
  return '';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({ ok: false, error: 'NOTION_TOKEN is not set on the server.' });
  }

  // Default window: the last 7 days.
  const since = req.query.since || new Date(Date.now() - 7 * 864e5).toISOString();

  const filter = {
    and: [
      { or: DONE_STATUSES.map(s => ({ property: 'Status', select: { equals: s } })) },
      { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } }
    ]
  };

  try {
    const tasks = [];
    let cursor, scanned = 0;

    do {
      const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB}/query`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ filter, page_size: 100, start_cursor: cursor })
      });

      if (!r.ok) {
        const detail = await r.text();
        return res.status(502).json({ ok: false, error: `Notion returned ${r.status}: ${detail.slice(0, 300)}` });
      }

      const j = await r.json();
      scanned += (j.results || []).length;

      for (const p of j.results || []) {
        const props = p.properties || {};
        const trackerTaskId = txt(props['Tracker task id']);
        tasks.push({
          id: p.id,
          title: txt(props['Title']),
          trackerKey: txt(props['Tracker key']),
          trackerTaskId,
          owner: txt(props['Owner']),
          status: txt(props['Status']),
          // '<key>:<phase>-c-<n>' is a client-owned task, '-s-' is ours.
          clientSide: /-c-\d+$/.test(trackerTaskId),
          completedAt: p.last_edited_time,
          url: p.url
        });
      }

      cursor = j.has_more ? j.next_cursor : null;
    } while (cursor);

    tasks.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
    return res.status(200).json({ ok: true, since, scanned, count: tasks.length, tasks });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e && e.message || e) });
  }
};
