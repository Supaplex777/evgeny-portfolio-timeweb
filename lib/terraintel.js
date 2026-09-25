'use strict';

/**
 * TerraIntel AI backend.
 *
 * Isolated Express router for the TerraIntel MVP (/terraintel). It is fully
 * independent from the portfolio AI (/api/ai): own prompt, own model, own rate
 * limits, own validation. The browser never sees POLZA_API_KEY.
 *
 * POST /api/terraintel/analyze
 *   in:  { project: {name, area, description, threshold}, anomalies: [...] }
 *   out: { llm_interpretations: [{id, explanation, recommendation}], model, ai_status }
 */

const express = require('express');
const { rateLimit } = require('express-rate-limit');

const POLZA_API_URL = 'https://polza.ai/api/v1/chat/completions';

const intFromEnv = (name, fallback, min, max) => {
  const n = Number.parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const CONFIG = Object.freeze({
  model: String(process.env.TERRAINTEL_MODEL || 'sber/gigachat-2').trim(),
  maxAnomalies: 20,
  maxBodyBytes: 64 * 1024,
  timeoutMs: intFromEnv('TERRAINTEL_TIMEOUT_MS', 30000, 5000, 60000),
  rateWindowMs: 15 * 60 * 1000,
  rateLimit: intFromEnv('TERRAINTEL_RATE_LIMIT', 10, 1, 1000),
  dailyLimit: intFromEnv('TERRAINTEL_DAILY_LIMIT', 200, 1, 100000),
  maxTokens: 1800
});

const SYSTEM_PROMPT = [
  'Ты — аналитический помощник учебной платформы TerraIntel (магнитометрия + GPS/ГЛОНАСС).',
  'Тебе передают только подготовленный список статистических аномалий магнитного поля: идентификатор, координаты, модуль Robust Z (медиана/MAD), номер отсчёта и время. Сырые CSV тебе не передаются.',
  'Твоя роль — объяснить каждую аномалию простым профессиональным языком и предложить порядок дальнейшей проверки. Ты не принимаешь решений.',
  'Запрещено: определять тип, материал или происхождение источника по одной магнитометрии; утверждать или намекать, что обнаружена мина, снаряд, боеприпас, оружие или взрывоопасный предмет; объявлять территорию или участок безопасными; давать окончательные выводы.',
  'Robust Z показывает только силу статистического отклонения от фона, а не вероятность опасности. Большой Robust Z означает более высокий приоритет повторной проверки, не более.',
  'Возможные неопасные причины отклонений (помехи, металлические конструкции, коммуникации, геология, ошибки синхронизации GPS) можно упоминать только как гипотезы, требующие проверки.',
  'Каждая рекомендация должна заканчиваться необходимостью экспертной проверки специалистом.',
  'Пиши по-русски. explanation — 1–3 предложения, recommendation — 1–2 предложения.',
  'Ответ — строго один JSON-объект без Markdown и без текста вокруг, формата:',
  '{"llm_interpretations":[{"id":"TI-001","explanation":"...","recommendation":"..."}]}',
  'Верни по одному элементу для каждого переданного id и не добавляй другие id.'
].join('\n');

// Affirmative claims the model must never make; such items fall back to the
// neutral local explanation on the frontend.
const FORBIDDEN_CLAIMS = [
  /(обнаружен[аоы]?|найден[аоы]?|является|это|вероятно|скорее всего)\s+(противопехотн\S*\s+|противотанков\S*\s+)?(мин[аыу]\b|снаряд|боеприпас|оружи|взрыв\S*\s+(предмет|устройств))/i,
  /(территори[яи]|участок|зона|район)\s+(является\s+)?(безопасн|свободн[аоы]?\s+от)/i
];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cleanText = (value, maxLength) => String(value ?? '')
  .replace(/[\u0000-\u001F\u007F]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const finiteNumber = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Validates and whitelists the request payload. Unknown fields are dropped so
 * nothing but prepared anomaly data ever reaches the model.
 */
function validatePayload(body) {
  if (!isPlainObject(body)) throw new HttpError(400, 'Ожидается JSON-объект.');
  const { project, anomalies } = body;
  if (!isPlainObject(project)) throw new HttpError(400, 'Не передан объект project.');
  if (!Array.isArray(anomalies)) throw new HttpError(400, 'Поле anomalies должно быть массивом.');
  if (anomalies.length > CONFIG.maxAnomalies) {
    throw new HttpError(400, `Слишком много аномалий: максимум ${CONFIG.maxAnomalies}.`);
  }

  const name = cleanText(project.name, 120);
  if (!name) throw new HttpError(400, 'Не указано название проекта.');
  const threshold = finiteNumber(project.threshold);
  if (threshold === null || threshold < 0.1 || threshold > 1000) {
    throw new HttpError(400, 'Некорректный порог аномалии.');
  }
  const cleanProject = {
    name,
    area: cleanText(project.area, 160),
    description: cleanText(project.description, 1000),
    threshold
  };

  const seen = new Set();
  const cleanAnomalies = anomalies.map((a, i) => {
    const where = `Аномалия №${i + 1}`;
    if (!isPlainObject(a)) throw new HttpError(400, `${where}: ожидается объект.`);
    const id = cleanText(a.id, 32);
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new HttpError(400, `${where}: некорректный id.`);
    if (seen.has(id)) throw new HttpError(400, `${where}: повторяющийся id ${id}.`);
    seen.add(id);
    const lat = finiteNumber(a.lat);
    const lon = finiteNumber(a.lon);
    if (lat === null || lat < -90 || lat > 90) throw new HttpError(400, `${where}: некорректная широта.`);
    if (lon === null || lon < -180 || lon > 180) throw new HttpError(400, `${where}: некорректная долгота.`);
    const robustZ = finiteNumber(a.robust_z);
    if (robustZ === null || Math.abs(robustZ) > 1e6) throw new HttpError(400, `${where}: robust_z должен быть числом.`);
    const out = { id, lat, lon, robust_z: Number(robustZ.toFixed(3)) };
    const sampleIndex = finiteNumber(a.sample_index);
    if (sampleIndex !== null && Number.isInteger(sampleIndex) && sampleIndex >= 0) out.sample_index = sampleIndex;
    const ts = a.timestamp;
    if (typeof ts === 'number' && Number.isFinite(ts)) {
      const d = new Date(ts);
      out.timestamp = ts > 1e11 && !Number.isNaN(d.getTime()) ? d.toISOString() : ts;
    } else if (typeof ts === 'string' && ts.trim()) {
      out.timestamp = cleanText(ts, 40);
    }
    return out;
  });

  return { project: cleanProject, anomalies: cleanAnomalies };
}

/** Extracts the first JSON object from model output (tolerates ```json fences). */
function extractJson(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(raw); } catch { /* try substring */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fallthrough */ }
  }
  return null;
}

