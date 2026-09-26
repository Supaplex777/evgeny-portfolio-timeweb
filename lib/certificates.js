// Certificates backend: Timeweb Cloud S3 storage for files + one JSON metadata
// object per certificate (no managed database). Mounted at /api/certificates.
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');

const CATEGORIES = ['ai', 'code', 'data', 'test', 'basic', 'new'];
const ALLOWED_ORIGINAL_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp']);
const PREVIEW_MIME = 'image/webp';
const MAX_NAME_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const COOKIE_NAME = 'cert_admin';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

// Client-generated ids are either crypto.randomUUID() or the legacy
// Date.now()+'-'+Math.random() fallback used by older browsers (see index.html).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGACY_ID_RE = /^[0-9]{10,16}-0\.[0-9]{1,20}$/;

function isValidId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 80 && (UUID_RE.test(id) || LEGACY_ID_RE.test(id));
}
function isValidCategory(category) {
  return CATEGORIES.includes(category);
}
function cleanText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxLength);
}

// Mirrors the client-side safeFileName() in public/index.html so stored
// filenames look the same as before the migration.
function safeFileName(name) {
  const ext = (String(name).match(/\.[a-z0-9]{1,8}$/i) || [''])[0].toLowerCase();
  const stem = String(name)
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'document';
  return stem + ext;
}

function originalKey(category, id, fileName) {
  return `originals/${category}/${id}/${fileName}`;
}
function previewKey(category, id) {
  return `previews/${category}/${id}.webp`;
}
function metadataKey(category, id) {
  return `metadata/${category}/${id}.json`;
}
function publicUrlFor(base, key) {
  if (!key) return '';
  return `${String(base || '').replace(/\/+$/, '')}/${key}`;
}

function toApiRow(record, publicBaseUrl) {
  return {
    id: record.id,
    category: record.category,
    name: record.name,
    type: record.type || '',
    created_at: record.created_at,
    description: record.description || '',
    fileUrl: record.file_path ? publicUrlFor(publicBaseUrl, record.file_path) : '',
    previewUrl: record.preview_path ? publicUrlFor(publicBaseUrl, record.preview_path) : ''
  };
}

function createS3Client() {
  return new S3Client({
    endpoint: process.env.S3_ENDPOINT,
    region: process.env.S3_REGION || 'ru-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
    }
  });
}

async function streamToString(body) {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function getMetadata(s3, bucket, category, id) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: metadataKey(category, id) }));
    return JSON.parse(await streamToString(res.Body));
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}
async function putMetadata(s3, bucket, category, id, record) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: metadataKey(category, id),
    Body: JSON.stringify(record),
    ContentType: 'application/json'
  }));
}
async function findCategoryForId(s3, bucket, id) {
  const results = await Promise.all(
    CATEGORIES.map(async (category) => {
      const record = await getMetadata(s3, bucket, category, id);
      return record ? { category, record } : null;
    })
  );
  return results.find(Boolean) || null;
}
async function locateCertificate(s3, bucket, id, hintCategory) {
  if (hintCategory && isValidCategory(hintCategory)) {
    const record = await getMetadata(s3, bucket, hintCategory, id);
    if (record) return { category: hintCategory, record };
  }
  return findCategoryForId(s3, bucket, id);
}

async function listKeys(s3, bucket, prefix) {
  const keys = [];
  let token;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    (res.Contents || []).forEach((object) => keys.push(object.Key));
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}
async function listCategoryRecords(s3, bucket, category) {
  const keys = await listKeys(s3, bucket, `metadata/${category}/`);
  const records = await Promise.all(
    keys.map(async (key) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return JSON.parse(await streamToString(res.Body));
    })
  );
  return records;
}
async function listAllRecords(s3, bucket) {
  const all = await Promise.all(CATEGORIES.map((category) => listCategoryRecords(s3, bucket, category)));
  return all.flat();
}
async function listCounts(s3, bucket) {
  const keys = await listKeys(s3, bucket, 'metadata/');
  const counts = {};
  CATEGORIES.forEach((category) => { counts[category] = 0; });
  keys.forEach((key) => {
    const match = key.match(/^metadata\/([a-z]+)\//);
    if (match && Object.prototype.hasOwnProperty.call(counts, match[1])) counts[match[1]]++;
  });
  return counts;
}

// --- Session signing (HMAC, no session store — single owner) ---
function base64url(input) {
  return Buffer.from(input).toString('base64url');
}
function signSession(payload) {
  const body = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}
function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const index = part.indexOf('=');
    if (index === -1) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) { try { out[key] = decodeURIComponent(value); } catch { out[key] = value; } }
  });
  return out;
}
function serializeCookie(name, value, maxAgeMs) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/api/certificates', 'HttpOnly', 'SameSite=Strict', 'Secure'];
  if (maxAgeMs) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  return parts.join('; ');
}

