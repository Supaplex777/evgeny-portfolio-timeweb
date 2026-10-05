'use strict';

// Run: npm test   (uses only node:test — no network, no real S3).
// S3 is replaced with an in-process fake store, injected directly into
// runSeed() — the script itself never touches real env vars or network
// when called this way, so this test never risks writing to production.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  PutObjectCommand, GetObjectCommand, DeleteObjectsCommand, ListObjectsV2Command
} = require('@aws-sdk/client-s3');

const { runSeed, RESELLFLOW_DATA } = require('../scripts/seed-resellflow');

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

let fakeS3;
const BUCKET = 'test-bucket';
const PUBLIC_BASE_URL = 'https://cdn.example.test';
beforeEach(() => { fakeS3 = createFakeS3(); });

test('first run creates ResellFlow with correct metadata, cover and published=true', async () => {
  const result = await runSeed({ s3: fakeS3, bucket: BUCKET, publicBaseUrl: PUBLIC_BASE_URL });
  assert.equal(result.created, true);
  assert.ok(result.verify.ok, `verify should pass: ${JSON.stringify(result.verify.issues)}`);

  const { record } = result.verify;
  assert.equal(record.title, RESELLFLOW_DATA.title);
  assert.equal(record.category, 'automation');
  assert.equal(record.status, 'Активный');
  assert.equal(record.published, true);
  assert.equal(record.slug.startsWith('resellflow'), true);
  assert.deepEqual(record.tags, RESELLFLOW_DATA.tags);
  assert.equal(record.description, RESELLFLOW_DATA.description);
  assert.equal(record.goal, RESELLFLOW_DATA.goal);
  assert.equal(record.result, RESELLFLOW_DATA.result);

  // cover was actually uploaded to S3 under the project's cover key
  assert.ok(fakeS3.objects.has(record.cover_path), 'cover object must exist in S3');
  assert.ok(fakeS3.objects.get(record.cover_path).body.length > 0, 'cover body must be non-empty');
});

test('second run does not create a duplicate', async () => {
  const first = await runSeed({ s3: fakeS3, bucket: BUCKET, publicBaseUrl: PUBLIC_BASE_URL });
  assert.equal(first.created, true);

  const metadataKeysAfterFirst = [...fakeS3.objects.keys()].filter((k) => k.startsWith('projects/metadata/'));
  assert.equal(metadataKeysAfterFirst.length, 1);

  const second = await runSeed({ s3: fakeS3, bucket: BUCKET, publicBaseUrl: PUBLIC_BASE_URL });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id, 'second run must report the same existing id, not a new one');
  assert.ok(second.verify.ok, `verify should still pass on the second run: ${JSON.stringify(second.verify.issues)}`);

  const metadataKeysAfterSecond = [...fakeS3.objects.keys()].filter((k) => k.startsWith('projects/metadata/'));
  assert.equal(metadataKeysAfterSecond.length, 1, 'still exactly one ResellFlow metadata object, no duplicate created');
});

test('the seeded project is visible through the same list logic GET /api/projects uses', async () => {
  await runSeed({ s3: fakeS3, bucket: BUCKET, publicBaseUrl: PUBLIC_BASE_URL });
  const { listAllRecords, toApiRow } = require('../lib/projects');
  const records = await listAllRecords(fakeS3, BUCKET);
  const published = records.filter((r) => r.published !== false).map((r) => toApiRow(r, PUBLIC_BASE_URL));
  assert.equal(published.length, 1);
  assert.equal(published[0].title, RESELLFLOW_DATA.title);
  assert.ok(published[0].cover_url.startsWith('https://cdn.example.test/projects/originals/'));
});
