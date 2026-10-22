'use strict';

// End-to-end smoke tests. A mock server stands in for both the Anthropic and the
// Gemini APIs, so these run offline and cost nothing:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MOCK_PORT = 4199;
let last = null; // the most recent request the mock received
let flakyCount = 0;
let slowCount = 0;

function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        last = { url: req.url, headers: req.headers, body: JSON.parse(body) };
        res.setHeader('Content-Type', 'application/json');
        if (req.url.includes(':generateContent')) {
          if (req.headers['x-goog-api-key'] === 'bad-key') {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }));
          }
          const overloaded = () => {
            res.statusCode = 503;
            return res.end(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } }));
          };
          if (req.headers['x-goog-api-key'] === 'flaky-key' && flakyCount++ < 2) return overloaded();
          if (req.headers['x-goog-api-key'] === 'down-key') return overloaded();
          if (req.headers['x-goog-api-key'] === 'slow-key' && slowCount++ < 1) {
            return setTimeout(() => res.end('{}'), 600); // hangs past the app's timeout
          }
          const tc = last.body.generationConfig && last.body.generationConfig.thinkingConfig;
          if (req.url.includes('no-minimal-model') && tc) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: { code: 400, message: 'Thinking level minimal is not supported for this model.', status: 'INVALID_ARGUMENT' } }));
          }
          if (req.url.includes('primary-model')) return overloaded();
          return res.end(JSON.stringify({
            candidates: [{ content: { role: 'model', parts: [{ text: '1. [Skeptic] Gemini hook one.\n2. [Callout] Gemini hook two.' }] }, finishReason: 'STOP' }],
          }));
        }
        return res.end(JSON.stringify({
          content: [{ type: 'text', text: '1. [Skeptic] Claude hook one.\n2. [Callout] Claude hook two.' }],
          stop_reason: 'end_turn',
        }));
      });
    });
    srv.listen(MOCK_PORT, () => resolve(srv));
  });
}

function startApp(port, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(port),
        PROVIDER: '',
        MODEL: '',
        ANTHROPIC_API_KEY: 'test-key',
        GEMINI_API_KEY: '',
        ANTHROPIC_API_URL: `http://127.0.0.1:${MOCK_PORT}/v1/messages`,
        GEMINI_API_URL: `http://127.0.0.1:${MOCK_PORT}/v1beta/models`,
        ACCESS_CODE: '',
        FALLBACK_MODEL: '',
        RETRY_DELAY_MS: '10',
        UPSTREAM_TIMEOUT_MS: '',
        ...env,
      },
    });
    const timer = setTimeout(() => reject(new Error('server did not start')), 8000);
    proc.stdout.on('data', (d) => {
      if (String(d).includes('listening')) { clearTimeout(timer); resolve(proc); }
    });
    proc.on('error', reject);
  });
}

const vars = {
  brand_name: 'PureGlow',
  product: 'Vitamin C Serum',
  target_audience: 'Women 22-35',
  key_benefit_or_transformation: 'Brighter skin',
  tone: 'Honest',
  proof_point: '10% stabilized Vitamin C',
  chosen_hook: 'I did not expect this.',
  base_script: 'Hook... problem... solution... CTA.',
};