function allowedOrigins() {
  return String(process.env.CERT_ALLOWED_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
}
function requireSameOrigin(req, res, next) {
  const allowed = allowedOrigins();
  if (!allowed.length) return res.status(500).json({ error: 'CERT_ALLOWED_ORIGIN не настроен на сервере.' });
  const origin = req.get('origin');
  if (origin) {
    if (allowed.includes(origin)) return next();
    return res.status(403).json({ error: 'Запрос с недопустимого источника.' });
  }
  const referer = req.get('referer') || '';
  if (allowed.some((value) => referer.startsWith(value))) return next();
  return res.status(403).json({ error: 'Запрос без допустимого Origin/Referer отклонён.' });
}
function requireOwnerSession(req, res, next) {
  const cookies = parseCookies(req.get('cookie'));
  const payload = verifySession(cookies[COOKIE_NAME]);
  if (!payload) return res.status(401).json({ error: 'Требуется вход владельца.' });
  next();
}

function createCertificatesRouter(options = {}) {
  const router = express.Router();
  const s3 = options.s3 || createS3Client();
  const bucket = process.env.S3_BUCKET_CERTIFICATES;
  const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: (Number(process.env.CERT_MAX_FILE_SIZE_MB) || 15) * 1024 * 1024, files: 2 }
  });
  const uploadFields = upload.fields([{ name: 'file', maxCount: 1 }, { name: 'preview', maxCount: 1 }]);
  const uploadPreviewOnly = upload.fields([{ name: 'preview', maxCount: 1 }]);

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Слишком много попыток входа. Попробуйте позже.' }
  });

  function handleUploadError(err, req, res, next) {
    if (err && err.name === 'MulterError') {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл превышает допустимый размер.' : 'Некорректная загрузка файла.' });
    }
    return next(err);
  }

  // Body is already parsed by the app-level express.json() middleware in server.js.
  router.post('/login', requireSameOrigin, loginLimiter, async (req, res) => {
    const password = String(req.body?.password || '');
    const hash = process.env.ADMIN_PASSWORD_HASH;
    if (!hash) return res.status(500).json({ error: 'ADMIN_PASSWORD_HASH не настроен на сервере.' });
    if (!password) return res.status(400).json({ error: 'Введите пароль.' });
    const ok = await bcrypt.compare(password, hash).catch(() => false);
    if (!ok) return res.status(401).json({ error: 'Неверный пароль.' });
    res.setHeader('Set-Cookie', serializeCookie(COOKIE_NAME, signSession({ exp: Date.now() + SESSION_TTL_MS }), SESSION_TTL_MS));
    res.json({ ok: true });
  });

  router.get('/session', (req, res) => {
    const payload = verifySession(parseCookies(req.get('cookie'))[COOKIE_NAME]);
    res.json({ authenticated: !!payload });
  });

  router.get('/counts', async (req, res) => {
    try {
      res.json(await listCounts(s3, bucket));
    } catch (error) {
      console.error('Certificates counts error:', error);
      res.status(502).json({ error: 'Не удалось получить счётчики сертификатов.' });
    }
  });

  router.get('/', async (req, res) => {
    const category = String(req.query.category || '');
    if (!isValidCategory(category)) return res.status(400).json({ error: 'Некорректная категория.' });
    try {
      const records = await listCategoryRecords(s3, bucket, category);
      records.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      res.json(records.map((record) => toApiRow(record, publicBaseUrl)));
    } catch (error) {
      console.error('Certificates list error:', error);
      res.status(502).json({ error: 'Не удалось получить список сертификатов.' });
    }
  });

  router.post('/', requireSameOrigin, requireOwnerSession, uploadFields, handleUploadError, async (req, res) => {
    try {
      const category = String(req.body?.category || '');
      const id = String(req.body?.id || '');
      const name = cleanText(req.body?.name, MAX_NAME_LENGTH);
      const description = cleanText(req.body?.description, MAX_DESCRIPTION_LENGTH);
      const createdRaw = req.body?.created;
      const created = createdRaw && !Number.isNaN(Number(createdRaw)) ? new Date(Number(createdRaw)) : new Date();

      if (!isValidCategory(category)) return res.status(400).json({ error: 'Некорректная категория.' });
      if (!isValidId(id)) return res.status(400).json({ error: 'Некорректный id сертификата.' });
      if (!name) return res.status(400).json({ error: 'Название сертификата обязательно.' });

      const file = req.files?.file?.[0];
      if (!file) return res.status(400).json({ error: 'Файл сертификата обязателен.' });
      if (!ALLOWED_ORIGINAL_MIME.has(file.mimetype)) return res.status(400).json({ error: 'Недопустимый тип файла.' });

      const existing = await getMetadata(s3, bucket, category, id);
      if (existing) return res.status(409).json({ error: 'Сертификат с таким id уже существует.' });

      const fileKey = originalKey(category, id, safeFileName(name));
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: fileKey, Body: file.buffer, ContentType: file.mimetype }));

      let previewPath = null;
      const previewFile = req.files?.preview?.[0];
      if (previewFile) {
        if (previewFile.mimetype !== PREVIEW_MIME) return res.status(400).json({ error: 'Превью должно быть в формате WebP.' });
        previewPath = previewKey(category, id);
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: previewPath, Body: previewFile.buffer, ContentType: PREVIEW_MIME }));
      }

      const record = {
        id, category, name, type: file.mimetype,
        created_at: created.toISOString(), description,
        file_path: fileKey, preview_path: previewPath
      };
      await putMetadata(s3, bucket, category, id, record);
      res.status(201).json(toApiRow(record, publicBaseUrl));
    } catch (error) {
      console.error('Certificate upload error:', error);
      res.status(500).json({ error: 'Не удалось сохранить сертификат.' });
    }
  });

  router.patch('/:id', requireSameOrigin, requireOwnerSession, uploadPreviewOnly, handleUploadError, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!isValidId(id)) return res.status(400).json({ error: 'Некорректный id сертификата.' });
      const located = await locateCertificate(s3, bucket, id, req.body?.category);
      if (!located) return res.status(404).json({ error: 'Сертификат не найден.' });
      const { category, record } = located;

      const description = req.body?.description !== undefined
        ? cleanText(req.body.description, MAX_DESCRIPTION_LENGTH)
        : record.description;

      let previewPath = record.preview_path;
      const previewFile = req.files?.preview?.[0];
      if (previewFile) {
        if (previewFile.mimetype !== PREVIEW_MIME) return res.status(400).json({ error: 'Превью должно быть в формате WebP.' });
        previewPath = previewKey(category, id);
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: previewPath, Body: previewFile.buffer, ContentType: PREVIEW_MIME }));
      }

      const updated = { ...record, description, preview_path: previewPath };
      await putMetadata(s3, bucket, category, id, updated);
      res.json(toApiRow(updated, publicBaseUrl));
    } catch (error) {
      console.error('Certificate update error:', error);
      res.status(500).json({ error: 'Не удалось обновить сертификат.' });
    }
  });

  router.delete('/:id', requireSameOrigin, requireOwnerSession, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!isValidId(id)) return res.status(400).json({ error: 'Некорректный id сертификата.' });
      const located = await locateCertificate(s3, bucket, id, req.query?.category);
      if (!located) return res.status(404).json({ error: 'Сертификат не найден.' });
      const { category, record } = located;

      const keys = [metadataKey(category, id)];
      if (record.file_path) keys.push(record.file_path);
      if (record.preview_path) keys.push(record.preview_path);
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
      res.json({ ok: true });
    } catch (error) {
      console.error('Certificate delete error:', error);
      res.status(500).json({ error: 'Не удалось удалить сертификат.' });
    }
  });

  return router;
}

// Used by /api/ai to build the certificatesContext for the assistant prompt.
async function getCertificatesSummaryForAI(options = {}) {
  const s3 = options.s3 || createS3Client();
  const bucket = process.env.S3_BUCKET_CERTIFICATES;
  const records = await listAllRecords(s3, bucket);
  records.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return records.map((record) => ({
    category: record.category,
    name: record.name,
    description: record.description,
    created_at: record.created_at
  }));
}

module.exports = {
  createCertificatesRouter,
  getCertificatesSummaryForAI,
  CATEGORIES,
  ALLOWED_ORIGINAL_MIME,
  PREVIEW_MIME,
  isValidId,
  isValidCategory,
  safeFileName,
  originalKey,
  previewKey,
  metadataKey,
  publicUrlFor,
  toApiRow,
  signSession,
  verifySession,
  parseCookies,
  serializeCookie,
  allowedOrigins,
  requireSameOrigin,
  requireOwnerSession,
  createS3Client,
  getMetadata,
  putMetadata,
  locateCertificate,
  listCategoryRecords,
  listAllRecords,
  listCounts
};
