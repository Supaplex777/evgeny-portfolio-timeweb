'use strict';

// Run: npm test   (uses only node:test — no network, no real S3/Supabase).
// S3 is replaced with an in-process fake store; only pure logic and the
// router's HTTP behaviour (validation, auth, origin checks) are exercised.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');

process.env.S3_BUCKET_CERTIFICATES = 'test-bucket';
process.env.S3_PUBLIC_BASE_URL = 'https://cdn.example.test';
process.env.CERT_ALLOWED_ORIGIN = 'https://site.example.test';
process.env.CERT_MAX_FILE_SIZE_MB = '1';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('correct-password', 4);

const certificates = require('../lib/certificates');
const {
  isValidId, isValidCategory, safeFileName, signSession, verifySession,
  parseCookies, serializeCookie, allowedOrigins, publicUrlFor, toApiRow,
  createCertificatesRouter
} = certificates;

// --- Pure helpers ---------------------------------------------------------

test('isValidId accepts UUIDs and the legacy fallback id, rejects path traversal', () => {
  assert.equal(isValidId('3fa85f64-5717-4562-b3fc-2c963f66afa6'), true);
  assert.equal(isValidId('1699999999999-0.123456'), true);
  assert.equal(isValidId('../../etc/passwd'), false);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId(null), false);
});

test('isValidCategory only accepts the known six categories', () => {
  assert.equal(isValidCategory('ai'), true);
  assert.equal(isValidCategory('new'), true);
  assert.equal(isValidCategory('../metadata'), false);
  assert.equal(isValidCategory(''), false);
});

test('safeFileName strips unsafe characters and keeps a short extension', () => {
  // Mirrors the client-side safeFileName() byte-for-byte: \w is ASCII-only,
  // so a Cyrillic name collapses to the "document" fallback (display name
  // stays intact in metadata.name — only the storage key becomes generic).
  assert.equal(safeFileName('Сертификат №1 (2024).pdf'), 'No1-2024.pdf');
  assert.equal(safeFileName('../../evil.sh'), 'evil.sh');
  assert.equal(safeFileName(''), 'document');
});

test('signSession/verifySession round-trips and rejects tampering and expiry', () => {
  const token = signSession({ exp: Date.now() + 10000 });
  const payload = verifySession(token);
  assert.ok(payload && payload.exp > Date.now());

  const [body, sig] = token.split('.');
  assert.equal(verifySession(`${body}.wrongsignature`), null);
  assert.equal(verifySession('not-a-token'), null);

  const expired = signSession({ exp: Date.now() - 1000 });
  assert.equal(verifySession(expired), null);
});

test('parseCookies/serializeCookie round-trip', () => {
  const serialized = serializeCookie('cert_admin', 'abc.def', 1000);
  assert.match(serialized, /^cert_admin=abc\.def;/);
  assert.match(serialized, /HttpOnly/);
  assert.match(serialized, /SameSite=Strict/);
  const parsed = parseCookies('foo=bar; cert_admin=abc.def; other=1');
  assert.equal(parsed.cert_admin, 'abc.def');
});

test('allowedOrigins reads a comma-separated list from env', () => {
  const previous = process.env.CERT_ALLOWED_ORIGIN;
  process.env.CERT_ALLOWED_ORIGIN = 'https://a.test, https://b.test';
  assert.deepEqual(allowedOrigins(), ['https://a.test', 'https://b.test']);
  process.env.CERT_ALLOWED_ORIGIN = previous;
});

test('publicUrlFor and toApiRow never leak the raw S3 base URL config, only ready-made URLs', () => {
  assert.equal(publicUrlFor('https://cdn.example.test/', 'originals/ai/x/y.pdf'), 'https://cdn.example.test/originals/ai/x/y.pdf');
  const row = toApiRow({
    id: '1', category: 'ai', name: 'Cert', type: 'application/pdf',
    created_at: '2024-01-01T00:00:00.000Z', description: 'desc',
    file_path: 'originals/ai/1/cert.pdf', preview_path: 'previews/ai/1.webp'
  }, 'https://cdn.example.test');
  assert.equal(row.fileUrl, 'https://cdn.example.test/originals/ai/1/cert.pdf');
  assert.equal(row.previewUrl, 'https://cdn.example.test/previews/ai/1.webp');
  assert.equal('file_path' in row, false);
  assert.equal('preview_path' in row, false);
});

// --- In-memory fake S3 for router-level tests -----------------------------

function createFakeS3() {
  const objects = new Map();
  return {
    objects,
    async send(command) {
      if (command instanceof PutObjectCommand) {
        objects.set(command.input.Key, { body: command.input.Body, contentType: command.input.ContentType });
        return {};
      }
      if (command instanceof GetObjectCommand) {
        const object = objects.get(command.input.Key);
        if (!object) {
          const error = new Error('NoSuchKey');
          error.name = 'NoSuchKey';
          throw error;
        }
        const bodyBuffer = Buffer.isBuffer(object.body) ? object.body : Buffer.from(object.body);
        return { Body: { transformToString: async () => bodyBuffer.toString('utf8') } };
      }
      if (command instanceof DeleteObjectsCommand) {
        (command.input.Delete.Objects || []).forEach((o) => objects.delete(o.Key));
        return {};
      }
      if (command instanceof ListObjectsV2Command) {
        const prefix = command.input.Prefix || '';
        const keys = [...objects.keys()].filter((key) => key.startsWith(prefix));
        return { Contents: keys.map((Key) => ({ Key })), IsTruncated: false };
      }
      throw new Error(`Unhandled fake S3 command: ${command.constructor.name}`);
    }
  };
}

