// Projects backend: Timeweb Cloud S3 storage for the "Проекты" section,
// reusing the same bucket/credentials/owner-session as lib/certificates.js
// (different key prefix: projects/... vs originals/.../metadata/...).
// One JSON metadata object per project, no managed database.
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command
} = require('@aws-sdk/client-s3');
const {
  createS3Client,
  requireSameOrigin,
  requireOwnerSession,
  verifySession,
  parseCookies,
  publicUrlFor
} = require('./certificates');

// Must match the COOKIE_NAME private constant in lib/certificates.js — the
// owner session is intentionally shared across /api/certificates and
// /api/projects (one owner, one login, one cookie; see serializeCookie()'s
// Path='/api' in lib/certificates.js).
const COOKIE_NAME = 'cert_admin';

const CATEGORIES = ['ai', 'automation', 'web', 'data', 'other'];
const STATUSES = ['В разработке', 'MVP', 'Завершён', 'Активный'];
const IMAGE_MIME = 'image/webp';
const GALLERY_LIMIT = 8;
const MAX_TITLE_LENGTH = 120;
const MAX_SUMMARY_LENGTH = 400;
const MAX_DESCRIPTION_LENGTH = 10000;
const MAX_GOAL_LENGTH = 1000;
const MAX_RESULT_LENGTH = 1000;
const MAX_TAG_LENGTH = 60;
const MAX_TAGS = 20;
const MAX_URL_LENGTH = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}
function isValidCategory(category) {
  return CATEGORIES.includes(category);
}
function isValidStatus(status) {
  return STATUSES.includes(status);
}
function cleanSingleLineText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxLength);
}
// Like cleanSingleLineText, but preserves line breaks (needed for
// description/goal/result, which renderRich() on the client splits into
// paragraphs/headings/lists on \n). CRLF/CR are normalized to \n first, then
// every other control character (NUL, tabs, etc.) is stripped same as above.
function cleanMultilineText(value, maxLength) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, maxLength);
}
// Mirrors the client-side slug generation already used in index.html's
// editor.onsubmit, so a slug computed here matches one computed there.
function slugify(title) {
  const slug = String(title || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  return slug || null;
}
function parseTags(value) {
  if (Array.isArray(value)) value = value.join(',');
  return String(value || '')
    .split(',')
    .map((tag) => cleanSingleLineText(tag, MAX_TAG_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
}
function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'off', 'no', ''].includes(normalized)) return false;
  return fallback;
}
function cleanUrl(value) {
  const cleaned = cleanSingleLineText(value, MAX_URL_LENGTH);
  return cleaned || null;
}

function metadataKey(id) {
  return `projects/metadata/${id}.json`;
}
function coverKey(id) {
  return `projects/originals/${id}/cover.webp`;
}
function galleryKey(id, imageId) {
  return `projects/originals/${id}/gallery/${imageId}.webp`;
}

function toApiRow(record, publicBaseUrl, { includeImages = false } = {}) {
  const row = {
    id: record.id,
    title: record.title,
    slug: record.slug,
    category: record.category,
    summary: record.summary,
    description: record.description,
    goal: record.goal || null,
    result: record.result || null,
    status: record.status,
    tags: record.tags || [],
    cover_url: record.cover_path ? publicUrlFor(publicBaseUrl, record.cover_path) : '',
    project_url: record.project_url || null,
    github_url: record.github_url || null,
    demo_url: record.demo_url || null,
    published: record.published !== false,
    sort_order: record.sort_order || 0,
    created_at: record.created_at,
    updated_at: record.updated_at
  };
  if (includeImages) {
    row.images = (record.gallery || []).map((g) => ({
      id: g.id,
      alt_text: g.alt_text || '',
      sort_order: g.sort_order || 0,
      url: publicUrlFor(publicBaseUrl, galleryKey(record.id, g.id))
    }));
  }
  return row;
}

