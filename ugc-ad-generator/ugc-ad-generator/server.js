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
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const MAX_TOKENS = Number(process.env.MAX_TOKENS) || 2500;
const API_URL = process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages';
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 30; // requests per 15 min per IP
const UPSTREAM_TIMEOUT_MS = 90 * 1000;

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
  if (safeEqual(req.get('x-access-code') || '', ACCESS_CODE)) return next();
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
      error: 'The server is missing ANTHROPIC_API_KEY. Add it to your environment variables and restart.',
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
    const upstream = await fetch(API_URL, {
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

    let data = null;
    try {
      data = await upstream.json();
    } catch (_) {
      /* non-JSON upstream body */
    }

    if (!upstream.ok) {
      const detail = (data && data.error && data.error.message) || `status ${upstream.status}`;
      if (upstream.status === 401 || upstream.status === 403) {
        return res.status(502).json({ error: 'Anthropic rejected the server API key. Check ANTHROPIC_API_KEY.' });
      }
      if (upstream.status === 429) {
        return res.status(429).json({ error: 'Anthropic rate limit reached. Try again in a minute.' });
      }
      return res.status(502).json({ error: `Anthropic API error: ${detail}` });
    }

    const text = ((data && data.content) || [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!text) return res.status(502).json({ error: 'The model returned an empty response. Try again.' });

    return res.json({
      stage: Number(req.body.stage),
      name: stage.name,
      text,
      truncated: data.stop_reason === 'max_tokens',
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return res.status(504).json({ error: 'The request to Anthropic timed out. Try again.' });
    }
    console.error('Upstream request failed:', err.message);
    return res.status(502).json({ error: 'Could not reach the Anthropic API from the server.' });
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
  console.log(`UGC ad generator listening on port ${PORT}`);
  if (!API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY is not set. The UI will load but generation will fail.');
  if (!ACCESS_CODE) console.warn('Note: ACCESS_CODE is not set. Anyone with the URL can use your API credits (rate limited).');
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
