# Sabel Intake Webhook

Receives Formspree submissions → generates two branded DOCX files → emails them to the team automatically.

---

## How it works

1. Kobe completes the WorkInitiatives kickoff form and clicks Submit
2. Formspree receives the submission and fires a webhook to this Vercel function
3. The function parses all 70 form fields
4. Generates two DOCX files: Internal Delivery Plan and Kickoff Summary
5. Emails both as attachments to `info@sabelcustomersuccess.com` and `project-admin@sabelcustomersuccess.com`

Total time from submission to email in inbox: under 10 seconds.

---

## One-time setup

### Step 1 — Resend account (free)

1. Go to [resend.com](https://resend.com) and create a free account
2. Go to **Domains** → **Add Domain** → add `sabelcustomersuccess.com`
3. Follow the DNS instructions (add the TXT and MX records Resend gives you)
   - This takes 5–10 minutes once the records are added
4. Go to **API Keys** → **Create API Key**
5. Copy the key — you will need it in Step 3

> **While waiting for domain verification:** set `EMAIL_FROM=onboarding@resend.dev` in your environment variables. This lets you test immediately. Switch to your verified domain once DNS is confirmed.

### Step 2 — Vercel project (free)

1. Go to [vercel.com](https://vercel.com) and sign up with your GitHub account
2. Click **Add New → Project**
3. Import the `sabel-food/Intake-forms` repository (or create a new repo and push this folder)
   - If using a new repo: push the contents of this folder to a repo called `sabel-webhook`
4. Vercel detects the `api/` folder automatically — no framework needed
5. Click **Deploy**

### Step 3 — Environment variables in Vercel

In your Vercel project → **Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | Your Resend API key from Step 1 |
| `EMAIL_FROM` | `onboarding@resend.dev` (testing) or `noreply@sabelcustomersuccess.com` (production) |
| `EMAIL_PRIMARY` | `info@sabelcustomersuccess.com` |
| `EMAIL_CC` | `project-admin@sabelcustomersuccess.com` |
| `FORMSPREE_SECRET` | Leave blank for now — add later for security |

After adding variables, click **Redeploy** (top right in Vercel).

### Step 4 — Connect Formspree webhook

1. Log into [formspree.io](https://formspree.io)
2. Open the **Project intake** form (ID: `xvzwjwzv`)
3. Go to **Settings → Webhooks**
4. Click **Add Webhook**
5. Enter your Vercel function URL:
   ```
   https://your-project-name.vercel.app/api/webhook
   ```
   (Vercel shows you the exact URL after deployment — copy it from the project dashboard)
6. Save

### Step 5 — Test it

Submit the intake form with test data. Within 10 seconds, both DOCX files should arrive in the `info@` inbox as email attachments.

---

## Troubleshooting

**"Email delivery failed"** — Check that `RESEND_API_KEY` is set correctly in Vercel env vars and the domain is verified in Resend.

**"Document generation failed"** — Check the Vercel function logs (Vercel dashboard → Functions → webhook → View logs).

**Webhook not firing** — Make sure the Formspree webhook URL is correct and points to `/api/webhook` (not just the root).

**Resend free tier limits** — 3,000 emails/month, 100/day. More than enough for intake forms.

---

## File structure

```
api/
  webhook.js          ← Vercel serverless function (main handler)
lib/
  brand.js            ← Shared brand tokens, DOCX helpers
  generate-plan.js    ← Internal Delivery Plan generator
  generate-summary.js ← Kickoff Summary generator
  logo.js             ← Sabel logo as embedded base64
package.json
vercel.json           ← Sets 30s function timeout
.env.example          ← Copy to .env for local development
```

---

## Local development

```bash
npm install
npm install -g vercel
vercel dev
```

Then POST to `http://localhost:3000/api/webhook` with a Formspree-style JSON body to test locally.

---

## Tracker store: per-key locks

`/api/tracker` stores each tracker, hub and form under a key in Upstash Redis. By default a key is open: anyone who knows it can read and write. A key can be **locked** so it answers only to the team passcode or to that client's own token.

| Request | Open key | Locked key |
|---|---|---|
| `GET/POST /api/tracker?key=…` with no headers | works | `401 { locked: true }` |
| … with `X-Client-Token: <that key's token>` | works | works |
| … with `X-Team-Token: <KICKOFF_TEAM_TOKEN>` | works | works |

Locks are managed through `/api/tracker-lock`, which always needs `X-Team-Token`:

```
GET    /api/tracker-lock                 list locked keys
GET    /api/tracker-lock?key=<k>         { locked, setAt, label }
POST   /api/tracker-lock  { key, token?, label? }
                                         lock <k>. With no token, one is generated and
                                         returned ONCE; only its SHA-256 is stored.
DELETE /api/tracker-lock?key=<k>         clear the lock
```

Switching a client over:

1. `POST /api/tracker-lock { key: "<client>-tracker-v1", label: "<Client> hub" }` with the team passcode. Copy the `token` from the response.
2. Rebuild the client's hub with that token sent as `X-Client-Token` on every `/api/tracker` call (reads and saves, including the forms inside the hub). Publish it behind Cloudflare Access.
3. Repeat for the client's other keys (`readiness-<client>-v1`, `migration-intake-<client>-v1`).

Rotating a token is step 1 again with no token: the old one stops the moment the new hash lands, so rebuild first. Keys with no lock are untouched, so clients move one at a time.

Team pages and automations that read a locked key (Internal Ops, Task Hub, Ops Hub, Fly sync, SwiftBar) must send `X-Team-Token`.

Tests: `npm test` (no Upstash needed; Redis is mocked in memory).