async function streamToString(body) {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
async function getMetadata(s3, bucket, id) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: metadataKey(id) }));
    return JSON.parse(await streamToString(res.Body));
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}
async function putMetadata(s3, bucket, id, record) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: metadataKey(id),
    Body: JSON.stringify(record),
    ContentType: 'application/json'
  }));
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
async function listAllRecords(s3, bucket) {
  const keys = await listKeys(s3, bucket, 'projects/metadata/');
  const records = await Promise.all(
    keys.map(async (key) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return JSON.parse(await streamToString(res.Body));
    })
  );
  return records;
}
async function findSlugConflict(s3, bucket, slug, excludeId) {
  if (!slug) return false;
  const records = await listAllRecords(s3, bucket);
  return records.some((r) => r.slug === slug && r.id !== excludeId);
}

function isOwnerRequest(req) {
  return !!verifySession(parseCookies(req.get('cookie'))[COOKIE_NAME]);
}

function createProjectsRouter(options = {}) {
  const router = express.Router();
  const s3 = options.s3 || createS3Client();
  const bucket = process.env.S3_BUCKET_CERTIFICATES;
  const publicBaseUrl = process.env.S3_PUBLIC_BASE_URL;
  const maxFileSizeBytes = (Number(process.env.PROJECTS_MAX_FILE_SIZE_MB) || 5) * 1024 * 1024;

  const uploadCover = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSizeBytes, files: 1 }
  }).fields([{ name: 'cover', maxCount: 1 }]);
  const uploadGallery = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxFileSizeBytes, files: GALLERY_LIMIT }
  }).fields([{ name: 'gallery', maxCount: GALLERY_LIMIT }]);

  function handleUploadError(err, req, res, next) {
    if (err && err.name === 'MulterError') {
      return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл превышает допустимый размер.' : 'Некорректная загрузка файла.' });
    }
    return next(err);
  }

  // Validates and normalizes the shared set of editable text fields. Used by
  // both POST (all required) and PATCH (only provided fields checked).
  function readFields(body, { partial }) {
    const out = {};
    const has = (key) => body?.[key] !== undefined;

    if (!partial || has('title')) {
      const title = cleanSingleLineText(body?.title, MAX_TITLE_LENGTH);
      if (!title) return { error: 'Название проекта обязательно.' };
      out.title = title;
    }
    if (!partial || has('category')) {
      const category = String(body?.category || '');
      if (!isValidCategory(category)) return { error: 'Некорректная категория.' };
      out.category = category;
    }
    if (!partial || has('summary')) {
      const summary = cleanSingleLineText(body?.summary, MAX_SUMMARY_LENGTH);
      if (!summary) return { error: 'Краткое описание обязательно.' };
      out.summary = summary;
    }
    if (!partial || has('description') || has('summary')) {
      const description = cleanMultilineText(body?.description, MAX_DESCRIPTION_LENGTH) || out.summary || '';
      out.description = description;
    }
    if (has('goal')) out.goal = cleanMultilineText(body.goal, MAX_GOAL_LENGTH) || null;
    if (has('result')) out.result = cleanMultilineText(body.result, MAX_RESULT_LENGTH) || null;
    if (!partial || has('status')) {
      const status = String(body?.status || 'MVP');
      if (!isValidStatus(status)) return { error: 'Некорректный статус.' };
      out.status = status;
    }
    if (has('tags')) out.tags = parseTags(body.tags);
    if (has('project_url')) out.project_url = cleanUrl(body.project_url);
    if (has('github_url')) out.github_url = cleanUrl(body.github_url);
    if (has('demo_url')) out.demo_url = cleanUrl(body.demo_url);
    if (has('published')) out.published = parseBoolean(body.published, true);
    if (has('sort_order')) out.sort_order = Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0;
    return { value: out };
  }

  router.get('/', async (req, res) => {
    try {
      const owner = isOwnerRequest(req);
      const records = (await listAllRecords(s3, bucket))
        .filter((r) => owner || r.published !== false)
        .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0) || new Date(b.created_at) - new Date(a.created_at));
      res.json(records.map((record) => toApiRow(record, publicBaseUrl)));
    } catch (error) {
      console.error('Projects list error:', error);
      res.status(502).json({ error: 'Не удалось получить список проектов.' });
    }
  });

  router.get('/:id', async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!isValidId(id)) return res.status(400).json({ error: 'Некорректный id проекта.' });
      const record = await getMetadata(s3, bucket, id);
      if (!record) return res.status(404).json({ error: 'Проект не найден.' });
      if (record.published === false && !isOwnerRequest(req)) return res.status(404).json({ error: 'Проект не найден.' });
      res.json(toApiRow(record, publicBaseUrl, { includeImages: true }));
    } catch (error) {
      console.error('Project detail error:', error);
      res.status(502).json({ error: 'Не удалось получить проект.' });
    }
  });

  router.post('/', requireSameOrigin, requireOwnerSession, uploadCover, handleUploadError, async (req, res) => {
    try {
      const id = String(req.body?.id || '');
      if (!isValidId(id)) return res.status(400).json({ error: 'Некорректный id проекта.' });

      const fields = readFields(req.body, { partial: false });
      if (fields.error) return res.status(400).json({ error: fields.error });

      const existing = await getMetadata(s3, bucket, id);
      if (existing) return res.status(409).json({ error: 'Проект с таким id уже существует.' });

      const slug = slugify(fields.value.title) || id;
      if (await findSlugConflict(s3, bucket, slug, id)) {
        return res.status(409).json({ error: 'Проект с похожим названием (slug) уже существует.' });
      }

      let coverPath = null;
      const coverFile = req.files?.cover?.[0];
      if (coverFile) {
        if (coverFile.mimetype !== IMAGE_MIME) return res.status(400).json({ error: 'Обложка должна быть в формате WebP.' });
        coverPath = coverKey(id);
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: coverPath, Body: coverFile.buffer, ContentType: IMAGE_MIME }));
      }

      const now = new Date().toISOString();
      const record = { id, slug, ...fields.value, cover_path: coverPath, gallery: [], created_at: now, updated_at: now };
      await putMetadata(s3, bucket, id, record);
      res.status(201).json(toApiRow(record, publicBaseUrl, { includeImages: true }));
    } catch (error) {
      console.error('Project create error:', error);
      res.status(500).json({ error: 'Не удалось сохранить проект.' });
    }
  });

  router.patch('/:id', requireSameOrigin, requireOwnerSession, uploadCover, handleUploadError, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!isValidId(id)) return res.status(400).json({ error: 'Некорректный id проекта.' });
      const record = await getMetadata(s3, bucket, id);
      if (!record) return res.status(404).json({ error: 'Проект не найден.' });

      const fields = readFields(req.body, { partial: true });
      if (fields.error) return res.status(400).json({ error: fields.error });

      let slug = record.slug;
      if (fields.value.title && fields.value.title !== record.title) {
        slug = slugify(fields.value.title) || record.slug;
        if (await findSlugConflict(s3, bucket, slug, id)) {
          return res.status(409).json({ error: 'Проект с похожим названием (slug) уже существует.' });
        }
      }

      let coverPath = record.cover_path;
      const coverFile = req.files?.cover?.[0];
      if (coverFile) {
        if (coverFile.mimetype !== IMAGE_MIME) return res.status(400).json({ error: 'Обложка должна быть в формате WebP.' });
        coverPath = coverKey(id);
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: coverPath, Body: coverFile.buffer, ContentType: IMAGE_MIME }));
      }

      const updated = { ...record, ...fields.value, slug, cover_path: coverPath, updated_at: new Date().toISOString() };
      await putMetadata(s3, bucket, id, updated);
      res.json(toApiRow(updated, publicBaseUrl, { includeImages: true }));
    } catch (error) {
      console.error('Project update error:', error);
      res.status(500).json({ error: 'Не удалось обновить проект.' });
    }
  });

  router.delete('/:id', requireSameOrigin, requireOwnerSession, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!isValidId(id)) return res.status(400).json({ error: 'Некорректный id проекта.' });
      const record = await getMetadata(s3, bucket, id);
      if (!record) return res.status(404).json({ error: 'Проект не найден.' });

      const keys = [metadataKey(id)];
      if (record.cover_path) keys.push(record.cover_path);
      (record.gallery || []).forEach((g) => keys.push(galleryKey(id, g.id)));
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
      res.json({ ok: true });
    } catch (error) {
      console.error('Project delete error:', error);
      res.status(500).json({ error: 'Не удалось удалить проект.' });
    }
  });

  router.post('/:id/gallery', requireSameOrigin, requireOwnerSession, uploadGallery, handleUploadError, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      if (!isValidId(id)) return res.status(400).json({ error: 'Некорректный id проекта.' });
      const record = await getMetadata(s3, bucket, id);
      if (!record) return res.status(404).json({ error: 'Проект не найден.' });

      const files = req.files?.gallery || [];
      if (!files.length) return res.status(400).json({ error: 'Нет файлов для загрузки.' });
      const existingCount = (record.gallery || []).length;
      if (existingCount + files.length > GALLERY_LIMIT) {
        return res.status(400).json({ error: `Превышен лимит галереи: максимум ${GALLERY_LIMIT} изображений.` });
      }
      for (const file of files) {
        if (file.mimetype !== IMAGE_MIME) return res.status(400).json({ error: 'Изображения галереи должны быть в формате WebP.' });
      }

      const gallery = [...(record.gallery || [])];
      for (const file of files) {
        const imageId = crypto.randomUUID();
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: galleryKey(id, imageId), Body: file.buffer, ContentType: IMAGE_MIME }));
        gallery.push({ id: imageId, alt_text: '', sort_order: gallery.length });
      }

      const updated = { ...record, gallery, updated_at: new Date().toISOString() };
      await putMetadata(s3, bucket, id, updated);
      res.status(201).json(toApiRow(updated, publicBaseUrl, { includeImages: true }));
    } catch (error) {
      console.error('Project gallery upload error:', error);
      res.status(500).json({ error: 'Не удалось загрузить изображения галереи.' });
    }
  });

  router.delete('/:id/gallery/:imageId', requireSameOrigin, requireOwnerSession, async (req, res) => {
    try {
      const id = String(req.params.id || '');
      const imageId = String(req.params.imageId || '');
      if (!isValidId(id)) return res.status(400).json({ error: 'Некорректный id проекта.' });
      const record = await getMetadata(s3, bucket, id);
      if (!record) return res.status(404).json({ error: 'Проект не найден.' });

      const gallery = record.gallery || [];
      if (!gallery.some((g) => g.id === imageId)) return res.status(404).json({ error: 'Изображение не найдено.' });

      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: [{ Key: galleryKey(id, imageId) }] } }));
      const updated = { ...record, gallery: gallery.filter((g) => g.id !== imageId), updated_at: new Date().toISOString() };
      await putMetadata(s3, bucket, id, updated);
      res.json(toApiRow(updated, publicBaseUrl, { includeImages: true }));
    } catch (error) {
      console.error('Project gallery delete error:', error);
      res.status(500).json({ error: 'Не удалось удалить изображение.' });
    }
  });

  return router;
}

module.exports = {
  createProjectsRouter,
  CATEGORIES,
  STATUSES,
  IMAGE_MIME,
  GALLERY_LIMIT,
  isValidId,
  isValidCategory,
  isValidStatus,
  slugify,
  parseTags,
  parseBoolean,
  metadataKey,
  coverKey,
  galleryKey,
  toApiRow,
  getMetadata,
  putMetadata,
  listAllRecords
};
