'use strict';

// Run: npm test   (uses only node:test — no network, no real S3).
// S3 is replaced with an in-process fake store. The owner session is
// obtained through the certificates router's existing /login endpoint,
// exactly as production reuses one owner login for both APIs.

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
process.env.PROJECTS_MAX_FILE_SIZE_MB = '1';
process.env.SESSION_SECRET = 'test-session-secret';
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('correct-password', 4);

const { createCertificatesRouter } = require('../lib/certificates');
const projects = require('../lib/projects');
const { createProjectsRouter, isValidCategory, isValidStatus, slugify, parseTags } = projects;

// --- Pure helpers ---------------------------------------------------------

test('isValidCategory only accepts the five known categories', () => {
  assert.equal(isValidCategory('ai'), true);
  assert.equal(isValidCategory('automation'), true);
  assert.equal(isValidCategory('other'), true);
  assert.equal(isValidCategory('bogus'), false);
  assert.equal(isValidCategory(''), false);
});

test('isValidStatus only accepts the four known statuses', () => {
  assert.equal(isValidStatus('MVP'), true);
  assert.equal(isValidStatus('Активный'), true);
  assert.equal(isValidStatus('Готово'), false);
});

test('slugify mirrors the client-side slug algorithm', () => {
  assert.equal(slugify('ResellFlow — автоматизация перепродажи'), 'resellflow-автоматизация-перепродажи');
  assert.equal(slugify('  Hello World!! '), 'hello-world');
  assert.equal(slugify(''), null);
});

test('parseTags splits, trims and caps a comma-separated tag string', () => {
  assert.deepEqual(parseTags('Node.js, TypeScript ,  , Express'), ['Node.js', 'TypeScript', 'Express']);
  assert.deepEqual(parseTags(''), []);
});

// --- In-memory fake S3 (shared by both routers, same bucket) --------------

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
  app.use('/api/projects', createProjectsRouter({ s3: fakeS3 }));
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

// A second app instance on the same fake S3 bucket for the later tests: the
// loginLimiter (10/15min, created fresh per createCertificatesRouter() call)
// would otherwise be exhausted by this file's many login() calls — same
// workaround test/certificates.test.js already uses.
let server2, base2;
before(async () => {
  const app2 = express();
  app2.use(express.json({ limit: '256kb' }));
  app2.use('/api/certificates', createCertificatesRouter({ s3: fakeS3 }));
  app2.use('/api/projects', createProjectsRouter({ s3: fakeS3 }));
  await new Promise((resolve) => { server2 = app2.listen(0, '127.0.0.1', resolve); });
  base2 = `http://127.0.0.1:${server2.address().port}`;
});
after(() => { server2.close(); });

function request2(pathname, { method = 'GET', origin = ORIGIN, cookie, body, headers = {} } = {}) {
  const finalHeaders = { ...headers };
  if (origin) finalHeaders.Origin = origin;
  if (cookie) finalHeaders.Cookie = cookie;
  return fetch(`${base2}${pathname}`, { method, headers: finalHeaders, body });
}

async function login2() {
  const response = await request2('/api/certificates/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'correct-password' })
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie, 'login must set a session cookie');
  return setCookie.split(';')[0];
}

function webpBlob(bytes = 'fake-webp-bytes') {
  return new Blob([Buffer.from(bytes)], { type: 'image/webp' });
}

const BASE_PROJECT = {
  id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  title: 'Тестовый проект',
  category: 'automation',
  summary: 'Краткое описание проекта'
};

function projectForm(overrides = {}) {
  const form = new FormData();
  const fields = { ...BASE_PROJECT, ...overrides };
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null) form.append(key, String(value));
  });
  return form;
}

// 1. GET of an empty list
test('GET /api/projects returns an empty array on an empty bucket', async () => {
  const response = await request('/api/projects', { origin: null });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});

// 2. project creation by the owner
test('POST /api/projects creates a project when authenticated as owner', async () => {
  const cookie = await login();
  const response = await request('/api/projects', { method: 'POST', cookie, body: projectForm() });
  assert.equal(response.status, 201);
  const row = await response.json();
  assert.equal(row.id, BASE_PROJECT.id);
  assert.equal(row.title, BASE_PROJECT.title);
  assert.equal(row.slug, 'тестовый-проект');
  assert.equal(row.status, 'MVP');
  assert.deepEqual(row.images, []);
});

