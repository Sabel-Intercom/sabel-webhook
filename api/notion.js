// api/notion.js — read-only bridge between the Weekly Updates page and Notion.
//
// WHAT IT DOES: fetches tasks from the Sabel Ops › Tasks database (using the
// secret NOTION_TOKEN held in Vercel), keeps the ones marked Complete/Done that
// were touched since ?since= (default: last 7 days), and returns them as a tidy
// list. Replaces api/motion.js for the Friday recap.
//
// The Weekly Updates page groups them per client by the "Tracker key" property,
// so there is no name matching to go wrong.
//
// SETUP:
//   1. Save this file as api/notion.js in the sabel-webhook repo.
//   2. In Notion, create an internal integration and copy its secret:
//        Settings → Connections → Develop or manage integrations
//        → New integration → Internal → copy the Internal Integration Secret
//   3. Share the Tasks database with that integration, or every query comes
//      back empty with no error:
//        open Sabel Ops → Tasks → ••• (top right) → Connections → Connect to
//        → pick your integration
//   4. In Vercel → sabel-webhook → Settings → Environment Variables, add
//        NOTION_TOKEN = <the secret from step 2>
//      for Production, then redeploy.
//   5. Test in a browser: https://sabel-webhook.vercel.app/api/notion
//      You should see JSON with { ok: true, tasks: [...] }.
//
// It never writes to Notion — read-only, GET only.

// Two databases, one endpoint:
//   /api/notion                  → tasks completed since ?since=  (Weekly Updates)
//   /api/notion?kind=projects    → contract/SOW detail per client (Client Contracts)
// Both need sharing with the integration separately — sharing Tasks does not
// share Projects. Connect the parent "Sabel Ops" page to cover both at once.
const NOTION_DB = '3b6335ee-d1ea-81fa-86ff-e2c08605d805';       // Sabel Ops › Tasks
const PROJECTS_DB = '3b6335ee-d1ea-81ff-b67c-f8ee42ec5bd0';     // Sabel Ops › Projects
const NOTION_VERSION = '2022-06-28';
const DONE_STATUSES = ['Complete', 'Done'];

// The Tasks database has no "completed on" property — Dates is the *scheduled*
// date. So a task counts as completed this week if its status is Complete/Done
// and Notion last touched it inside the window. Good enough in practice;
// re-editing an old completed task will pull it back in. If that gets noisy,
// add a real "Completed on" date property and swap the timestamp filter below.

function txt(prop) {
  if (!prop) return '';
  if (prop.type === 'title')     return (prop.title || []).map(t => t.plain_text).join('').trim();
  if (prop.type === 'rich_text') return (prop.rich_text || []).map(t => t.plain_text).join('').trim();
  if (prop.type === 'select')    return prop.select ? prop.select.name : '';
  if (prop.type === 'formula')   return prop.formula ? (prop.formula.string || '') : '';
  if (prop.type === 'url')       return prop.url || '';
  return '';
}
function num(prop) {
  return prop && prop.type === 'number' && prop.number != null ? prop.number : null;
}

// Page through a Notion database query, returning every row.
async function queryAll(db, token, filter) {
  const rows = [];
  let cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${db}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(filter ? { filter, page_size: 100, start_cursor: cursor }
                                  : { page_size: 100, start_cursor: cursor })
    });
    if (!r.ok) {
      const detail = await r.text();
      const hint = r.status === 404
        ? ' — check this database is shared with the integration (••• → Connections).'
        : '';
      const err = new Error(`Notion returned ${r.status}: ${detail.slice(0, 300)}${hint}`);
      err.status = 502;
      throw err;
    }
    const j = await r.json();
    rows.push(...(j.results || []));
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return rows;
}

// Contract / SOW detail per client, for the Client Contracts screen.
// Row names read "<Client> delivery"; the trailing word is dropped so they match
// the client names used by the trackers and the portal.
async function projects(token, res) {
  const rows = await queryAll(PROJECTS_DB, token);
  const out = rows.map(p => {
    const q = p.properties || {};
    return {
      id: p.id,
      url: p.url,
      name: txt(q['Name']).replace(/\s+delivery$/i, '').trim(),
      status: txt(q['Status']),
      trackerKey: txt(q['Tracker key']),
      trackerUrl: txt(q['Tracker URL']),
      hours: num(q['Contract hours']),
      // Contract terms run 12 months from this date; the expiry watch derives from it.
      contractStart: q['Contract start'] && q['Contract start'].date
        ? q['Contract start'].date.start : '',
      hoursNote: txt(q['Hours note']),
      scope: txt(q['Scope']),
      signed: txt(q['Signed']),
      signedSource: txt(q['Signed source']),
      kickoff: txt(q['Kick-off']),
      contact: txt(q['Main contact']),
      contactRole: txt(q['Contact role']),
      migration: txt(q['Migration']),
      migrationHours: txt(q['Migration hours']),
      migrationNote: txt(q['Migration note'])
    };
  }).sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1));

  return res.status(200).json({ ok: true, count: out.length, projects: out });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    return res.status(500).json({
      ok: false,
      error: 'NOTION_TOKEN is not set. Add it in Vercel → Settings → Environment Variables, then redeploy.'
    });
  }

  if (req.query.kind === 'projects') {
    try {
      return await projects(token, res);
    } catch (e) {
      return res.status(e.status || 500).json({ ok: false, error: String((e && e.message) || e) });
    }
  }

  let since = req.query.since;
  if (!since) {
    since = new Date(Date.now() - 7 * 864e5).toISOString();
  } else if (isNaN(Date.parse(since))) {
    return res.status(400).json({ ok: false, error: 'Bad ?since= date. Use ISO format, e.g. 2026-08-10' });
  }

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
        // 404 here almost always means the database has not been shared with
        // the integration, rather than a wrong id.
        const hint = r.status === 404
          ? ' — check the Tasks database is shared with the integration (••• → Connections).'
          : '';
        return res.status(502).json({
          ok: false,
          error: `Notion returned ${r.status}: ${detail.slice(0, 300)}${hint}`
        });
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
          // '<key>:<phase>-c-<n>' is a client-owned task, '-s-' is one of ours.
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
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
}