/** Maps model output to known ids only; drops unsafe or empty items. */
function normalizeInterpretations(parsed, knownIds) {
  const list = Array.isArray(parsed) ? parsed
    : Array.isArray(parsed?.llm_interpretations) ? parsed.llm_interpretations
      : Array.isArray(parsed?.interpretations) ? parsed.interpretations
        : null;
  if (!list) return { items: [], dropped: 0 };
  const out = new Map();
  let dropped = 0;
  for (const item of list) {
    if (!isPlainObject(item)) continue;
    const id = cleanText(item.id, 32);
    if (!knownIds.has(id) || out.has(id)) continue;
    const explanation = cleanText(item.explanation, 1200);
    const recommendation = cleanText(item.recommendation, 800);
    if (!explanation) continue;
    if (FORBIDDEN_CLAIMS.some((re) => re.test(explanation) || re.test(recommendation))) {
      dropped += 1;
      continue;
    }
    out.set(id, {
      id,
      explanation,
      recommendation: recommendation || 'Требуется повторная проверка и экспертная оценка специалистом.'
    });
  }
  return { items: [...out.values()], dropped };
}

function buildUserMessage({ project, anomalies }) {
  return [
    'ПРОЕКТ TerraIntel:',
    JSON.stringify(project),
    '',
    `АНОМАЛИИ (${anomalies.length}, отсортированы по убыванию |Robust Z|, порог ${project.threshold}):`,
    JSON.stringify(anomalies),
    '',
    'Сформируй JSON строго по заданному формату.'
  ].join('\n');
}

