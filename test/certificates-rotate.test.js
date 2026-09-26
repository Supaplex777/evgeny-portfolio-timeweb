'use strict';

// Run: npm test  — pure math, no canvas/DOM/browser required.
// This is the same module public/index.html loads for the certificate
// upload rotate-preview feature (90-degree steps before the final upload).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const CertRotate = require('../public/certificates-rotate.js');

test('normalizeRotation keeps a value in [0, 360) for any step sequence', () => {
  assert.equal(CertRotate.normalizeRotation(0), 0);
  assert.equal(CertRotate.normalizeRotation(90), 90);
  assert.equal(CertRotate.normalizeRotation(360), 0);
  assert.equal(CertRotate.normalizeRotation(450), 90);
  assert.equal(CertRotate.normalizeRotation(-90), 270);
  assert.equal(CertRotate.normalizeRotation(-450), 270);
});

test('rotating left then right by 90 degrees returns to the original angle', () => {
  let deg = 0;
  deg = CertRotate.normalizeRotation(deg + 270); // left (-90)
  assert.equal(deg, 270);
  deg = CertRotate.normalizeRotation(deg + 90); // right (+90)
  assert.equal(deg, 0);
});

test('four consecutive 90-degree rotations return to 0', () => {
  let deg = 0;
  for (let i = 0; i < 4; i++) deg = CertRotate.normalizeRotation(deg + 90);
  assert.equal(deg, 0);
});

test('isSwapped is true only at 90/270 degrees, matching a portrait<->landscape flip', () => {
  assert.equal(CertRotate.isSwapped(0), false);
  assert.equal(CertRotate.isSwapped(90), true);
  assert.equal(CertRotate.isSwapped(180), false);
  assert.equal(CertRotate.isSwapped(270), true);
  assert.equal(CertRotate.isSwapped(360), false);
});

test('rotatedCanvasSize swaps width/height at 90 and 270 degrees only', () => {
  assert.deepEqual(CertRotate.rotatedCanvasSize(800, 600, 0), { width: 800, height: 600 });
  assert.deepEqual(CertRotate.rotatedCanvasSize(800, 600, 90), { width: 600, height: 800 });
  assert.deepEqual(CertRotate.rotatedCanvasSize(800, 600, 180), { width: 800, height: 600 });
  assert.deepEqual(CertRotate.rotatedCanvasSize(800, 600, 270), { width: 600, height: 800 });
});
