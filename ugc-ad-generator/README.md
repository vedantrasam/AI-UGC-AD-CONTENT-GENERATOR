# UGC Ad Generator

An AI prompt system that produces UGC-style ad content (the casual, creator-style videos that outperform polished ads) for Instagram Reels, TikTok, and YouTube Shorts. Give it a brand, and it returns scroll-stopping hooks, full scripts, platform-specific versions, CTAs, captions, and A/B variants, ready to hand to a creator or a media buyer.

It ships as a small web app (Node + Express) so you can run every stage live, plus the prompts and a worked example as plain files. It works with **Google Gemini** (including the free tier) or **Anthropic Claude**: use whichever API key you have.

## What it does

| Stage | Prompt file | Output |
|---|---|---|
| 1. Hooks | `prompts/01_hook_generator.md` | 8 hooks, each from a different angle (skeptic, callout, curiosity, confession, before/after, question, bold claim, POV) |
| 2. Script | `prompts/02_script_generator.md` | 30 to 45 second script: hook, problem, agitation, solution, soft CTA, with on-screen text and camera notes |
| 3. Platforms | `prompts/03_platform_adapter.md` | The same script adapted for Reels, TikTok, and Shorts (pacing, runtime, text overlays) |
| 4. CTAs and captions | `prompts/04_cta_caption_generator.md` | 3 captions, short and long CTAs, tiered hashtags |
| 5. A/B variants | `prompts/05_ab_variation_generator.md` | Results-led, price-led, and emotion-led variants with test hypotheses |

The prompt files are the single source of truth: the server reads them at startup, so editing a prompt in `prompts/` changes what the app does.

## Quick start (run locally)