// Global daily budget guard (in-memory, per process; resets at 00:00 UTC).
const dailyBudget = { day: '', count: 0 };
function takeDailyBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (dailyBudget.day !== today) { dailyBudget.day = today; dailyBudget.count = 0; }
  if (dailyBudget.count >= CONFIG.dailyLimit) return false;
  dailyBudget.count += 1;
  return true;
}

async function callPolza(payload) {
  const upstream = await fetch(POLZA_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.POLZA_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: CONFIG.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(payload) }
      ],
      temperature: 0.2,
      max_tokens: CONFIG.maxTokens
    }),
    signal: AbortSignal.timeout(CONFIG.timeoutMs)
  });

  const raw = await upstream.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }

  if (!upstream.ok) {
    console.error('[terraintel] Polza HTTP', upstream.status, cleanText(data?.error?.message || data?.message || raw, 300));
    throw new HttpError(502, 'AI-сервис временно недоступен. Результаты локального анализа сохранены.');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    console.error('[terraintel] Polza returned no content');
    throw new HttpError(502, 'AI-сервис вернул пустой ответ.');
  }
  return String(content);
}

const terraRateLimiter = rateLimit({
  windowMs: CONFIG.rateWindowMs,
  limit: CONFIG.rateLimit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Слишком много запросов к AI TerraIntel. Попробуйте снова через 15 минут.' }
});

function createTerraIntelRouter() {
  const router = express.Router();

  router.post('/analyze', terraRateLimiter, async (req, res, next) => {
    const started = Date.now();
    try {
      const length = Number(req.get('content-length') || 0);
      if (length > CONFIG.maxBodyBytes) throw new HttpError(413, 'Слишком большой запрос к AI TerraIntel.');

      const payload = validatePayload(req.body);
      if (!payload.anomalies.length) {
        return res.json({ llm_interpretations: [], model: 'локальный анализ', ai_status: 'skipped' });
      }
      if (!process.env.POLZA_API_KEY) {
        console.error('[terraintel] POLZA_API_KEY is not configured');
        throw new HttpError(500, 'AI TerraIntel не настроен на сервере.');
      }
      if (!takeDailyBudget()) {
        throw new HttpError(429, 'Дневной лимит AI-запросов TerraIntel исчерпан. Попробуйте завтра.');
      }

      const content = await callPolza(payload);
      const parsed = extractJson(content);
      const knownIds = new Set(payload.anomalies.map((a) => a.id));
      const { items, dropped } = normalizeInterpretations(parsed, knownIds);
      if (!items.length) {
        console.error('[terraintel] Unusable model output', { parsed: Boolean(parsed), dropped, sample: cleanText(content, 200) });
        throw new HttpError(502, 'AI-сервис вернул ответ в неверном формате.');
      }

      console.log('[terraintel] analyze ok', {
        anomalies: payload.anomalies.length,
        interpreted: items.length,
        dropped,
        ms: Date.now() - started
      });
      return res.json({
        llm_interpretations: items,
        model: CONFIG.model,
        ai_status: items.length === payload.anomalies.length ? 'ok' : 'partial'
      });
    } catch (error) {
      return next(error);
    }
  });

  // Router-scoped error handler: always JSON, never stack traces.
  // eslint-disable-next-line no-unused-vars
  router.use((error, req, res, next) => {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      console.error('[terraintel] Polza timeout');
      return res.status(504).json({ error: 'AI-сервис не ответил вовремя. Результаты локального анализа сохранены.' });
    }
    console.error('[terraintel] Internal error:', error?.message || error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера TerraIntel.' });
  });

  return router;
}

/**
 * Headers for the /terraintel static pages only. Helmet sets
 * `Referrer-Policy: no-referrer` globally; MapTiler domain-restricted keys
 * need the page origin, so TerraIntel pages send the origin (never full path).
 */
function terraIntelPageHeaders(req, res, next) {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

module.exports = {
  createTerraIntelRouter,
  terraIntelPageHeaders,
  // exported for tests
  _internal: { validatePayload, extractJson, normalizeInterpretations, buildUserMessage, HttpError, CONFIG, SYSTEM_PROMPT }
};
