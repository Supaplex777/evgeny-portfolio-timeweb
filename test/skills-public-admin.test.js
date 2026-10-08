'use strict';

// Skills has no backend of its own: there is no /api/skills route, and its
// "save" only ever writes to the visitor's own browser localStorage (never
// shared/production data) - see public/index.html's own Skills script
// comment for the full reasoning. Because of that there is no HTTP endpoint
// to boot a server against for this module, unlike projects.test.js and
// certificates.test.js. Instead this test pins the exact public/admin
// invariants as source-level checks on public/index.html itself, so the
// regression (the edit/save/cancel controls for Skills being shown and
// fully usable by every visitor, with no admin gate at all) can't silently
// come back without these assertions failing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

test('Skills module computes its own ?admin=1 gate (same convention Projects/Certificates use)', () => {
  assert.match(
    html,
    /const ADMIN=new URLSearchParams\(location\.search\)\.get\('admin'\)==='1';\s*const root=document\.getElementById\('skills'\)/,
    'Skills script must derive ADMIN from ?admin=1, right before grabbing the #skills DOM refs'
  );
});

test('Skills edit button is hidden by default for a public (non-admin) visitor', () => {
  assert.match(
    html,
    /const editBtn=card\.querySelector\('\[data-action="edit"\]'\);\s*editBtn\.hidden=!ADMIN;/,
    'editBtn must start hidden whenever ADMIN is false, not just rely on later toggling'
  );
});

test('entering edit mode is refused at the function level, not just by hiding the button', () => {
  assert.match(
    html,
    /function mode\(edit\)\{if\(edit&&!ADMIN\)return;/,
    'mode(true) must no-op for a public visitor even if something else (devtools, a stray click) tries to call it directly'
  );
  assert.match(
    html,
    /editBtn\.hidden=edit\|\|!ADMIN;\}/,
    'mode() must keep re-hiding the edit button for non-admins on every call, not just on first render'
  );
});

test('the edit click-handler itself refuses to run for a public visitor', () => {
  assert.match(
    html,
    /case 'edit':\{if\(!ADMIN\)return;/,
    'the data-action="edit" click case must bail out immediately when ADMIN is false'
  );
});

test('save() refuses to persist changes for a public visitor (defense in depth)', () => {
  assert.match(
    html,
    /function save\(\)\{if\(!ADMIN\)return;/,
    'save() must refuse to run for a public visitor even if edit mode were somehow entered'
  );
});

test('an authenticated admin (?admin=1) still gets a working editor: button, form and save/cancel all exist', () => {
  // These are the same controls the guards above gate - this just confirms
  // the fix did not delete or rename them while adding the ADMIN checks.
  assert.match(html, /<button type="button" data-action="edit">Редактировать<\/button>/);
  assert.match(html, /<button type="button" data-action="save" hidden>Сохранить<\/button>/);
  assert.match(html, /<button type="button" data-action="cancel" hidden>Отмена<\/button>/);
  assert.match(html, /<form class="skill-editor" hidden>/);
});

test('Skills truly has no backend mutation endpoint to lock down server-side', () => {
  const serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.doesNotMatch(serverJs, /\/api\/skills/, 'if a real /api/skills endpoint is ever added, it must ship with its own auth test - this trips the moment one appears unprotected');
  const libDir = fs.readdirSync(path.join(__dirname, '..', 'lib'));
  assert.deepEqual(libDir.filter((f) => f.toLowerCase().includes('skill')), [], 'no lib/*skills* module exists - Skills data lives only in the visitor\'s own localStorage');
});
