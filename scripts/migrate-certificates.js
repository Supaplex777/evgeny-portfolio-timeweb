#!/usr/bin/env node
// COPY + VERIFY migration: portfolio_certificates (Supabase) -> Timeweb Cloud S3.
//
// This script ONLY reads from Supabase and writes to the new S3 bucket.
// It never updates or deletes anything in Supabase.
//
// Required environment variables:
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY   (read-only source)
//   S3_ENDPOINT, S3_REGION, S3_BUCKET_CERTIFICATES,
//   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY   (destination)
//
// Usage:
//   node scripts/migrate-certificates.js            # copy + verify, writes a report
//   node scripts/migrate-certificates.js --verify-only   # skip copy, only verify what's already there

const fs = require('fs');
const path = require('path');
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { CATEGORIES, safeFileName, originalKey, previewKey, metadataKey } = require('../lib/certificates');

const VERIFY_ONLY = process.argv.includes('--verify-only');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Отсутствует обязательная переменная окружения: ${name}`);
  return value;
}

function createS3() {
  return new S3Client({
    endpoint: requireEnv('S3_ENDPOINT'),
    region: process.env.S3_REGION || 'ru-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: requireEnv('S3_ACCESS_KEY_ID'),
      secretAccessKey: requireEnv('S3_SECRET_ACCESS_KEY')
    }
  });
}

async function fetchSupabaseRows() {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_PUBLISHABLE_KEY');
  const response = await fetch(
    `${url}/rest/v1/portfolio_certificates?select=id,category,name,type,created_at,description,file_path,preview_path&order=created_at.asc`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } }
  );
  if (!response.ok) {
    throw new Error(`Supabase REST вернул HTTP ${response.status}: ${await response.text().catch(() => '')}`);
  }
  return response.json();
}

async function downloadSupabaseFile(storagePath) {
  const url = requireEnv('SUPABASE_URL');
  const response = await fetch(`${url}/storage/v1/object/public/portfolio-certificates/${storagePath}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} при скачивании ${storagePath}`);
  return Buffer.from(await response.arrayBuffer());
}

function guessContentType(name, fallback) {
  if (fallback) return fallback;
  if (/\.pdf$/i.test(name)) return 'application/pdf';
  if (/\.webp$/i.test(name)) return 'image/webp';
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  return 'application/octet-stream';
}

async function headExists(s3, bucket, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return false;
    throw error;
  }
}
async function getJson(s3, bucket, key) {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey') return null;
    throw error;
  }
}

async function copyOne(s3, bucket, row, report) {
  const { id, category } = row;
  if (!CATEGORIES.includes(category)) {
    report.errors.push({ id, category, error: `Неизвестная категория "${category}", запись пропущена.` });
    return;
  }
  try {
    const fileKey = originalKey(category, id, safeFileName(row.name));
    const originalBytes = await downloadSupabaseFile(row.file_path);
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: fileKey, Body: originalBytes,
      ContentType: guessContentType(row.name, row.type)
    }));

    let previewKeyValue = null;
    if (row.preview_path) {
      previewKeyValue = previewKey(category, id);
      const previewBytes = await downloadSupabaseFile(row.preview_path);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: previewKeyValue, Body: previewBytes, ContentType: 'image/webp' }));
    }

    const record = {
      id, category, name: row.name, type: row.type || guessContentType(row.name),
      created_at: row.created_at, description: row.description || '',
      file_path: fileKey, preview_path: previewKeyValue
    };
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: metadataKey(category, id),
      Body: JSON.stringify(record), ContentType: 'application/json'
    }));
    report.copied++;
  } catch (error) {
    report.errors.push({ id, category, error: error.message || String(error) });
  }
}

async function verifyOne(s3, bucket, row, report) {
  const { id, category } = row;
  const issues = [];
  if (!CATEGORIES.includes(category)) {
    report.mismatches.push({ id, category, issue: `Неизвестная категория "${category}".` });
    return;
  }
  const metadata = await getJson(s3, bucket, metadataKey(category, id));
  if (!metadata) issues.push('metadata отсутствует');
  const originalOk = await headExists(s3, bucket, originalKey(category, id, safeFileName(row.name)));
  if (!originalOk) issues.push('original отсутствует');
  if (row.preview_path) {
    const previewOk = await headExists(s3, bucket, previewKey(category, id));
    if (!previewOk) issues.push('preview отсутствует (в источнике был)');
  }
  if (issues.length) report.mismatches.push({ id, category, issue: issues.join('; ') });
  else report.verified++;
}

async function main() {
  console.log(`Режим: ${VERIFY_ONLY ? 'только проверка (--verify-only)' : 'копирование + проверка'}`);

  const s3 = createS3();
  const bucket = requireEnv('S3_BUCKET_CERTIFICATES');
  const rows = await fetchSupabaseRows();

  const sourceCounts = {};
  CATEGORIES.forEach((c) => { sourceCounts[c] = 0; });
  rows.forEach((row) => { if (sourceCounts[row.category] != null) sourceCounts[row.category]++; });

  console.log(`Найдено в Supabase: ${rows.length} записей.`);
  console.log('По категориям:', sourceCounts);

  const copyReport = { copied: 0, errors: [] };
  if (!VERIFY_ONLY) {
    for (const row of rows) {
      // Sequential on purpose: keeps S3/Supabase request rate low and the report deterministic.
      await copyOne(s3, bucket, row, copyReport);
    }
  }

  const verifyReport = { verified: 0, mismatches: [] };
  for (const row of rows) {
    await verifyOne(s3, bucket, row, verifyReport);
  }

  const finalReport = {
    generatedAt: new Date().toISOString(),
    mode: VERIFY_ONLY ? 'verify-only' : 'copy+verify',
    supabaseTotal: rows.length,
    supabaseCountsByCategory: sourceCounts,
    copied: copyReport.copied,
    copyErrors: copyReport.errors,
    verifiedOk: verifyReport.verified,
    verifyMismatches: verifyReport.mismatches,
    countsMatch: verifyReport.verified === rows.length && copyReport.errors.length === 0,
    supabaseUntouched: true
  };

  const reportPath = path.join(__dirname, `migration-report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(finalReport, null, 2));

  console.log('\n=== ИТОГОВЫЙ ОТЧЁТ ===');
  console.log(JSON.stringify(finalReport, null, 2));
  console.log(`\nОтчёт сохранён: ${reportPath}`);

  if (!finalReport.countsMatch) {
    console.error('\nВНИМАНИЕ: обнаружены расхождения. Переключать production НЕЛЬЗЯ до их устранения.');
    process.exitCode = 1;
  } else {
    console.log('\nВсе записи перенесены и проверены успешно. Supabase не изменялся и не удалялся.');
  }
}

main().catch((error) => {
  console.error('Миграция прервана с ошибкой:', error);
  process.exitCode = 1;
});