Requires [Node.js 18+](https://nodejs.org) and one API key: a free [Google Gemini key](https://aistudio.google.com/apikey) **or** an [Anthropic Claude key](https://console.anthropic.com).

```bash
git clone https://github.com/<your-username>/ugc-ad-generator.git
cd ugc-ad-generator
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

Open `.env` and set the key you have (only one is needed):

```
GEMINI_API_KEY=AIza...        # Google Gemini
# or
ANTHROPIC_API_KEY=sk-ant-...  # Anthropic Claude
```

Then:

```bash
npm start
```

Open **http://localhost:3000**. Do not open `public/index.html` by double-clicking it; the page needs the server to reach Claude.

## Deploy to Render

1. Push this repo to GitHub (steps below).
2. In [Render](https://render.com), choose **New → Blueprint**, select your repo, and approve. Render reads `render.yaml` and sets everything up.
   *Prefer manual setup?* Choose **New → Web Service**, connect the repo, and use: Runtime `Node`, Build Command `npm install`, Start Command `npm start`, Health Check Path `/healthz`.
3. When prompted (or under **Environment** in the dashboard), add:
   - `GEMINI_API_KEY` (if you have a Gemini key) **or** `ANTHROPIC_API_KEY` (if you have a Claude key). One is required.
   - `ACCESS_CODE`: any password you choose (strongly recommended, see Security)
4. Click deploy. When it shows **Live**, open your `https://<name>.onrender.com` URL.

Free-tier note: Render free instances sleep after about 15 minutes of inactivity, so the first visit after a quiet period can take up to a minute to wake up. Paid instances stay on.

### Push to GitHub

```bash
git init
git add .
git commit -m "UGC ad generator: prompt system, web app, worked example"
git branch -M main
git remote add origin https://github.com/<your-username>/ugc-ad-generator.git
git push -u origin main
```

`.gitignore` already excludes `.env` and `node_modules`. Run `git status` before pushing and confirm `.env` is not listed.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | One key required | none | Your Google Gemini API key. Stays on the server. |
| `ANTHROPIC_API_KEY` | One key required | none | Your Anthropic Claude API key. Stays on the server. |
| `PROVIDER` | No | auto | `gemini` or `anthropic`. Normally detected from whichever key is set. |
| `ACCESS_CODE` | No (recommended) | empty | If set, the page asks for this code and the API rejects requests without it. |
| `MODEL` | No | `gemini-3.8-flash` (Gemini) / `claude-sonnet-5-5` (Claude) | Model used for all stages. Change it if your account uses a different one. |
| `GEMINI_THINKING` | No | `minimal` | How much the newer Gemini models "think" before answering. `minimal` is fastest; use `low`, `medium`, `high`, or `default` to leave the model's own setting. |
| `UPSTREAM_TIMEOUT_MS` | No | `45000` (Gemini) / `90000` (Claude) | How long to wait for the AI per attempt before retrying. |
| `FALLBACK_MODEL` | No | none | Backup Gemini model used if the main one stays overloaded (for example `gemini-3.5-flash-lite`). |
| `MAX_TOKENS` | No | `8192` (Gemini) / `2500` (Claude) | Maximum output length per call. |
| `RATE_LIMIT_MAX` | No | `30` | Requests allowed per IP per 15 minutes (one full run is 5). |
| `PORT` | No | `3000` | Render sets this automatically. |

## Using it for a different brand

In the app, pick **Blank** from the example menu and fill in the brand, product, audience, tone, key benefit, and a real proof point. Run the stages in order and click **Download content pack** to get one Markdown file with everything.

Only five inputs change between brands (`brand_name`, `product`, `target_audience`, `key_benefit_or_transformation`, `tone`), plus a `proof_point` for the script. You can also run the prompts by hand in any chat model: see `docs/usage_guide.md`.

## Worked example

`outputs/pureglow_vitamin_c_serum_content_pack.md` is a complete generated pack: 8 hooks, a full script, Reels/TikTok/Shorts adaptations, captions and hashtags, and three A/B variants with hypotheses.

PureGlow is an illustrative D2C brand used to demonstrate the pipeline. Before using any pack commercially, replace the brand details and proof points with facts the real brand can stand behind. The prompts are written to avoid inventing statistics, prices, or offers, but you are still responsible for checking claims.

## Project structure

```
ugc-ad-generator/
├── server.js                  Express server: loads prompts, calls Claude, rate limits
├── package.json
├── package-lock.json
├── render.yaml                Render blueprint
├── .env.example
├── public/
│   └── index.html             The web app (single file)
├── prompts/                   The 5 reusable prompts (source of truth)
├── outputs/                   Generated example content pack
├── docs/usage_guide.md        Running the prompts manually
├── test/smoke.test.js         Offline end-to-end tests
├── LICENSE
└── README.md
```

## API

`POST /api/run`

```json
{ "stage": 1, "variables": { "brand_name": "PureGlow", "product": "...", "target_audience": "...", "key_benefit_or_transformation": "...", "tone": "..." } }
```

Required variables per stage: stage 1 needs the five above; stage 2 adds `chosen_hook` and `proof_point`; stage 3 needs `base_script`, `brand_name`, `product`; stage 4 needs the first four brand fields (`offer_or_link` optional); stage 5 needs `base_script`, `brand_name`, `product`, `target_audience`.

Response: `{ "stage": 1, "name": "hooks", "text": "...", "truncated": false }`. Errors return `{ "error": "..." }` with a matching status code. If `ACCESS_CODE` is set, send it as the `x-access-code` header.

Other endpoints: `GET /healthz` (health check), `GET /api/config` (tells the page whether an access code is required).

## Security and cost

Every generation uses your AI provider's credits or free quota. The API key never reaches the browser, input sizes are capped, and requests are rate limited per IP. A public URL with no `ACCESS_CODE` can still be used by anyone who finds it, so set one before sharing the link. If you use a paid key, also consider a monthly spend limit in your provider's console.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Could not reach the server" | You opened the HTML file directly. Run `npm start` and use `http://localhost:3000`. |
| "The server has no API key" | Set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` in `.env` locally, or under Environment on Render, then restart. |
| "Anthropic rejected the server API key" | The key is wrong, expired, or has no credits. If your key starts with `AIza`, it is a Gemini key: put it in `GEMINI_API_KEY`. |
| "Gemini rejected the server API key" | The key is wrong or was copied with extra spaces. Create a new one at aistudio.google.com/apikey. |
| "The AI request timed out" / "Gemini is slow or overloaded" | Google is temporarily busy. The app already retried 3 times (including after timeouts). Wait a minute and click again, or set `FALLBACK_MODEL` to a second model. |
| "Gemini rate limit or free-tier quota reached" | The free tier has per-minute and daily limits. Wait a minute, or enable billing on the key's project. |
| "... model ... not found" or "no longer available to new users" | Google retires models over time. Set `MODEL` to the replacement named in the error message (for example `gemini-3.8-flash`). |
| "Access code is missing or incorrect" | Enter the `ACCESS_CODE` value in the box at the top of the page. |
| "Too many requests" | You hit the rate limit. Wait a few minutes or raise `RATE_LIMIT_MAX`. |
| Output cut off mid-sentence | Raise `MAX_TOKENS` (for example `12000`). |
| `Cannot find module 'express'` | Run `npm install` first. |
| Port already in use | Set `PORT=3001` in `.env`. |
| Render deploy fails on build | Check the Render logs; confirm the repo root contains `package.json` and Node is 18+. |

## Tests

```bash
npm test
```

Runs the server against a mock AI API (no key or network needed) and checks all five stages on both Gemini and Claude, prompt filling, key handling, validation, and access-code enforcement.

## License

MIT. See `LICENSE`.
