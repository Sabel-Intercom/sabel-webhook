// api/motion.js — read-only bridge between the Weekly Updates page and Motion.
//
// WHAT IT DOES: fetches tasks from Motion (using the secret MOTION_API_KEY held
// in Vercel), keeps only the ones completed since ?since= (default: last 7 days),
// and returns them as a tidy list. The Weekly Updates page groups them per client
// by the [Client] prefix Nikki puts at the start of each task title.
//
// SETUP:
//   1. Save this file as api/motion.js in the sabel-webhook repo.
//   2. In Vercel → sabel-webhook → Settings → Environment Variables, add
//        MOTION_API_KEY = <the key from Motion → Settings → API>
//      for the Production environment, then redeploy.
//   3. Test in a browser: https://sabel-webhook.vercel.app/api/motion
//      You should see JSON with { ok: true, tasks: [...] }.
//
// It never writes to Motion — read-only, GET only.

const MOTION_API = 'https://api.usemotion.com/v1/tasks';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const key = process.env.MOTION_API_KEY;
  if (!key) {
    return res.status(500).json({
      ok: false,
      error: 'MOTION_API_KEY is not set in Vercel environment variables.',
    });
  }

  // Window: tasks completed on/after ?since= (ISO date). Default: 7 days back.
  let since = req.query.since;
  if (!since) {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    since = d.toISOString();
  }
  const sinceMs = Date.parse(since);
  if (isNaN(sinceMs)) {
    return res.status(400).json({ ok: false, error: 'Bad ?since= date. Use ISO format, e.g. 2026-07-20' });
  }

  try {
    const collected = [];
    let cursor = null;
    // Page through Motion's task list (capped at 5 pages to stay well inside
    // Motion's rate limits). includeAllStatuses=true is essential: Motion
    // excludes completed tasks by default, and completed is exactly what we want.
    for (let page = 0; page < 5; page++) {
      let url = MOTION_API + '?includeAllStatuses=true';
      if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
      const r = await fetch(url, { headers: { 'X-API-Key': key, 'Accept': 'application/json' } });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        return res.status(502).json({
          ok: false,
          error: 'Motion API returned ' + r.status + '. ' + body.slice(0, 300),
        });
      }
      const j = await r.json();
      const tasks = Array.isArray(j.tasks) ? j.tasks : (Array.isArray(j) ? j : []);
      collected.push(...tasks);
      cursor = j.meta && j.meta.nextCursor ? j.meta.nextCursor : null;
      if (!cursor) break;
    }

    // Keep only tasks that are completed, finished within the window.
    const done = collected.filter((t) => {
      const isDone = t.completed === true || (t.status && t.status.isResolvedStatus === true);
      if (!isDone) return false;
      const when = Date.parse(t.completedTime || t.updatedTime || t.lastInteractedTime || '');
      return !isNaN(when) && when >= sinceMs;
    });

    // Tidy shape for the Weekly Updates page.
    const out = done.map((t) => ({
      id: t.id,
      title: t.name || '',
      project: (t.project && t.project.name) || '',
      workspace: (t.workspace && t.workspace.name) || '',
      assignee: (Array.isArray(t.assignees) && t.assignees[0] && (t.assignees[0].name || t.assignees[0].email)) || '',
      completedAt: t.completedTime || t.updatedTime || null,
    }));

    res.setHeader('Cache-Control', 's-maxage=120');
    // "scanned" = how many tasks Motion returned before filtering — useful for
    // diagnosing "count: 0" (scanned 0 = fetch problem; scanned > 0 = filter).
    return res.status(200).json({ ok: true, since: since, scanned: collected.length, count: out.length, tasks: out });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