// 3. POST rejected without an owner session
test('POST /api/projects without a session cookie is rejected with 401', async () => {
  const response = await request('/api/projects', { method: 'POST', body: projectForm() });
  assert.equal(response.status, 401);
  assert.equal(fakeS3.objects.size, 0);
});

// 3b. PATCH/DELETE rejected without an owner session (public read/write boundary audit).
// requireOwnerSession runs before the handler looks up the record, so a
// non-existent id still proves the auth boundary without depending on
// another test's fixture having run first.
test('PATCH /api/projects/:id without a session cookie is rejected with 401', async () => {
  const response = await request('/api/projects/does-not-matter', { method: 'PATCH', body: projectForm({ title: 'hacked by a public visitor' }) });
  assert.equal(response.status, 401);
});

test('DELETE /api/projects/:id without a session cookie is rejected with 401', async () => {
  const response = await request('/api/projects/does-not-matter', { method: 'DELETE' });
  assert.equal(response.status, 401);
});

// 4. Origin-check enforcement
test('POST /api/projects without Origin/Referer is rejected with 403 before touching S3', async () => {
  const cookie = await login();
  const response = await request('/api/projects', { method: 'POST', origin: null, cookie, body: projectForm({ id: 'ignored-by-403' }) });
  assert.equal(response.status, 403);
});

// 5. required-field validation
test('POST /api/projects rejects a missing required field (title)', async () => {
  const cookie = await login();
  const form = projectForm();
  form.delete('title');
  const response = await request('/api/projects', { method: 'POST', cookie, body: form });
  assert.equal(response.status, 400);
  assert.equal(fakeS3.objects.size, 0);
});

// 6. invalid category rejected
test('POST /api/projects rejects an invalid category', async () => {
  const cookie = await login();
  const response = await request('/api/projects', { method: 'POST', cookie, body: projectForm({ category: 'bogus' }) });
  assert.equal(response.status, 400);
});

// 7. invalid status rejected
test('POST /api/projects rejects an invalid status', async () => {
  const cookie = await login();
  const response = await request('/api/projects', { method: 'POST', cookie, body: projectForm({ status: 'Готово' }) });
  assert.equal(response.status, 400);
});

// 8. image MIME/size validation
test('POST /api/projects rejects a non-WebP cover and an oversized cover', async () => {
  const cookie = await login();

  const badMimeForm = projectForm({ id: '3fa85f64-5717-4562-b3fc-2c963f66afa7' });
  badMimeForm.append('cover', new Blob([Buffer.from('not-webp')], { type: 'image/png' }), 'cover.png');
  const badMimeResponse = await request('/api/projects', { method: 'POST', cookie, body: badMimeForm });
  assert.equal(badMimeResponse.status, 400);

  const bigForm = projectForm({ id: '3fa85f64-5717-4562-b3fc-2c963f66afa8' });
  bigForm.append('cover', new Blob([Buffer.alloc(2 * 1024 * 1024, 1)], { type: 'image/webp' }), 'big.webp');
  const bigResponse = await request('/api/projects', { method: 'POST', cookie, body: bigForm });
  assert.equal(bigResponse.status, 400);
});

// 9. list reflects a just-created project
test('GET /api/projects reflects a project just created by the owner', async () => {
  const cookie = await login();
  await request('/api/projects', { method: 'POST', cookie, body: projectForm() });
  const list = await (await request('/api/projects', { origin: null })).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, BASE_PROJECT.id);
});

// 10. update (PATCH)
test('PATCH /api/projects/:id updates fields and recomputes the slug on title change', async () => {
  const cookie = await login();
  await request('/api/projects', { method: 'POST', cookie, body: projectForm() });

  const patchForm = new FormData();
  patchForm.append('title', 'Обновленный проект');
  patchForm.append('summary', 'Новое краткое описание');
  const response = await request(`/api/projects/${BASE_PROJECT.id}`, { method: 'PATCH', cookie, body: patchForm });
  assert.equal(response.status, 200);
  const row = await response.json();
  assert.equal(row.title, 'Обновленный проект');
  assert.equal(row.summary, 'Новое краткое описание');
  assert.equal(row.slug, 'обновленный-проект');
  assert.equal(row.category, BASE_PROJECT.category, 'fields not sent in the PATCH stay unchanged');
});