const post = (port, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}/api/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('server', async (t) => {
  const mock = await startMock();
  const claude = await startApp(4101);
  const locked = await startApp(4102, { ACCESS_CODE: 'secret' });
  const gemini = await startApp(4103, { GEMINI_API_KEY: 'gem-key', ANTHROPIC_API_KEY: '' });
  const mixedUp = await startApp(4104, { ANTHROPIC_API_KEY: 'AIzaFakeGoogleKeyPastedInWrongVariable' });
  const badKey = await startApp(4105, { GEMINI_API_KEY: 'bad-key', ANTHROPIC_API_KEY: '' });
  const noKey = await startApp(4106, { ANTHROPIC_API_KEY: '' });
  const flaky = await startApp(4108, { GEMINI_API_KEY: 'flaky-key', ANTHROPIC_API_KEY: '' });
  const down = await startApp(4109, { GEMINI_API_KEY: 'down-key', ANTHROPIC_API_KEY: '' });
  const withFallback = await startApp(4110, { GEMINI_API_KEY: 'gem-key', ANTHROPIC_API_KEY: '', MODEL: 'primary-model', FALLBACK_MODEL: 'backup-model' });
  const slow = await startApp(4111, { GEMINI_API_KEY: 'slow-key', ANTHROPIC_API_KEY: '', UPSTREAM_TIMEOUT_MS: '200' });
  const picky = await startApp(4112, { GEMINI_API_KEY: 'gem-key', ANTHROPIC_API_KEY: '', MODEL: 'gemini-3-no-minimal-model' });
  const legacy = await startApp(4107, { GEMINI_API_KEY: 'gem-key', ANTHROPIC_API_KEY: '', MODEL: 'gemini-2.5-flash' });
  t.after(() => { [claude, locked, gemini, mixedUp, badKey, noKey, legacy, flaky, down, withFallback, slow, picky].forEach((p) => p.kill()); mock.close(); });

  await t.test('health check and static page', async () => {
    assert.equal(await (await fetch('http://127.0.0.1:4101/healthz')).text(), 'ok');
    const page = await fetch('http://127.0.0.1:4101/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /UGC ad generator/);
  });

  await t.test('claude: all five stages build a filled prompt from /prompts', async () => {
    for (let stage = 1; stage <= 5; stage++) {
      const res = await post(4101, { stage, variables: vars });
      assert.equal(res.status, 200, `stage ${stage}`);
      assert.ok((await res.json()).text.length > 0);
      const sent = last.body.messages[0].content;
      assert.doesNotMatch(sent, /\{(brand_name|product|target_audience|key_benefit_or_transformation|tone|chosen_hook|proof_point|base_script|offer_or_link)\}/, `stage ${stage} left a placeholder unfilled`);
      assert.match(sent, /PureGlow/);
      assert.equal(last.headers['x-api-key'], 'test-key');
    }
  });

  await t.test('gemini: all five stages work with the Gemini request format', async () => {
    for (let stage = 1; stage <= 5; stage++) {
      const res = await post(4103, { stage, variables: vars });
      assert.equal(res.status, 200, `stage ${stage}`);
      const data = await res.json();
      assert.match(data.text, /Gemini hook one/);
      assert.equal(data.truncated, false);
      const sent = last.body.contents[0].parts[0].text;
      assert.match(sent, /PureGlow/);
      assert.doesNotMatch(sent, /\{brand_name\}/);
    }
    assert.match(last.url, /\/gemini-3\.8-flash:generateContent$/);
    assert.equal(last.headers['x-goog-api-key'], 'gem-key');
    assert.equal(last.body.generationConfig.maxOutputTokens, 8192);
    assert.equal(last.body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
  });

  await t.test('gemini: MODEL override is honored, and 2.5-flash gets thinking switched off', async () => {
    const res = await post(4107, { stage: 1, variables: vars });
    assert.equal(res.status, 200);
    assert.match(last.url, /\/gemini-2\.5-flash:generateContent$/);
    assert.equal(last.body.generationConfig.thinkingConfig.thinkingBudget, 0);
  });

  await t.test('gemini: temporary 503 overload is retried automatically', async () => {
    const res = await post(4108, { stage: 1, variables: vars });
    assert.equal(res.status, 200);
    assert.match((await res.json()).text, /Gemini hook one/);
  });

  await t.test('gemini: a hung request times out and is retried', async () => {
    const res = await post(4111, { stage: 1, variables: vars });
    assert.equal(res.status, 200);
    assert.match((await res.json()).text, /Gemini hook one/);
  });

  await t.test('gemini: a model that rejects the thinking setting is retried without it', async () => {
    const res = await post(4112, { stage: 1, variables: vars });
    assert.equal(res.status, 200);
    assert.equal(last.body.generationConfig.thinkingConfig, undefined);
  });

  await t.test('gemini: persistent overload gives a clear 503 message', async () => {
    const res = await post(4109, { stage: 1, variables: vars });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /overloaded/);
  });

  await t.test('gemini: FALLBACK_MODEL is used when the main model stays overloaded', async () => {
    const res = await post(4110, { stage: 1, variables: vars });
    assert.equal(res.status, 200);
    assert.match(last.url, /backup-model:generateContent$/);
  });

  await t.test('a Gemini key pasted into ANTHROPIC_API_KEY is detected and used as Gemini', async () => {
    const res = await post(4104, { stage: 1, variables: vars });
    assert.equal(res.status, 200);
    assert.match((await res.json()).text, /Gemini hook one/);
    assert.equal(last.headers['x-goog-api-key'], 'AIzaFakeGoogleKeyPastedInWrongVariable');
  });

  await t.test('gemini: an invalid key gives a clear error', async () => {
    const res = await post(4105, { stage: 1, variables: vars });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /Gemini rejected the server API key/);
  });

  await t.test('missing key gives a clear error', async () => {
    const res = await post(4106, { stage: 1, variables: vars });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /GEMINI_API_KEY/);
  });

  await t.test('stage 4 defaults the offer instead of inventing one', async () => {
    await post(4101, { stage: 4, variables: vars });
    assert.match(last.body.messages[0].content, /No active offer/);
  });

  await t.test('validation errors', async () => {
    assert.equal((await post(4101, { stage: 9, variables: vars })).status, 400);
    const missing = await post(4101, { stage: 2, variables: { brand_name: 'X' } });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /Missing required fields/);
  });

  await t.test('access code is enforced when set (spaces around it are ignored)', async () => {
    assert.equal((await post(4102, { stage: 1, variables: vars })).status, 401);
    assert.equal((await post(4102, { stage: 1, variables: vars }, { 'x-access-code': 'wrong' })).status, 401);
    assert.equal((await post(4102, { stage: 1, variables: vars }, { 'x-access-code': 'secret' })).status, 200);
    assert.equal((await post(4102, { stage: 1, variables: vars }, { 'x-access-code': '  secret ' })).status, 200);
    const cfg = await (await fetch('http://127.0.0.1:4102/api/config')).json();
    assert.equal(cfg.requiresAccessCode, true);
  });
});
