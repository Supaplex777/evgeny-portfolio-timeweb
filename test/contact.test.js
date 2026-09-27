'use strict';

// Run: npm test   (spawns the real server.js as a child process per
// scenario, with a --require preload that mocks only the Telegram Bot API
// call deterministically - no real network, no real Supabase - Supabase
// was removed from this route entirely; see server.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const PRELOAD_PATH = path.join(__dirname, 'helpers', 'mock-fetch-preload.js');
let nextPort = 4800;

function startServer(extraEnv) {
  const port = nextPort++;
  const child = spawn(process.execPath, ['--require', PRELOAD_PATH, SERVER_PATH], {
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server on port ${port} did not start in time. stderr: ${stderr}`)), 8000);
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('running on port')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server on port ${port} exited early with code ${code}. stderr: ${stderr}`));
    });
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    getStderr: () => stderr,
    ready,
    async stop() {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  };
}

async function postContact(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/contact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 204 has no body */ }
  return { status: response.status, json };
}

const validPayload = () => ({
  name: 'Иван Тестов',
  contact: 'ivan@example.com',
  project_type: 'Автоматизация',
  message: 'Тестовое сообщение достаточной длины для прохождения валидации формы.'
});

test('Telegram configured and reachable: 201 with telegramSent:true, no token leaked in logs', async () => {
  const server = startServer({ TELEGRAM_BOT_TOKEN: 'TEST_TOKEN_ABC123', TELEGRAM_CHAT_ID: '188273632', MOCK_TELEGRAM_MODE: 'ok' });
  await server.ready;
  try {
    const { status, json } = await postContact(server.baseUrl, validPayload());
    assert.equal(status, 201);
    assert.deepEqual(json, { ok: true, telegramSent: true, emailSent: false });
    assert.doesNotMatch(server.getStderr(), /TEST_TOKEN_ABC123/, 'bot token must never appear in server logs');
  } finally {
    await server.stop();
  }
});

test('Telegram not configured: clear 500, request never claims success', async () => {
  const server = startServer({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', MOCK_TELEGRAM_MODE: 'ok' });
  await server.ready;
  try {
    const { status, json } = await postContact(server.baseUrl, validPayload());
    assert.equal(status, 500);
    assert.equal(json.ok, undefined);
    assert.match(json.error, /недоступен/i);
  } finally {
    await server.stop();
  }
});

test('Telegram API returns an error (e.g. bad token): 502, no token leaked', async () => {
  const server = startServer({ TELEGRAM_BOT_TOKEN: 'BAD_TOKEN_XYZ789', TELEGRAM_CHAT_ID: '188273632', MOCK_TELEGRAM_MODE: 'http_error' });
  await server.ready;
  try {
    const { status, json } = await postContact(server.baseUrl, validPayload());
    assert.equal(status, 502);
    assert.equal(json.ok, undefined);
    assert.doesNotMatch(server.getStderr(), /BAD_TOKEN_XYZ789/, 'bot token must never appear in server logs');
  } finally {
    await server.stop();
  }
});

test('Telegram times out: 503, distinct from a hard API error', async () => {
  const server = startServer({ TELEGRAM_BOT_TOKEN: 'TEST_TOKEN', TELEGRAM_CHAT_ID: '188273632', MOCK_TELEGRAM_MODE: 'timeout' });
  await server.ready;
  try {
    const { status } = await postContact(server.baseUrl, validPayload());
    assert.equal(status, 503);
  } finally {
    await server.stop();
  }
});

test('Telegram network failure (DNS/connect): 503, same as a timeout', async () => {
  const server = startServer({ TELEGRAM_BOT_TOKEN: 'TEST_TOKEN', TELEGRAM_CHAT_ID: '188273632', MOCK_TELEGRAM_MODE: 'network_error' });
  await server.ready;
  try {
    const { status } = await postContact(server.baseUrl, validPayload());
    assert.equal(status, 503);
  } finally {
    await server.stop();
  }
});

test('honeypot: silent 204, no Telegram call, no config required', async () => {
  const server = startServer({ TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '' });
  await server.ready;
  try {
    const response = await fetch(`${server.baseUrl}/api/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...validPayload(), company: 'I am a bot' })
    });
    assert.equal(response.status, 204);
  } finally {
    await server.stop();
  }
});

test('duplicate request within 10 minutes: first succeeds, second is rejected with 409', async () => {
  const server = startServer({ TELEGRAM_BOT_TOKEN: 'TEST_TOKEN', TELEGRAM_CHAT_ID: '188273632', MOCK_TELEGRAM_MODE: 'ok' });
  await server.ready;
  try {
    const payload = validPayload();
    const first = await postContact(server.baseUrl, payload);
    assert.equal(first.status, 201);

    const second = await postContact(server.baseUrl, payload);
    assert.equal(second.status, 409);
  } finally {
    await server.stop();
  }
});

test('a failed Telegram send is not deduped: an immediate retry is allowed through', async () => {
  const server = startServer({ TELEGRAM_BOT_TOKEN: 'TEST_TOKEN', TELEGRAM_CHAT_ID: '188273632', MOCK_TELEGRAM_MODE: 'http_error' });
  await server.ready;
  try {
    const payload = validPayload();
    const first = await postContact(server.baseUrl, payload);
    assert.equal(first.status, 502);

    // Same fingerprint, retried immediately - must not be blocked as a duplicate,
    // since the first attempt never actually reached Telegram successfully.
    const second = await postContact(server.baseUrl, payload);
    assert.equal(second.status, 502);
    assert.notEqual(second.status, 409);
  } finally {
    await server.stop();
  }
});

test('/, /health and /terraintel/ are unaffected by the contact route change', async () => {
  const server = startServer({ TELEGRAM_BOT_TOKEN: 'TEST_TOKEN', TELEGRAM_CHAT_ID: '188273632', MOCK_TELEGRAM_MODE: 'ok' });
  await server.ready;
  try {
    const home = await fetch(`${server.baseUrl}/`);
    assert.equal(home.status, 200);

    const health = await fetch(`${server.baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.status, 'ok');

    const terraintel = await fetch(`${server.baseUrl}/terraintel/`);
    assert.equal(terraintel.status, 200);
  } finally {
    await server.stop();
  }
});
