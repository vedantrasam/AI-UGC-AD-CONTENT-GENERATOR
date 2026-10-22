'use strict';

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------------------
// Configuration (all via environment variables, see .env.example)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 2500;
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 30; // requests per 15 min per IP
const UPSTREAM_TIMEOUT_MS = 90 * 1000;

const ANTHROPIC_KEY = (process.env.ANTHROPIC_API_KEY || '').trim();
const GEMINI_KEY = (process.env.GEMINI_API_KEY || '').trim();
const ANTHROPIC_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const GEMINI_URL = (process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/$/, '');

// Google API keys start with "AIza". If one was pasted into ANTHROPIC_API_KEY by
// mistake, use it as a Gemini key instead of failing.
const looksLikeGemini = (key) => key.startsWith('AIza');

// Which AI provider to use. Set PROVIDER=gemini or PROVIDER=anthropic to force one;
// otherwise it is detected from whichever key is present.
function resolveProvider() {
  const forced = (process.env.PROVIDER || '').trim().toLowerCase();
  if (forced === 'gemini') return { provider: 'gemini', key: GEMINI_KEY || (looksLikeGemini(ANTHROPIC_KEY) ? ANTHROPIC_KEY : '') };
  if (forced === 'anthropic') return { provider: 'anthropic', key: ANTHROPIC_KEY };
  if (GEMINI_KEY) return { provider: 'gemini', key: GEMINI_KEY };
  if (looksLikeGemini(ANTHROPIC_KEY)) return { provider: 'gemini', key: ANTHROPIC_KEY };
  return { provider: 'anthropic', key: ANTHROPIC_KEY };
}

const { provider: PROVIDER, key: API_KEY } = resolveProvider();
const MODEL = (process.env.MODEL || '').trim() || (PROVIDER === 'gemini' ? 'gemini-2.5-flash' : 'claude-sonnet-5-5');

// ---------------------------------------------------------------------------
// Prompt templates: the markdown files in /prompts are the single source of
// truth. Each file holds one fenced block containing the prompt text.
// ---------------------------------------------------------------------------
const BASE = ['brand_name', 'product', 'target_audience', 'key_benefit_or_transformation'];

const STAGES = {
  1: { name: 'hooks', file: '01_hook_generator.md', required: [...BASE, 'tone'] },
  2: { name: 'script', file: '02_script_generator.md', required: [...BASE, 'tone', 'chosen_hook', 'proof_point'] },
  3: { name: 'platforms', file: '03_platform_adapter.md', required: ['base_script', 'brand_name', 'product'] },
  4: {
    name: 'cta_captions',
    file: '04_cta_caption_generator.md',
    required: [...BASE],
    defaults: { offer_or_link: 'No active offer. Do not invent one.' },
  },
  5: { name: 'ab_variants', file: '05_ab_variation_generator.md', required: ['base_script', 'brand_name', 'product', 'target_audience'] },
};

function loadTemplate(file) {
  const markdown = fs.readFileSync(path.join(__dirname, 'prompts', file), 'utf8');
  const match = markdown.match(/```[^\n]*\n([\s\S]*?)\n```/);
  if (!match) throw new Error(`No fenced prompt block found in prompts/${file}`);
  return match[1];
}

for (const [id, stage] of Object.entries(STAGES)) {
  try {
    stage.template = loadTemplate(stage.file);
  } catch (err) {
    console.error(`Failed to load prompt for stage ${id}: ${err.message}`);
    process.exit(1);
  }
}

// Single-pass substitution so values containing "{...}" are never re-processed.
function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole
  );
}

// ---------------------------------------------------------------------------
// AI providers. Each returns { text, truncated } or throws UpstreamError.
// ---------------------------------------------------------------------------
class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function callAnthropic(prompt) {
  const upstream = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const data = await readJson(upstream);

  if (!upstream.ok) {
    const detail = (data && data.error && data.error.message) || `status ${upstream.status}`;
    if (upstream.status === 401 || upstream.status === 403) {
      throw new UpstreamError(502, 'Anthropic rejected the server API key. Check ANTHROPIC_API_KEY. (Using a Google Gemini key? Set GEMINI_API_KEY instead.)');
    }
    if (upstream.status === 429) throw new UpstreamError(429, 'Anthropic rate limit reached. Try again in a minute.');
    throw new UpstreamError(502, `Anthropic API error: ${detail}`);
  }

