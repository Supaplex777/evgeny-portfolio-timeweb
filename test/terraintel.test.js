'use strict';

// Run: npm test   (uses only node:test — no extra dependencies)
// Polza AI is replaced with an in-process stub; no network or real key is used.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.POLZA_API_KEY = 'test-key-not-real';
process.env.TERRAINTEL_RATE_LIMIT = '5';

const { createTerraIntelRouter, _internal } = require('../lib/terraintel');

const realFetch = global.fetch;
let polzaMode = 'ok';
let polzaCalls = [];

global.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith('https://polza.ai/')) return realFetch(url, opts);
  const body = JSON.parse(opts.body);
  polzaCalls.push(body);
  if (polzaMode === 'timeout') {
    const err = new Error('timeout'); err.name = 'TimeoutError'; throw err;
  }
  if (polzaMode === 'http500') return new Response('{"error":{"message":"upstream"}}', { status: 500 });
  if (polzaMode === 'notjson') return new Response(JSON.stringify({ choices: [{ message: { content: 'Не могу ответить.' } }] }));
  if (polzaMode === 'unsafe') {
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ llm_interpretations: [{ id: 'TI-001', explanation: 'Это мина, территория безопасна.', recommendation: '-' }] }) } }] }));
  }
  const ids = [...body.messages[1].content.matchAll(/"id":"(TI-\d{3})"/g)].map((m) => m[1]);
  const content = '```json\n' + JSON.stringify({
    llm_interpretations: [...ids.map((id) => ({ id, explanation: `Отклонение ${id}.`, recommendation: 'Экспертная проверка.' })), { id: 'TI-999', explanation: 'x', recommendation: 'x' }]
  }) + '\n```';
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
};

let server;
let base;
before(async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/terraintel', createTerraIntelRouter());
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); global.fetch = realFetch; });
beforeEach(() => { polzaMode = 'ok'; polzaCalls = []; });

let ipCounter = 1;
const post = (body, ip) => realFetch(`${base}/api/terraintel/analyze`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip || `10.0.0.${ipCounter++}` },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

const anomaly = (i, extra = {}) => ({ id: `TI-${String(i).padStart(3, '0')}`, lat: 55.75 + i / 1000, lon: 37.61, robust_z: 6.4, sample_index: i * 10, timestamp: 1727280000000 + i, ...extra });
const valid = (n = 2) => ({ project: { name: 'Проект', area: 'Участок', description: 'Описание', threshold: 4 }, anomalies: Array.from({ length: n }, (_, i) => anomaly(i + 1)) });

test('valid payload → interpretations mapped by id, unknown ids dropped', async () => {
  const res = await post(valid(3));
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data.llm_interpretations.map((x) => x.id), ['TI-001', 'TI-002', 'TI-003']);
  assert.equal(data.ai_status, 'ok');
  assert.equal(data.model, _internal.CONFIG.model);
});

test('only whitelisted fields reach the model; key never in payload', async () => {
  const body = valid(1);
  body.anomalies[0].raw_csv = 'SECRET_ROW';
  body.project.maptiler_key = 'MAPKEY';
  body.csv = 'a,b,c';
  await post(body);
  const sent = JSON.stringify(polzaCalls[0]);
  assert.ok(!sent.includes('SECRET_ROW') && !sent.includes('MAPKEY') && !sent.includes('a,b,c'));
  assert.ok(!sent.includes('test-key-not-real'));
  assert.equal(polzaCalls[0].model, 'sber/gigachat-2');
  assert.match(polzaCalls[0].messages[0].content, /TerraIntel/);
});

test('validation → 400', async () => {
  const cases = [
    {},
    { anomalies: [] },
    { project: { name: 'P', threshold: 4 }, anomalies: 'x' },
    { project: { name: '', threshold: 4 }, anomalies: [] },
    { project: { name: 'P', threshold: 'abc' }, anomalies: [] },
    { project: { name: 'P', threshold: 4 }, anomalies: [anomaly(1, { lat: 91 })] },
    { project: { name: 'P', threshold: 4 }, anomalies: [anomaly(1, { lon: -181 })] },
    { project: { name: 'P', threshold: 4 }, anomalies: [anomaly(1, { robust_z: 'x' })] },
    { project: { name: 'P', threshold: 4 }, anomalies: [anomaly(1, { id: '<script>' })] },
    { project: { name: 'P', threshold: 4 }, anomalies: [anomaly(1), anomaly(1)] },
    valid(21)
  ];
  for (const c of cases) {
    const res = await post(c);
    assert.equal(res.status, 400, JSON.stringify(c).slice(0, 80));
    assert.ok((await res.json()).error);
  }
  assert.equal(polzaCalls.length, 0);
});

test('empty anomalies → no AI call', async () => {
  const res = await post({ project: { name: 'P', threshold: 4 }, anomalies: [] });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ai_status, 'skipped');
  assert.equal(polzaCalls.length, 0);
});

test('upstream error → 502, timeout → 504, bad model output → 502', async () => {
  polzaMode = 'http500';
  assert.equal((await post(valid())).status, 502);
  polzaMode = 'timeout';
  assert.equal((await post(valid())).status, 504);
  polzaMode = 'notjson';
  const res = await post(valid());
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /неверном формате/);
});

test('unsafe claims are dropped (frontend uses neutral local fallback)', async () => {
  polzaMode = 'unsafe';
  const res = await post(valid(1));
  assert.equal(res.status, 502);
});

test('oversized content-length → 413 JSON', async () => {
  const body = valid(1);
  body.project.description = 'x'.repeat(70 * 1024);
  const res = await post(body);
  assert.equal(res.status, 413);
  assert.ok((await res.json()).error);
});

test('rate limit → 429 JSON', async () => {
  const ip = '10.9.9.9';
  let last;
  for (let i = 0; i < 6; i += 1) last = await post(valid(1), ip);
  assert.equal(last.status, 429);
  assert.match((await last.json()).error, /Слишком много/);
});

test('extractJson tolerates fences and surrounding text', () => {
  assert.deepEqual(_internal.extractJson('Вот:\n```json\n{"a":1}\n```'), { a: 1 });
  assert.equal(_internal.extractJson('нет json'), null);
});