let server, base, fakeS3;
before(async () => {
  fakeS3 = createFakeS3();
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api/certificates', createCertificatesRouter({ s3: fakeS3 }));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); });
beforeEach(() => { fakeS3.objects.clear(); });

const ORIGIN = 'https://site.example.test';

function request(pathname, { method = 'GET', origin = ORIGIN, cookie, body, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (origin) finalHeaders.Origin = origin;
  if (cookie) finalHeaders.Cookie = cookie;
  return fetch(`${base}${pathname}`, { method, headers: finalHeaders, body });
}

async function login() {
  const response = await request('/api/certificates/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-password' })
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'login must set a session cookie');
  return setCookie.split(';')[0];
}

test('GET /counts returns zero counts for every category when the bucket is empty', async () => {
  const response = await request('/api/certificates/counts', { origin: null });
  assert.equal(response.status, 200);
  const counts = await response.json();
  assert.deepEqual(counts, { ai: 0, code: 0, data: 0, test: 0, basic: 0, new: 0 });
});

test('POST /api/certificates without Origin/Referer is rejected before touching S3', async () => {
  const response = await request('/api/certificates', { method: 'POST', origin: null });
  assert.equal(response.status, 403);
  assert.equal(fakeS3.objects.size, 0);
});

test('POST /api/certificates with a valid Origin but no session is rejected', async () => {
  const response = await request('/api/certificates', { method: 'POST' });
  assert.equal(response.status, 401);
});

test('login rejects a wrong password and does not set a cookie', async () => {
  const response = await request('/api/certificates/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'nope' })
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('login with the correct password authenticates the session', async () => {
  const cookie = await login();
  const sessionResponse = await request('/api/certificates/session', { origin: null, cookie });
  const session = await sessionResponse.json();
  assert.equal(session.authenticated, true);
});

test('full owner flow: upload -> list -> counts -> patch -> delete', async () => {
  const cookie = await login();

  const form = new FormData();
  form.append('id', '3fa85f64-5717-4562-b3fc-2c963f66afa6');
  form.append('category', 'ai');
  form.append('name', 'Тест сертификат.pdf');
  form.append('description', 'Первая версия описания');
  form.append('created', String(Date.parse('2024-05-01T00:00:00.000Z')));
  form.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'cert.pdf');

  const uploadResponse = await request('/api/certificates', { method: 'POST', cookie, body: form });
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json();
  assert.equal(uploaded.fileUrl, 'https://cdn.example.test/originals/ai/3fa85f64-5717-4562-b3fc-2c963f66afa6/document.pdf');
  assert.equal(uploaded.previewUrl, '');

  const listResponse = await request('/api/certificates?category=ai', { origin: null });
  const list = await listResponse.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Тест сертификат.pdf');

  const countsResponse = await request('/api/certificates/counts', { origin: null });
  assert.deepEqual((await countsResponse.json()).ai, 1);

  const patchResponse = await request(`/api/certificates/${uploaded.id}`, {
    method: 'PATCH', cookie,
    body: (() => { const f = new FormData(); f.append('category', 'ai'); f.append('description', 'Обновлённое описание'); return f; })()
  });
  assert.equal(patchResponse.status, 200);
  assert.equal((await patchResponse.json()).description, 'Обновлённое описание');

  const deleteResponse = await request(`/api/certificates/${uploaded.id}`, { method: 'DELETE', cookie });
  assert.equal(deleteResponse.status, 200);

  const afterDelete = await (await request('/api/certificates?category=ai', { origin: null })).json();
  assert.equal(afterDelete.length, 0);
});

test('upload rejects a disallowed MIME type', async () => {
  const cookie = await login();
  const form = new FormData();
  form.append('id', '3fa85f64-5717-4562-b3fc-2c963f66afa7');
  form.append('category', 'ai');
  form.append('name', 'script.exe');
  form.append('description', '');
  form.append('file', new Blob([Buffer.from('MZ')], { type: 'application/x-msdownload' }), 'script.exe');

  const response = await request('/api/certificates', { method: 'POST', cookie, body: form });
  assert.equal(response.status, 400);
  assert.equal(fakeS3.objects.size, 0);
});

test('upload rejects a file larger than CERT_MAX_FILE_SIZE_MB', async () => {
  const cookie = await login();
  const bigBuffer = Buffer.alloc(2 * 1024 * 1024, 1); // 2MB > 1MB test limit
  const form = new FormData();
  form.append('id', '3fa85f64-5717-4562-b3fc-2c963f66afa8');
  form.append('category', 'ai');
  form.append('name', 'big.pdf');
  form.append('description', '');
  form.append('file', new Blob([bigBuffer], { type: 'application/pdf' }), 'big.pdf');

  const response = await request('/api/certificates', { method: 'POST', cookie, body: form });
  assert.equal(response.status, 400);
});

test('delete without a session cookie is rejected even with a valid Origin', async () => {
  const response = await request('/api/certificates/does-not-matter', { method: 'DELETE' });
  assert.equal(response.status, 401);
});

test('getCertificatesSummaryForAI aggregates all categories for the AI prompt context', async () => {
  const cookie = await login();
  const form = new FormData();
  form.append('id', '3fa85f64-5717-4562-b3fc-2c963f66afa9');
  form.append('category', 'code');
  form.append('name', 'Другой сертификат.pdf');
  form.append('description', 'Описание для AI');
  form.append('file', new Blob([Buffer.from('%PDF-1.4 fake')], { type: 'application/pdf' }), 'c.pdf');
  await request('/api/certificates', { method: 'POST', cookie, body: form });

  const summary = await certificates.getCertificatesSummaryForAI({ s3: fakeS3 });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].category, 'code');
  assert.equal(summary[0].description, 'Описание для AI');
});