// 11. delete
test('DELETE /api/projects/:id removes the project', async () => {
  const cookie = await login();
  await request('/api/projects', { method: 'POST', cookie, body: projectForm() });
  const response = await request(`/api/projects/${BASE_PROJECT.id}`, { method: 'DELETE', cookie });
  assert.equal(response.status, 200);
  const list = await (await request('/api/projects', { origin: null })).json();
  assert.equal(list.length, 0);
});

// 12. 404 handling
test('GET/PATCH/DELETE on a well-formed but non-existent id return 404', async () => {
  const cookie = await login();
  const missingId = '00000000-0000-4000-8000-000000000000';
  assert.equal((await request(`/api/projects/${missingId}`, { origin: null })).status, 404);
  assert.equal((await request(`/api/projects/${missingId}`, { method: 'PATCH', cookie, body: new FormData() })).status, 404);
  assert.equal((await request(`/api/projects/${missingId}`, { method: 'DELETE', cookie })).status, 404);
});

// 13. gallery image upload
test('POST /api/projects/:id/gallery uploads images and returns ready-made URLs', async () => {
  const cookie = await login2();
  await request2('/api/projects', { method: 'POST', cookie, body: projectForm() });

  const galleryForm = new FormData();
  galleryForm.append('gallery', webpBlob('image-1'), 'a.webp');
  galleryForm.append('gallery', webpBlob('image-2'), 'b.webp');
  const response = await request2(`/api/projects/${BASE_PROJECT.id}/gallery`, { method: 'POST', cookie, body: galleryForm });
  assert.equal(response.status, 201);
  const row = await response.json();
  assert.equal(row.images.length, 2);
  assert.ok(row.images[0].url.startsWith('https://cdn.example.test/projects/originals/'));
});

// 14. max-8-images gallery limit enforced
test('POST /api/projects/:id/gallery enforces the 8-image limit', async () => {
  const cookie = await login2();
  await request2('/api/projects', { method: 'POST', cookie, body: projectForm() });

  const firstBatch = new FormData();
  for (let i = 0; i < 8; i += 1) firstBatch.append('gallery', webpBlob(`img-${i}`), `${i}.webp`);
  const firstResponse = await request2(`/api/projects/${BASE_PROJECT.id}/gallery`, { method: 'POST', cookie, body: firstBatch });
  assert.equal(firstResponse.status, 201);
  assert.equal((await firstResponse.json()).images.length, 8);

  const extraForm = new FormData();
  extraForm.append('gallery', webpBlob('one-too-many'), 'extra.webp');
  const extraResponse = await request2(`/api/projects/${BASE_PROJECT.id}/gallery`, { method: 'POST', cookie, body: extraForm });
  assert.equal(extraResponse.status, 400);
});

// 15. deleting a single gallery image
test('DELETE /api/projects/:id/gallery/:imageId removes only that image', async () => {
  const cookie = await login2();
  await request2('/api/projects', { method: 'POST', cookie, body: projectForm() });
  const galleryForm = new FormData();
  galleryForm.append('gallery', webpBlob('image-1'), 'a.webp');
  galleryForm.append('gallery', webpBlob('image-2'), 'b.webp');
  const uploaded = await (await request2(`/api/projects/${BASE_PROJECT.id}/gallery`, { method: 'POST', cookie, body: galleryForm })).json();
  const [first, second] = uploaded.images;

  const response = await request2(`/api/projects/${BASE_PROJECT.id}/gallery/${first.id}`, { method: 'DELETE', cookie });
  assert.equal(response.status, 200);
  const row = await response.json();
  assert.equal(row.images.length, 1);
  assert.equal(row.images[0].id, second.id);
});

