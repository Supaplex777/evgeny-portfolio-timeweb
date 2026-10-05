#!/usr/bin/env node
// One-off, idempotent seed: creates the real ResellFlow project in the
// /api/projects backend (same Timeweb Cloud S3 bucket, same metadata/key
// scheme as lib/projects.js). Safe to run more than once: if a ResellFlow
// project already exists (matched by slug or title, same predicate as the
// frontend's dedup logic), it creates nothing and exits successfully.
//
// This script does NOT run automatically anywhere (no server-startup hook).
// It must be run manually, on purpose, with real production env vars.
//
// Required environment variables (same ones /api/projects uses):
//   S3_ENDPOINT, S3_REGION, S3_BUCKET_CERTIFICATES,
//   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PUBLIC_BASE_URL
//
// Usage:
//   npm run seed:resellflow

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { createS3Client } = require('../lib/certificates');
const {
  listAllRecords, getMetadata, putMetadata, coverKey, slugify, toApiRow
} = require('../lib/projects');

const COVER_FILE = path.join(__dirname, '..', 'public', 'assets', 'resellflow-cover.webp');

// Current/approved ResellFlow data (description/goal/result reused verbatim
// from the resellflow placeholder object in public/index.html).
const RESELLFLOW_DATA = {
  title: 'ResellFlow — автоматизация перепродажи цифровых товаров',
  category: 'automation',
  summary: 'Система автоматизации продаж цифровых товаров: синхронизация маркетплейса и поставщика, сопоставление каталога, расчёт экономики, обработка заказов и защищённый AUTO LIVE.',
  description: 'ResellFlow — backend-система автоматизации перепродажи цифровых товаров. Проект связывает маркетплейс GGSEL и поставщика FoxReload, синхронизирует каталог, сопоставляет товары, рассчитывает экономику сделки и автоматически обрабатывает заказы. Реализованы MULTI-карточки с несколькими номиналами, readiness-проверки, UID-маршрутизация, защита от повторных покупок, двухэтапная схема create→pay, polling/reconcile, лимиты цены и суммы заказа, контроль прибыли, резерв баланса и аварийный kill switch.',
  goal: 'Автоматизировать рутинную работу продавца цифровых товаров и создать безопасную систему, которая сама получает заказ, определяет нужный вариант товара, проверяет экономику и выполняет закупку у поставщика только при выполнении всех защитных условий.',
  result: 'Рабочая система развёрнута на VPS. Реализованы синхронизация GGSEL, интеграция с FoxReload, административная панель, MULTI-карточки, readiness, AUTO LIVE, polling, защита от дублей и почти 500 автоматических тестов. В рабочей карточке Free Fire CIS настроены варианты 110 и 231 Diamonds, оба переведены в LIVE.',
  status: 'Активный',
  tags: ['Node.js', 'TypeScript', 'JavaScript', 'Express', 'SQLite', 'REST API', 'GGSEL API', 'FoxReload API', 'Linux', 'VPS', 'systemd', 'Git', 'GitHub', 'Automation'],
  published: true
};

