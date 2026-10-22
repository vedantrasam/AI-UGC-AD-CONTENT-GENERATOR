'use strict';

// End-to-end smoke tests. A mock "Anthropic" server stands in for the real API,
// so these run offline and cost nothing:  npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MOCK_PORT = 4199;
let lastRequest = null;

function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        lastRequest = { headers: req.headers, body: JSON.parse(body) };
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          content: [{ type: 'text', text: '1. [Skeptic] I did not expect this.\n2. [Callout] If your skin looks tired, watch this.' }],
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
        ANTHROPIC_API_KEY: 'test-key',
        ANTHROPIC_API_URL: `http://127.0.0.1:${MOCK_PORT}/v1/messages`,
        ACCESS_CODE: '',
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
  const open = await startApp(4101);
  const locked = await startApp(4102, { ACCESS_CODE: 'secret' });
  t.after(() => { open.kill(); locked.kill(); mock.close(); });

  await t.test('health check and static page', async () => {
    assert.equal(await (await fetch('http://127.0.0.1:4101/healthz')).text(), 'ok');
    const page = await fetch('http://127.0.0.1:4101/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /UGC ad generator/);
  });

  await t.test('all five stages build a filled prompt from /prompts', async () => {
    for (let stage = 1; stage <= 5; stage++) {
      const res = await post(4101, { stage, variables: vars });
      assert.equal(res.status, 200, `stage ${stage}`);
      const data = await res.json();
      assert.ok(data.text.length > 0);
      const sent = lastRequest.body.messages[0].content;
      assert.doesNotMatch(sent, /\{(brand_name|product|target_audience|key_benefit_or_transformation|tone|chosen_hook|proof_point|base_script|offer_or_link)\}/, `stage ${stage} left a placeholder unfilled`);
      assert.match(sent, /PureGlow/);
      assert.equal(lastRequest.headers['x-api-key'], 'test-key');
    }
  });

  await t.test('stage 4 defaults the offer instead of inventing one', async () => {
    await post(4101, { stage: 4, variables: vars });
    assert.match(lastRequest.body.messages[0].content, /No active offer/);
  });

  await t.test('validation errors', async () => {
    assert.equal((await post(4101, { stage: 9, variables: vars })).status, 400);
    const missing = await post(4101, { stage: 2, variables: { brand_name: 'X' } });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /Missing required fields/);
  });

  await t.test('access code is enforced when set', async () => {
    assert.equal((await post(4102, { stage: 1, variables: vars })).status, 401);
    assert.equal((await post(4102, { stage: 1, variables: vars }, { 'x-access-code': 'wrong' })).status, 401);
    assert.equal((await post(4102, { stage: 1, variables: vars }, { 'x-access-code': 'secret' })).status, 200);
    const cfg = await (await fetch('http://127.0.0.1:4102/api/config')).json();
    assert.equal(cfg.requiresAccessCode, true);
  });
});
