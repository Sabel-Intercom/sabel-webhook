// -------------------------------------------------------------
// Team gate (10 Nov 2026).
//
// For endpoints that return internal Sabel data (contracts, tasks, client
// feedback). The request must carry the team passcode in X-Team-Token
// (= KICKOFF_TEAM_TOKEN in Vercel). Internal pages on
// hubs.sabelcustomersuccess.com add it automatically after Cloudflare sign-in
// (hub-auth.js data-team); scripts read it from the Keychain.
//
// FAIL CLOSED: if KICKOFF_TEAM_TOKEN is not set, every request is refused.
// -------------------------------------------------------------
import { isTeamRequest } from './tracker-lock.js';

export const TEAM_HEADERS = 'Content-Type, X-Team-Token';

// Returns true when the request may proceed. Otherwise the refusal has
// already been sent and the handler must return.
//
// Every gated response, allowed or refused, is marked private and uncacheable
// and varies on the passcode header. Without this a CDN could store an
// allowed answer and hand it to the next caller who has no passcode.
export function requireTeam(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'X-Team-Token');
  if (!process.env.KICKOFF_TEAM_TOKEN) {
    res.status(503).json({ ok: false, error: 'KICKOFF_TEAM_TOKEN is not set in Vercel; this endpoint is closed.' });
    return false;
  }
  if (!isTeamRequest(req)) {
    res.status(401).json({ ok: false, error: 'Team passcode required' });
    return false;
  }
  return true;
}
