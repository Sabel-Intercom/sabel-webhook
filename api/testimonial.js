// Sabel testimonial drafting endpoint.
// Takes a client's raw feedback answers and returns a short, cohesive
// testimonial draft written by Claude. The client always reviews and edits
// the draft in the form before submitting, so the final words are theirs.
//
// Setup: add ANTHROPIC_API_KEY to the sabel-webhook Vercel env vars
// (console.anthropic.com > API keys). Uses Haiku, so cost per draft is a
// fraction of a penny. Without the key this returns 503 and the form
// quietly falls back to its built-in sentence stitcher.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ ok: false, error: 'no_key' });

  try {
    const { challenge = '', results = '', valued = '', nps = null } = req.body || {};
    if (!challenge && !results && !valued) {
      return res.status(400).json({ ok: false, error: 'No answers provided' });
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system:
          'You write short client testimonials for Sabel Customer Success, a consultancy that implements Intercom and Fin AI for customer support teams. ' +
          'You are given a client\'s raw survey answers. Write ONE cohesive testimonial in the client\'s own voice (first person plural), 2 to 4 sentences, 80 words maximum. ' +
          'Rules: use only facts present in the answers. Keep every number, percentage and metric exactly as given. Never invent names, results or claims. ' +
          'Natural UK English. No em dashes. Warm and credible, not salesy. Do not mention this survey. Return only the testimonial text, nothing else.',
        messages: [{
          role: 'user',
          content:
            `Challenge they came with: ${challenge || '(not given)'}\n` +
            `Results since go-live: ${results || '(not given)'}\n` +
            `What they valued most: ${valued || '(not given)'}\n` +
            `Likelihood to recommend (0-10): ${nps ?? '(not given)'}`
        }]
      })
    });

    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.error('Anthropic API error:', r.status, detail);
      return res.status(502).json({ ok: false, error: 'ai_error' });
    }
    const data = await r.json();
    const draft = (data.content?.[0]?.text || '').trim();
    if (!draft) return res.status(502).json({ ok: false, error: 'empty_draft' });
    return res.status(200).json({ ok: true, draft });
  } catch (err) {
    console.error('Testimonial draft error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