// Same predicate the frontend's load() uses to decide whether the static
// ResellFlow placeholder should hide itself — kept in sync on purpose.
function isResellflowRecord(record) {
  const slug = String(record.slug || '').trim().toLowerCase();
  const title = String(record.title || '').trim().toLowerCase();
  return slug === 'resellflow' || slug.startsWith('resellflow-') ||
    title === 'resellflow' || title.startsWith('resellflow ') ||
    title.startsWith('resellflow —') || title.startsWith('resellflow -');
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Отсутствует обязательная переменная окружения: ${name}`);
  return value;
}

async function findExisting(s3, bucket) {
  const records = await listAllRecords(s3, bucket);
  return records.find(isResellflowRecord) || null;
}

async function coverExists(s3, bucket, key) {
  if (!key) return false;
  try {
    await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return false;
    throw error;
  }
}

async function verify(s3, bucket, publicBaseUrl, id) {
  const issues = [];
  const record = await getMetadata(s3, bucket, id);
  if (!record) { issues.push('metadata не читается обратно из S3'); return { ok: false, issues, record: null, row: null }; }
  if (!isResellflowRecord(record)) issues.push(`slug/title не распознаются как ResellFlow (slug=${record.slug}, title=${record.title})`);

  const hasCover = await coverExists(s3, bucket, record.cover_path);
  if (!hasCover) issues.push('cover-файл не найден в S3 по record.cover_path');

  const allRecords = await listAllRecords(s3, bucket);
  const visibleToPublic = allRecords.filter((r) => r.published !== false).some((r) => r.id === id);
  if (!visibleToPublic) issues.push('проект не виден среди опубликованных записей (как их отдаёт GET /api/projects)');

  const row = toApiRow(record, publicBaseUrl, { includeImages: true });
  if (!row.cover_url) issues.push('cover_url пуст в API-представлении (toApiRow)');
  if (row.category !== RESELLFLOW_DATA.category) issues.push(`category != ${RESELLFLOW_DATA.category} (получено: ${row.category})`);
  if (row.status !== RESELLFLOW_DATA.status) issues.push(`status != ${RESELLFLOW_DATA.status} (получено: ${row.status})`);
  if (row.published !== true) issues.push('published != true');

  return { ok: issues.length === 0, issues, record, row };
}

async function runSeed(options = {}) {
  const s3 = options.s3 || createS3Client();
  const bucket = options.bucket || requireEnv('S3_BUCKET_CERTIFICATES');
  const publicBaseUrl = options.publicBaseUrl || requireEnv('S3_PUBLIC_BASE_URL');

  const existing = await findExisting(s3, bucket);
  if (existing) {
    console.log(`ResellFlow уже существует (id=${existing.id}, slug=${existing.slug}, title="${existing.title}"). Ничего не создаю — дубль не нужен.`);
    const verifyResult = await verify(s3, bucket, publicBaseUrl, existing.id);
    return { created: false, id: existing.id, verify: verifyResult };
  }

  if (!fs.existsSync(COVER_FILE)) throw new Error(`Файл обложки не найден: ${COVER_FILE}`);
  const coverBytes = fs.readFileSync(COVER_FILE);

  const id = crypto.randomUUID();
  const slug = slugify(RESELLFLOW_DATA.title) || id;
  const coverPath = coverKey(id);
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: coverPath, Body: coverBytes, ContentType: 'image/webp' }));

  const now = new Date().toISOString();
  const record = {
    id,
    slug,
    title: RESELLFLOW_DATA.title,
    category: RESELLFLOW_DATA.category,
    summary: RESELLFLOW_DATA.summary,
    description: RESELLFLOW_DATA.description,
    goal: RESELLFLOW_DATA.goal,
    result: RESELLFLOW_DATA.result,
    status: RESELLFLOW_DATA.status,
    tags: RESELLFLOW_DATA.tags,
    cover_path: coverPath,
    project_url: null,
    github_url: null,
    demo_url: null,
    published: RESELLFLOW_DATA.published,
    sort_order: 0,
    gallery: [],
    created_at: now,
    updated_at: now
  };
  await putMetadata(s3, bucket, id, record);
  console.log(`ResellFlow создан: id=${id}, slug=${slug}`);

  const verifyResult = await verify(s3, bucket, publicBaseUrl, id);
  return { created: true, id, verify: verifyResult };
}

module.exports = { runSeed, RESELLFLOW_DATA, isResellflowRecord };

if (require.main === module) {
  runSeed()
    .then((result) => {
      console.log('\n=== ПРОВЕРКА (VERIFY) ===');
      console.log(JSON.stringify(result.verify, null, 2));
      if (!result.verify.ok) {
        console.error('\nПРОВЕРКА НЕ ПРОШЛА — см. issues выше.');
        process.exitCode = 1;
      } else {
        console.log(result.created
          ? '\nГотово: ResellFlow создан и проверен.'
          : '\nГотово: ResellFlow уже существовал, дубль не создан, проверка пройдена.');
      }
    })
    .catch((error) => {
      console.error('Seed прерван с ошибкой:', error);
      process.exitCode = 1;
    });
}