  const text = ((data && data.content) || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return { text, truncated: Boolean(data) && data.stop_reason === 'max_tokens' };
}

async function callGemini(prompt) {
  const url = `${GEMINI_URL}/${encodeURIComponent(MODEL)}:generateContent`;
  const generationConfig = { maxOutputTokens: MAX_TOKENS };
  // Gemini 2.5 Flash "thinks" by default and thinking tokens count against the
  // output limit; switch it off so scripts are not cut short.
  if (/2\.5-flash/.test(MODEL)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig,
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  const data = await readJson(upstream);

  if (!upstream.ok) {
    const detail = (data && data.error && data.error.message) || `status ${upstream.status}`;
    if (upstream.status === 401 || upstream.status === 403 || /api key/i.test(detail)) {
      throw new UpstreamError(502, 'Gemini rejected the server API key. Check GEMINI_API_KEY (create one at aistudio.google.com/apikey).');
    }
    if (upstream.status === 429) {
      throw new UpstreamError(429, 'Gemini rate limit or free-tier quota reached. Wait a minute and try again.');
    }
    throw new UpstreamError(502, `Gemini API error: ${detail}`);
  }

  const candidate = data && data.candidates && data.candidates[0];
  const text = ((candidate && candidate.content && candidate.content.parts) || [])
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (!text && data && data.promptFeedback && data.promptFeedback.blockReason) {
    throw new UpstreamError(502, `Gemini blocked this request (${data.promptFeedback.blockReason}). Try rewording your inputs.`);
  }
  return { text, truncated: Boolean(candidate) && candidate.finishReason === 'MAX_TOKENS' };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // Render sits behind a proxy; needed for correct client IPs
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.get('/api/config', (req, res) => {
  res.json({ requiresAccessCode: Boolean(ACCESS_CODE) });
});

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAccess(req, res, next) {
  if (!ACCESS_CODE) return next();
  if (safeEqual((req.get('x-access-code') || '').trim(), ACCESS_CODE)) return next();
  return res.status(401).json({ error: 'Access code is missing or incorrect.' });
}

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes and try again.' },
});

app.post('/api/run', limiter, requireAccess, async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'The server has no API key. Set GEMINI_API_KEY (Google Gemini) or ANTHROPIC_API_KEY (Claude) in your environment variables and restart.',
    });
  }

  const stage = STAGES[Number(req.body && req.body.stage)];
  if (!stage) return res.status(400).json({ error: 'Invalid stage. Use a number from 1 to 5.' });

  const input = (req.body && req.body.variables) || {};
  const vars = { ...(stage.defaults || {}) };
  const allowed = new Set([...stage.required, ...Object.keys(stage.defaults || {})]);

  for (const key of allowed) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      const limit = key === 'base_script' ? 12000 : 1500;
      if (value.length > limit) {
        return res.status(400).json({ error: `"${key}" is too long (max ${limit} characters).` });
      }
      vars[key] = value.trim();
    }
  }

  const missing = stage.required.filter((key) => !vars[key]);
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  const prompt = fill(stage.template, vars);

  try {
    const result = PROVIDER === 'gemini' ? await callGemini(prompt) : await callAnthropic(prompt);
    if (!result.text) return res.status(502).json({ error: 'The model returned an empty response. Try again.' });
    return res.json({
      stage: Number(req.body.stage),
      name: stage.name,
      text: result.text,
      truncated: result.truncated,
    });
  } catch (err) {
    if (err instanceof UpstreamError) return res.status(err.status).json({ error: err.message });
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'The AI request timed out. Try again.' });
    }
    console.error('Upstream request failed:', err.message);
    return res.status(502).json({ error: 'Could not reach the AI provider from the server.' });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
  console.error(err);
  return res.status(500).json({ error: 'Internal server error.' });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`UGC ad generator listening on port ${PORT} (provider: ${PROVIDER}, model: ${MODEL})`);
  if (!API_KEY) console.warn('WARNING: no API key found. Set GEMINI_API_KEY or ANTHROPIC_API_KEY. The UI will load but generation will fail.');
  if (!ACCESS_CODE) console.warn('Note: ACCESS_CODE is not set. Anyone with the URL can use your API credits (rate limited).');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