// 16. deleting a project cascades to remove its metadata AND all its media
test('DELETE /api/projects/:id removes the metadata, cover and every gallery object from S3', async () => {
  const cookie = await login2();
  const createForm = projectForm();
  createForm.append('cover', webpBlob('cover-bytes'), 'cover.webp');
  const created = await (await request2('/api/projects', { method: 'POST', cookie, body: createForm })).json();

  const galleryForm = new FormData();
  galleryForm.append('gallery', webpBlob('image-1'), 'a.webp');
  await request2(`/api/projects/${created.id}/gallery`, { method: 'POST', cookie, body: galleryForm });

  assert.ok([...fakeS3.objects.keys()].some((k) => k.includes(`projects/originals/${created.id}/`)), 'precondition: media stored');

  const deleteResponse = await request2(`/api/projects/${created.id}`, { method: 'DELETE', cookie });
  assert.equal(deleteResponse.status, 200);

  const remaining = [...fakeS3.objects.keys()].filter((k) => k.includes(created.id));
  assert.deepEqual(remaining, [], 'no metadata or media key for this project id should remain');
});

// 17. published:false projects are hidden from the public but visible to the owner
test('a draft (published:false) project is hidden from anonymous requests but visible to the owner', async () => {
  const cookie = await login2();
  await request2('/api/projects', { method: 'POST', cookie, body: projectForm({ published: 'false' }) });

  const publicList = await (await request2('/api/projects', { origin: null })).json();
  assert.equal(publicList.length, 0);
  const publicDetail = await request2(`/api/projects/${BASE_PROJECT.id}`, { origin: null });
  assert.equal(publicDetail.status, 404);

  const ownerList = await (await request2('/api/projects', { origin: null, cookie })).json();
  assert.equal(ownerList.length, 1);
  assert.equal(ownerList[0].published, false);
  const ownerDetail = await request2(`/api/projects/${BASE_PROJECT.id}`, { origin: null, cookie });
  assert.equal(ownerDetail.status, 200);
});

// 18-20. description/goal/result preserve structural line breaks (paragraphs,
// "## heading" lines, "- list item" lines) across POST, GET and PATCH, which
// renderRich() on the client depends on to render headings/lists/paragraphs.
test('description/goal/result preserve structural line breaks across POST, GET and PATCH', async () => {
  const cookie = await login2();
  const multiline = 'Абзац 1.\n\n## Возможности\n\n- пункт 1\n- пункт 2';
  const id = '3fa85f64-5717-4562-b3fc-2c963f66afc0';
  const createForm = projectForm({ id, description: multiline, goal: 'Строка 1\nСтрока 2', result: 'Результат 1\nРезультат 2' });
  const created = await (await request2('/api/projects', { method: 'POST', cookie, body: createForm })).json();
  assert.equal(created.description, multiline);
  assert.equal(created.goal, 'Строка 1\nСтрока 2');
  assert.equal(created.result, 'Результат 1\nРезультат 2');

  // GET /api/projects/:id returns the exact same structural line breaks
  const fetched = await (await request2(`/api/projects/${id}`, { origin: null })).json();
  assert.equal(fetched.description, multiline);
  assert.equal(fetched.goal, 'Строка 1\nСтрока 2');
  assert.equal(fetched.result, 'Результат 1\nРезультат 2');

  // PATCH description preserves (and can extend) the line breaks
  const updatedMultiline = multiline + '\n\n## Ещё раздел\n\n- пункт 3';
  const patchForm = new FormData();
  patchForm.append('description', updatedMultiline);
  const patched = await (await request2(`/api/projects/${id}`, { method: 'PATCH', cookie, body: patchForm })).json();
  assert.equal(patched.description, updatedMultiline);
  assert.equal(patched.goal, 'Строка 1\nСтрока 2', 'goal untouched by a description-only PATCH keeps its line breaks');
});

// 21. control characters (NUL etc.) are still stripped/normalized in multiline fields
test('cleanMultilineText still strips control characters and normalizes CRLF/CR to \\n', async () => {
  const cookie = await login2();
  const dirty = 'Строка1\r\nСтрока2\rСтрока3\u0000\u0007 с хвостом\tзапрещённых\u007F символов';
  const id = '3fa85f64-5717-4562-b3fc-2c963f66afc2';
  const form = projectForm({ id, description: dirty });
  const created = await (await request2('/api/projects', { method: 'POST', cookie, body: form })).json();
  assert.equal(created.description.includes('\r'), false);
  assert.equal(created.description.includes('\u0000'), false);
  assert.equal(created.description.includes('\u0007'), false);
  assert.equal(created.description.includes('\t'), false);
  assert.equal(created.description.includes('\u007F'), false);
  assert.equal(created.description, 'Строка1\nСтрока2\nСтрока3   с хвостом запрещённых  символов');
});
