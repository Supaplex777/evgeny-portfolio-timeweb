# PROJECT HANDOFF — evgeny-portfolio-timeweb

## 1. Executive summary

`evgeny-portfolio-timeweb` is a Node.js/Express single-backend portfolio site for Evgeny Smirnov (AI Automation Specialist), with an almost entirely single-file frontend (`public/index.html`), a separate TerraIntel sub-application, three small backend "modules" (Certificates, Projects, Contact/AI), and a Timeweb Cloud deployment. Since PR #23 the Projects and Certificates sections have been fully migrated off Supabase onto a self-built Timeweb Cloud S3 backend with a shared owner-session auth system; Skills is a frontend-only, localStorage-backed section with no backend at all. The repo currently sits on `main` at commit `9b3101b5a9a60ec46e5c04647948c03665b705e8` (merged PR #26), with 94/94 tests passing locally. This document was produced by a read-only audit of the repository, git history, and closed PRs — no repository changes were made while preparing it.

## 2. Current state

- Current `main` HEAD: **`9b3101b5a9a60ec46e5c04647948c03665b705e8`** (merge commit of PR #26).
- Working tree: clean, no uncommitted changes, checked out on `main`.
- Test suite: **94/94 passing** (`npm test`, just re-run against this exact commit).
- Last three merged PRs (newest first): #26 (Skills bfcache hardening + AI/S3 optimization), #25 (Skills public/admin security fix), #24 (mobile responsive overhaul + removed blocking Supabase CDN script).
- Production URL: `https://supaplex777-evgeny-portfolio-timeweb-1140.twc1.net/` — **not reachable from this sandbox** (egress to `twc1.net` is blocked); its deployed state has not been verified in this session and must be checked manually.

## 3. Repository structure

```
evgeny-portfolio-timeweb/
├── server.js                     # Express app, /health, /api/contact, /api/ai, mounts routers
├── package.json / package-lock.json
├── .env.example                  # documents every env var actually read by the code
├── README.md                     # STALE in places — see §13
├── lib/
│   ├── certificates.js           # Certificates backend + shared S3/session/auth primitives
│   ├── projects.js               # Projects backend (reuses certificates.js's S3 client & session)
│   └── terraintel.js             # TerraIntel AI backend (fully independent)
├── public/
│   ├── index.html                 # ~1.1MB single-file frontend: all sections, inline CSS/JS
│   ├── certificates-rotate.js     # small standalone helper script for upload-preview rotation
│   ├── assets/                    # 16 WebP images (hero, about, certificates, contacts, etc.)
│   └── terraintel/
│       ├── index.html             # separate TerraIntel frontend (~2.7MB, self-contained)
│       └── vendor/                # local copy of MapLibre GL JS 5.7.1 (BSD-3)
├── scripts/
│   ├── migrate-certificates.js    # one-off Supabase→S3 certificate migration script
│   └── seed-resellflow.js         # idempotent seeder for the ResellFlow project record
├── supabase/
│   └── projects_contacts.sql      # legacy SQL schema, kept for historical reference only
└── test/
    ├── certificates.test.js
    ├── certificates-rotate.test.js
    ├── contact.test.js
    ├── projects.test.js
    ├── seed-resellflow.test.js
    ├── skills-public-admin.test.js
    ├── terraintel.test.js
    └── helpers/
```

**Independence:** TerraIntel (`public/terraintel/**`, `lib/terraintel.js`, its tests, `/terraintel/`, `/api/terraintel/*`) is a fully separate sub-app sharing only the Express process and `helmet`/static-serving middleware — it has its own AI prompt, model, rate limits, and frontend, and does not touch Projects/Certificates/Skills/Contact code. Everything else (main portfolio: Home, About, Projects, Skills, Certificates, Contacts, AI assistant, Legal/Privacy) lives inside `public/index.html` as one page with hash-based section switching.

## 4. Architecture

**Stack:** Node.js + Express 4, `helmet` (CSP disabled — the frontend relies on inline `<style>`/`<script>`), `express-rate-limit`, `multer` (memory storage, used for file uploads), `bcryptjs` (owner password hash), `@aws-sdk/client-s3` v3 (against Timeweb Cloud S3, S3-compatible, `forcePathStyle: true`). No ORM, no managed database — all persistent portfolio data (Projects, Certificates) is JSON metadata objects + binary files stored directly in Timeweb S3.

**What's frontend-only / no backend:** Skills (localStorage only, see §9), all visual/animation logic, the client-side CSV→Robust-Z anomaly pipeline in TerraIntel (only the final small anomaly list goes to the server).

**What uses Timeweb S3:** Projects and Certificates (same bucket and credentials, see §7/§8), distinguished purely by S3 key prefix.

**What uses localStorage:** Skills only (`evgeny-portfolio-skills-v1`).

**What uses an external AI API:** `/api/ai` (main-site assistant, Polza AI, `openai/gpt-oss-20b`) and `/api/terraintel/analyze` (Polza AI, `sber/gigachat-2`, independent system prompt and config) — see §10 and §12.

### Flow diagrams

**PUBLIC USER:**
```
Browser → GET / (public/index.html, static) → inline JS on load
        → GET /api/projects, GET /api/certificates, GET /api/certificates/counts
        → data rendered client-side into Projects/Certificates sections
        (Skills renders purely from localStorage/defaults, no network call)
```

**ADMIN (owner):**
```
Browser → opens ?admin=1 (frontend-only UI flag, re-derived independently per section)
        → POST /api/certificates/login { password } → bcrypt.compare against ADMIN_PASSWORD_HASH
        → signed HMAC session cookie (cert_admin, Path=/api) set on success
        → subsequent POST/PATCH/DELETE to /api/certificates/* and /api/projects/*
          pass requireSameOrigin + requireOwnerSession middleware
        → on success: PutObjectCommand/DeleteObjectsCommand against Timeweb S3
```

**AI ASSISTANT (main site):**
```
Browser (#evg-ai-launch) → opens #evg-ai-panel
        → POST /api/ai { question, context } (context assembled client-side from visible page data)
        → server: buildCertificatesContext(await getCertificatesSummaryForAI())
                  (reads cached or fresh S3 certificate summary, 60s TTL cache)
        → system prompt + certificatesContext + context + question → Polza AI
          (https://polza.ai/api/v1/chat/completions, model openai/gpt-oss-20b, non-streaming)
        → single JSON response rendered in the panel
```

**TERRAINTEL (fully separate):**
```
Browser → GET /terraintel/ (separate HTML, own CSS/JS, MapLibre GL)
        → CSV parsed and reduced to anomalies entirely client-side
        → POST /api/terraintel/analyze { anomalies[] } (own rate limiter, own daily cap, own timeout)
        → lib/terraintel.js → Polza AI (sber/gigachat-2, separate system prompt)
        → never shares code, data, or UI with the main portfolio
```

## 5. Routes / API

| Route | Method | Public/Admin | Auth | Data source |
|---|---|---|---|---|
| `/` (and any unmatched path) | GET | Public | none | serves `public/index.html` (SPA fallback) |
| `/health` | GET | Public | none | in-memory (`process.uptime()`) |
| `/api/contact` | POST | Public | none (rate-limited 5/15min + honeypot + fingerprint dedupe) | sends to Telegram (required) + Resend email (best-effort) |
| `/api/ai` | POST | Public | none (rate-limited 30/15min) | Polza AI + cached S3 certificates summary |
| `/api/certificates` (GET `/`) | GET | Public | none | Timeweb S3 (`S3_BUCKET_CERTIFICATES`) |
| `/api/certificates/counts` | GET | Public | none | Timeweb S3 |
| `/api/certificates/session` | GET | Public | none (reports whether caller has a valid session) | signed cookie |
| `/api/certificates/login` | POST | Admin | password (bcrypt vs `ADMIN_PASSWORD_HASH`), rate-limited 10/15min | sets `cert_admin` session cookie |
| `/api/certificates/` | POST | Admin | `requireSameOrigin` + `requireOwnerSession` → 401 if missing/invalid | S3 (creates object + metadata) |
| `/api/certificates/:id` | PATCH | Admin | same as above | S3 |
| `/api/certificates/:id` | DELETE | Admin | same as above | S3 |
| `/api/projects` (GET `/`) | GET | Public | none | Timeweb S3 (same bucket as Certificates, `projects/` prefix) |
| `/api/projects/:id` | GET | Public | none | S3 |
| `/api/projects/` | POST | Admin | `requireSameOrigin` + `requireOwnerSession` (reused from certificates.js, same cookie) | S3 |
| `/api/projects/:id` | PATCH | Admin | same | S3 |
| `/api/projects/:id` | DELETE | Admin | same | S3 |
| `/api/projects/:id/gallery` | POST | Admin | same | S3 |
| `/api/projects/:id/gallery/:imageId` | DELETE | Admin | same | S3 |
| `/api/terraintel/analyze` | POST | Public | none (own rate limiter per-IP + daily global cap) | Polza AI (`sber/gigachat-2`) |
| `/terraintel/` | GET | Public | none | `public/terraintel/index.html` (via `terraIntelPageHeaders` middleware) |

Note: there is **no `/api/skills` route anywhere** — confirmed by grep against `server.js` and `lib/` (also pinned by a regression test, §9/§16).

## 6. Public vs Admin

The `?admin=1` query parameter is read independently by three separate scripts (Projects, Certificates, Skills), each deriving its own local `ADMIN`/`ADMIN_MODE` boolean from `new URLSearchParams(location.search).get('admin')`. **This is purely a frontend UI-visibility signal.** It is never sent to, or read by, the backend (confirmed: no `req.query.admin`/`admin=1` reference anywhere in `server.js` or `lib/*.js`). Real protection for Projects and Certificates mutation endpoints is the `requireOwnerSession` middleware (signed HMAC cookie, `lib/certificates.js`), which both routers use and which returns `401` to any request without a valid session — confirmed in code (middleware chain on every POST/PATCH/DELETE route in both `lib/certificates.js` and `lib/projects.js`) and exercised by regression tests in `test/certificates.test.js` and `test/projects.test.js`. Skills has **no backend boundary at all** — see §9.

## 7. Projects

- Backend: `lib/projects.js`, mounted at `/api/projects` in `server.js`.
- Storage: same Timeweb S3 bucket/credentials as Certificates (`createS3Client()`, `process.env.S3_BUCKET_CERTIFICATES` — reused, not a separate bucket), distinguished by key prefix `projects/...` vs certificates' `originals/.../metadata/...` (comment in `lib/projects.js:1-3` states this explicitly).
- One JSON metadata object per project (`id` must be a UUID, validated via `isValidId`/`UUID_RE`); no managed DB.
- Fields: title, summary, description, goal, result, status (one of `В разработке`/`MVP`/`Завершён`/`Активный`), category (`ai`/`automation`/`web`/`data`/`other`), tags, cover image (WebP, `multer` memory upload), optional gallery (up to `GALLERY_LIMIT = 8` images), project URL.
- Auth: mutation routes (`POST /`, `PATCH /:id`, `DELETE /:id`, gallery routes) require `requireSameOrigin` + `requireOwnerSession`, reusing the certificates owner session (same cookie, `Path=/api`).
- Fallback behavior: the frontend renders one hardcoded client-side fallback card (`id:'terrain-intel'`) when no real backend TerraIntel project exists yet, and a similar temporary ResellFlow placeholder that self-hides once a real backend record with a matching slug/title exists (`public/index.html` ~line 3452-3456). **This fallback card is purely a Projects-section UI placeholder and is not the same thing as the actual separate TerraIntel sub-application** (§12) — they must not be conflated.
- Mobile: `cardTitle(p)` derives a shortened display title by truncating at the first " — " when the full title exceeds 28 characters; rendered into both a `.title-full` and a `.title-short` `<span>` inside the project card `<h2>`, with CSS toggling which is visible (desktop default: `.title-short{display:none}`; `@media(max-width:900px)`: `.title-full{display:none}`, `.title-short{display:inline}`).
- **Known P3 issue:** both spans are always present in the DOM; since CSS `display:none` does not remove text from `textContent`/`innerText`, a raw text read of the `<h2>` concatenates both the full and short title (e.g. "Audit CRUD ProjectAudit CRUD Project"). This has **no real-user or screen-reader impact** (hidden content is excluded from the accessibility tree) but can affect raw-DOM text reads, copy/paste, and SEO scraping of that heading. Recommended as a small, separate follow-up PR rather than bundled into unrelated work.

## 8. Certificates

- Backend: `lib/certificates.js`, mounted at `/api/certificates`.
- Storage: Timeweb Cloud S3 (`S3_ENDPOINT`, `S3_BUCKET_CERTIFICATES`, `S3_PUBLIC_BASE_URL`), accessed via a **module-level singleton `S3Client`** (`createS3Client()` — instantiated once per process, not per request; this was the PR #26 change, previously a fresh client was created on every call).
- Categories, metadata (title, description, category, created_at), original file + generated preview, public URL construction (`publicUrlFor`).
- Admin auth: `POST /login` (bcrypt against `ADMIN_PASSWORD_HASH`, rate-limited 10/15min) sets a signed cookie (`signSession`/`verifySession`, HMAC-SHA256 with `SESSION_SECRET`); `GET /session` reports authentication state; all mutating routes require `requireSameOrigin` + `requireOwnerSession` (401 otherwise).
- CRUD: `POST /`, `PATCH /:id` (title/description/preview), `DELETE /:id`.
- **PR #26 changes specifically:**
  - `createS3Client()` turned into a module-level singleton (`sharedS3Client`), avoiding a fresh client (and its connection pool) on every request.
  - A 60-second in-memory TTL cache (`aiSummaryCache`, `AI_SUMMARY_CACHE_TTL_MS = 60_000`) around `getCertificatesSummaryForAI()`, which previously fanned out across all categories on S3 on *every single* `/api/ai` call.
  - `invalidateAiSummaryCache()` exported and called at three points: after a successful certificate create (`POST /`), update (`PATCH /:id`), and delete (`DELETE /:id`), each right before the success response is sent — so the AI's certificate context is never stale for longer than one write-to-next-read gap, and any stale window is bounded by the 60s TTL even without a write.
  - Why: `/api/ai` was issuing a full 6-category S3 `ListObjectsV2`/`GetObject` fan-out, plus a brand-new `S3Client` (and therefore a fresh connection/handshake), on every single question — a real, code-level inefficiency independent of actual Polza/Timeweb network latency.
  - Tests added: singleton-identity test for `createS3Client`, a cache-bypass test for `options.s3`, and a create→update→delete cache-invalidation test (using the file's pre-existing `request2`/`login2` second-router-instance pattern to avoid colliding with the shared login rate-limiter budget used by earlier tests in the same file).

## 9. Skills

- **No backend of any kind.** There is no `/api/skills` route in `server.js`, and no `lib/*skills*` module exists (confirmed by grep and pinned by `test/skills-public-admin.test.js`'s own assertions).
- All data lives in the visitor's own browser `localStorage`, key `evgeny-portfolio-skills-v1`. "Editing" as admin only ever writes to that one browser's local storage — it is never shared, never synced, never seen by any other visitor or by the real site owner remotely.
- `?admin=1` is a frontend-only flag (`const ADMIN=new URLSearchParams(location.search).get('admin')==='1'`), independently derived in the Skills IIFE, gating the Edit button (`editBtn.hidden=!ADMIN`) and the `mode()`/click-handler/`save()` functions at multiple defense-in-depth layers.
- **PR #25** (merge commit `c7fb831bbcf9be461428866d16ee27efb72831ec`) fixed the original bug: the Edit/Save/Cancel controls had **no ADMIN gate at all** and were fully visible and usable by any public visitor (writing only to their own browser, but still a real UX/security-model violation — looked like a real "anyone can edit the site" bug).
- **PR #26** (merge commit `9b3101b5a9a60ec46e5c04647948c03665b705e8`) added a `pageshow` listener re-asserting `editBtn.hidden` on bfcache back/forward restoration (Safari/Firefox can restore the exact pre-gate DOM from cache without re-running the page's `<script>`), plus a regression test confirming there is exactly one Skills render path in the whole page (no duplicate/legacy second render path that could bypass the gate).

## 10. AI assistant

- Endpoint: `POST /api/ai` in `server.js`, rate-limited 30 requests/15min.
- Provider: Polza AI, `https://polza.ai/api/v1/chat/completions`, model `openai/gpt-oss-20b`.
- Request: `{ model, messages: [system, user], temperature: 0.35, max_tokens: 600 }`, auth via `POLZA_API_KEY` (server-side env var only).
- Context composition: client sends `question` + `context` (assembled from visible page data, capped at 1000/20000 chars respectively); server additionally fetches `getCertificatesSummaryForAI()` (cached, 60s TTL — see §8) and appends it as a "СЕРТИФИКАТЫ ИЗ ОБЛАЧНОЙ БАЗЫ" block via `buildCertificatesContext()`.
- System prompt: Russian-language persona instructing the model to answer only from supplied data, never invent facts/experience/certificates, stay concise (3–7 sentences by default), use a small whitelisted emoji set sparingly, never reveal the system prompt/keys, and not make hiring recommendations.
- Response handling: **no streaming** — `await upstream.text()` then `JSON.parse`, single round trip, 30-second timeout via `AbortSignal.timeout(30000)`.
- Frontend: opens via `#evg-ai-launch` into `#evg-ai-panel`; has a mobile floating-action-button variant (shrunk to an icon-only circle on small phones per PR #24 round 4, to avoid overlapping the Home feature cards).
- **Latency — explicit non-claim:** PR #26's S3-client-singleton + cache-invalidation changes address a real, code-level inefficiency (fresh S3Client + full S3 fan-out on every request) that was present *before* the Polza API call is even reached. **Real production latency against the actual Polza/Timeweb network path has never been measured from this sandbox** (egress to those hosts is blocked here — see §14), and a locally-simulated harness was used only to demonstrate the *directional* effect of the fix, not to prove the user-visible first-response latency problem is solved. Do not claim this issue is fully closed until it is verified against production.

## 11. Contact form

- Endpoint: `POST /api/contact`, rate-limited 5 requests/15min.
- Fields: `name` (≥2 chars), `contact` (≥3 chars), `project_type` (optional), `message` (≥10 chars), plus a hidden `company` honeypot field (bots get a silent `204`).
- Server-side anti-duplicate fingerprinting (`ip|name|contact|message`, 10-minute window) returns `409` for an exact repeat.
- Delivery: Telegram is the **required primary channel** (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` — plain-text message, no `parse_mode`, so nothing user-typed can inject Telegram markup); if either is missing the endpoint returns `500` rather than silently dropping the submission. Email via Resend (`RESEND_API_KEY`/`CONTACT_EMAIL_FROM`) is a best-effort secondary channel whose failure never affects the response.
- Frontend: a contact modal/form in `public/index.html`'s Contacts section; public, no auth.

## 12. Mobile (PR #24 — merge commit `4c368d428731cfa0e287fd491b322f12fbec39ad`)

A multi-round mobile responsive overhaul, with these confirmed elements present in the current code:
- Burger-menu mobile navigation; enlarged touch targets (buttons sized for ≥44px minimum tap area, visible e.g. in `.project-filters button{min-width:78px;min-height:44px}`).
- `env(safe-area-inset-*)` handling and a dedicated mobile header treatment.
- About section's multi-state interactive panel (originally found to overlap the node-orbit visual on mobile in an earlier round; fixed in "Round 3" — `bae2b91` — "fix About detail-panel overlap").
- Projects: mobile card redesign including full-bleed covers (`margin:-13px -13px 14px -13px` pattern) and the `.title-full`/`.title-short` dual-span pattern (§7).
- Certificates: mobile card redesign per "Round 4"/`7847cc1` mockup alignment pass.
- Contacts: icon/help block redesign, extended "atmosphere" background treatment (Round 3).
- AI assistant: mobile FAB shrunk to an icon-only circle on small phones to stop overlap with Home feature cards (Round 4, `c95b878`).
- `100dvh` usage and `visualViewport` API handling for on-screen-keyboard-aware layout (used in earlier certificate-upload-modal fixes, PR #10/#11, carried forward).
- `@media(hover:hover) and (pointer:fine)` gating for hover-only effects (so touch devices don't get stuck hover states) — used throughout, e.g. `.project-filters button:hover`, `.contact-grid>a:hover`.
- `@media(prefers-reduced-motion:reduce)` rules disabling transitions/scroll-behavior for users who request reduced motion.
- Breakpoints observed in the CSS include `max-width:900px` (tablet/mobile boundary, used for the Projects title-swap and layout reflow), `max-width:520px` (small-phone-specific sizing), and `min-width:1700px` (wide-desktop grid widening).
- This PR also removed the unused, render-blocking Supabase SDK `<script>` tag from the page head (see §13) as part of the same "fix unused blocking Supabase CDN" change (PR title: "Mobile responsive overhaul + fix unused blocking Supabase CDN").
- Legal/Privacy pages, dialogs, and the AI panel were all verified (in earlier sessions covered by this history) to open/close correctly on both desktop and mobile viewports as part of this PR's verification rounds.

## 13. TerraIntel

A **wholly separate interface** that must not be broken while working on the main portfolio. Protected scope:
- `public/terraintel/**` (frontend: `index.html` + `vendor/` MapLibre GL JS 5.7.1)
- `lib/terraintel.js` (backend: AI analyze endpoint, own rate limiter/daily cap/timeout/config, all read from env vars prefixed `TERRAINTEL_*`)
- `test/terraintel.test.js`
- Routes: `/api/terraintel/*`, `/terraintel/`

It shares nothing with the main site's Projects/Certificates/Skills/Contact/AI code — different AI model (`sber/gigachat-2` vs the main site's `openai/gpt-oss-20b`), different system prompt, different rate limits, same-origin only (no CORS, no Cloudflare Worker — per PR #7's explicit migration away from that architecture).

## 14. Storage (Supabase history)

Supabase is **no longer the primary storage for portfolio data**:
- Certificates moved to Timeweb S3 in PR #8/subsequent (per PR history, "Certificates: Supabase → Timeweb Cloud S3").
- Projects moved to the same Timeweb S3 backend in **PR #23** (merge commit `570b05f770cc42b7cf71596e5238a03c8aef2baf`, "Projects section: migrate from Supabase to own backend + Timeweb Cloud S3").
- The frontend's Supabase SDK `<script>` tag was removed in **PR #24**; confirmed via an explicit code comment still present in `public/index.html` (~line 1710): *"The Supabase SDK `<script>` tag that used to load here is gone: confirmed unused anywhere in public/ (no window.supabase/createClient/db.from(/db.storage/db.auth/signInWithPassword/portfolio_projects references)..."*
- **Do not reintroduce Supabase without an explicit reason** — it has been deliberately migrated away from for both Projects and Certificates.
- **Remaining legacy references found during this audit (flagging, not fixing):**
  - `README.md` is stale: it still describes "проекты и изображения проектов из Supabase" and "сертификаты из Supabase Storage" and lists "Supabase Database, Storage и RLS" in the Stack/Architecture sections, and its `project structure` diagram omits `lib/certificates.js`/`lib/projects.js`/`public/terraintel` details that actually exist. This is a documentation accuracy gap, not a functional Supabase dependency.
  - The Projects section's hardcoded TerraIntel fallback card (§7) still lists `'Supabase'` as one of its display tags (`tags:['Python','AI','SQL','API','Supabase','GeoPandas','Leaflet']`) — a stale label on a placeholder card, not an actual data dependency.
  - `supabase/projects_contacts.sql` still exists in the repo as a legacy SQL schema file, kept for historical reference, not read by any running code.

## 15. Auth / Security

- `?admin=1` is **never** backend auth — it is purely a frontend UI-visibility signal, independently re-derived by each of Projects/Certificates/Skills (§6).
- Real protection for Projects and Certificates: `requireOwnerSession` middleware (signed HMAC-SHA256 cookie via `SESSION_SECRET`), applied via `requireSameOrigin, requireOwnerSession` on every mutating route in both `lib/certificates.js` and `lib/projects.js`.
- Confirmed behavior (code-level, backed by regression tests in `test/certificates.test.js` and `test/projects.test.js`): POST/PATCH/DELETE without a valid session → `401 {"error":"Требуется вход владельца."}`; public GET routes → `200`, no auth required.
- `requireSameOrigin` additionally rejects (`403`) any mutating request whose Origin/Referer doesn't match `CERT_ALLOWED_ORIGIN`.
- Login (`POST /api/certificates/login`) is itself rate-limited (10/15min) and uses `bcrypt.compare` against `ADMIN_PASSWORD_HASH` (never a plaintext password in code or env).
- **Skills is the one exception**: no backend at all, so there is nothing server-side to lock down — protection is frontend-only (markup `hidden` + function-level `if(!ADMIN)return` guards + `pageshow` re-assertion, §9). This is architecturally different from, and not comparable in risk to, the Projects/Certificates model, since nothing Skills' "admin mode" does ever leaves the visitor's own browser.
- `helmet` is applied with CSP disabled (explicit tradeoff, documented in `server.js`, to keep the existing inline-style/script single-file frontend working).

## 16. Deployment

- Hosting: **Timeweb Cloud App Platform**.
- Branch: deploys from `main`, auto-deploy (per README "Production" section and prior session's confirmed deploy-on-merge behavior).
- Start command: `npm start` (`node server.js`).
- Health check: `GET /health`.
- Production URL: `https://supaplex777-evgeny-portfolio-timeweb-1140.twc1.net/`.
- **This sandbox cannot reach `twc1.net`** — egress is blocked by this environment's network policy (confirmed repeatedly via proxy status checks in prior sessions). Checking the deployed SHA, verifying the Skills fix, or measuring real AI latency against production **must be done manually by the user**, e.g. by comparing `curl https://supaplex777-evgeny-portfolio-timeweb-1140.twc1.net/health` timing/response and checking the Timeweb dashboard's deployed commit against `9b3101b5a9a60ec46e5c04647948c03665b705e8`.

## 17. Tests

Current baseline: **94/94 passing** on `main` @ `9b3101b5a9a60ec46e5c04647948c03665b705e8` (just re-run in this session via `npm test`, no code changes made before or after).

Test files:
- `test/certificates.test.js` — largest file; covers public GET routes, admin login/session, CRUD auth boundaries (401 without session), the PR #26-added `createS3Client` singleton test, cache-bypass-for-`options.s3` test, and the create/update/delete cache-invalidation regression test.
- `test/certificates-rotate.test.js` — tests for the standalone upload-preview rotation helper.
- `test/contact.test.js` — `/api/contact` validation, honeypot, dedupe, Telegram/email delivery paths.
- `test/projects.test.js` — public GET routes, CRUD auth boundaries (PATCH/DELETE-without-session → 401, added in PR #25), gallery routes.
- `test/seed-resellflow.test.js` — tests for the idempotent ResellFlow seed script.
- `test/skills-public-admin.test.js` — source-level assertions on `public/index.html` pinning the ADMIN gate, the `mode()`/click-handler/`save()` guards, the `pageshow` re-assertion (PR #26), the "exactly one Skills render path" invariant, and the "no `/api/skills` backend exists" invariant.
- `test/terraintel.test.js` — TerraIntel analyze endpoint, rate limiting, JSON extraction tolerance.

Regression tests added and when: PR #25 added the Skills public/admin test file plus PATCH/DELETE-without-session 401 tests for both Projects and Certificates; PR #26 extended `skills-public-admin.test.js` with the `pageshow` and single-render-path tests, and extended `certificates.test.js` with the S3-singleton, cache-bypass, and cache-invalidation tests.

## 18. Git / PR history

| PR | Merge commit | Goal |
|---|---|---|
| #23 | `570b05f770cc42b7cf71596e5238a03c8aef2baf` (2026-10-05) | Migrate Projects off Supabase onto own backend + Timeweb Cloud S3 |
| #24 | `4c368d428731cfa0e287fd491b322f12fbec39ad` (2026-10-06) | Mobile responsive overhaul across all sections; removed unused blocking Supabase CDN `<script>` |
| #25 | `c7fb831bbcf9be461428866d16ee27efb72831ec` (2026-10-08) | Fixed Skills edit controls being fully public (no ADMIN gate at all); audited Projects/Certificates and confirmed they were already properly protected |
| #26 | `9b3101b5a9a60ec46e5c04647948c03665b705e8` (2026-10-08) | Hardened Skills gate against bfcache/`pageshow` restoration; optimized `/api/ai` by reusing one `S3Client` and caching the certificates summary (60s TTL) with explicit invalidation on every certificate write |

Each of these added tests (see §17) and is traceable in `git log` on `main`. Earlier history (PRs #1–#22) covers earlier UI/hero/navigation fixes, the original Telegram contact-notification feature, the ResellFlow placeholder, the original TerraIntel migration off Cloudflare Workers (#7), and the original Certificates Supabase→S3 migration (#8/#9).

## 19. Known issues / open items

1. **AI first-response latency** — the S3-layer inefficiency (fresh client + uncached fan-out per request) is fixed in code (PR #26), but **real production Polza/Timeweb network latency has never been measured from this sandbox** and this issue should **not** be considered fully closed until verified against the live production endpoint.
2. **Projects P3: duplicated title text in DOM** — the `.title-full`/`.title-short` dual-span pattern in the Projects card renderer keeps both spans present in the DOM; `textContent`/raw-DOM extraction may contain both titles, although visually and in the accessibility tree only the active variant is shown. No visual or accessibility impact, but affects raw-DOM reads/copy/SEO. Recommend a small, separate follow-up PR rather than folding it into unrelated work.
3. **MAX notifications** — explicitly flagged by the user as the next major task for the site; confirmed via code search that **no such feature exists yet anywhere in the repository** (no "MAX" notification code, no related route, no related frontend markup found).
4. **README.md is stale** (§14) — still describes Projects/Certificates as Supabase-backed and lists Supabase in the Stack section, which no longer matches the actual architecture.
5. **Supabase tag leftover** on the Projects section's hardcoded TerraIntel fallback card (§7/§14) — cosmetic label text only, not a functional dependency.
6. **This sandbox cannot verify anything in production** — no claim in this document about live site behavior (as opposed to the committed code) should be treated as confirmed; it is confirmed only for the code at `9b3101b5a9a60ec46e5c04647948c03665b705e8`.

## 20. Next tasks

Per the user's explicit priority: MAX notifications is the next major feature (not yet started, not yet designed in this repo). The P3 title-duplication issue and the README staleness are candidate small/independent follow-ups. No other outstanding task was specified by the user as of this handoff.

## 21. Working rules for future agents

1. Never edit `main` directly — always create a feature/fix branch first.
2. For any new task, branch naming should follow the existing convention (`feature/...` or `fix/...`).
3. Run `npm test` before starting (confirm the baseline, currently 94/94) and again before considering work done.
4. Use `git diff --stat main...HEAD` and `git diff --name-status main...HEAD` to review the full scope of changes before opening a PR.
5. Open PRs as **Draft** by default.
6. **Never merge a PR without the user's explicit permission**, even if all checks pass.
7. **Never break TerraIntel** (§13's protected file/route list) unless the task is explicitly about TerraIntel.
8. **Never break the mobile layout** established in PR #24 — check both desktop and mobile viewports for any frontend change.
9. If the task is explicitly frontend-only, do not touch `server.js`/`lib/*.js` unless the frontend change requires a corresponding, clearly-scoped backend change.
10. **Do not reintroduce Supabase** without an explicit, stated reason — it was deliberately migrated away from.
11. Always check public (no `?admin=1`) and admin (`?admin=1` + valid session) behavior **separately** for any change touching Projects, Certificates, or Skills.
12. **Never treat `?admin=1` as backend authentication** — it is a frontend signal only; real protection is `requireOwnerSession`.
13. Check both desktop and mobile viewports for any UI change.
14. Check browser console for new errors after any frontend change.
15. Check for horizontal overflow/scrollbars after any layout change, especially on mobile widths.
16. **Only make claims about production behavior if production was actually verified** (reachable and checked) — otherwise state explicitly that it is unverified.
17. **If the sandbox cannot reach Timeweb/production, say so explicitly** rather than assuming success or failure.
18. Do not expand scope beyond what was asked — a bug fix doesn't need unrelated refactoring.
19. P0/P1 issues (real bugs, security gaps) found incidentally may be fixed directly as part of the current task if clearly in scope; genuinely out-of-scope P2/P3 issues should first be recorded (in the PR description or a report) rather than fixed opportunistically.
20. Keep this document's facts (routes, auth model, file locations, known issues) as the baseline truth for a cold-start agent, but **always re-verify against the actual current `main` HEAD** before acting, since this snapshot will drift out of date as new work merges.

## 22. Recovery checklist for new agent

### Если новый чат получил этот handoff, что делать первым

1. `git fetch origin main`
2. `git checkout main`
3. `git pull origin main`
4. `git log -1 --oneline` (and `git rev-parse HEAD`)
5. Confirm the current `main` SHA matches (or note how it has advanced since) `9b3101b5a9a60ec46e5c04647948c03665b705e8`
6. `npm install` (only if `node_modules/` is missing or `package-lock.json` changed)
7. `npm test` — confirm the test baseline (94/94 as of this handoff; investigate any new failures before doing anything else)
8. `git status` — confirm a clean working tree before starting any new work
9. Read `README.md` (but cross-check it against this handoff's §14 — it is known to be stale in places)
10. Only then take on a new task — create a feature/fix branch per §21's rules, and treat §§1–20 above as the current factual baseline, re-verified as needed against the live repository.

HANDOFF READY
