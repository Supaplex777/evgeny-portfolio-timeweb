'use strict';

// Loaded via `node --require` before server.js runs, so contact.test.js can
// exercise every Telegram outcome deterministically - without touching the
// real Bot API and without depending on this environment's own network
// policy (unlike a real request to a blocked/unreachable host, which is
// not something a CI runner can be relied on to reproduce the same way).
//
// Controlled by MOCK_TELEGRAM_MODE:
//   ok            -> 200 { ok: true }
//   http_error    -> 401 { ok: false, description: 'Unauthorized' }
//   timeout       -> throws a TimeoutError, like AbortSignal.timeout() would
//   network_error -> throws a TypeError, like a DNS/connect failure would
//
// Any request whose URL is not api.telegram.org falls through to the real
// global fetch unchanged (nothing else needs mocking now that Supabase is
// gone from the contact route; Resend is simply left unconfigured in tests).

const realFetch = global.fetch;
const mode = process.env.MOCK_TELEGRAM_MODE;

global.fetch = async (url, init) => {
  const href = typeof url === 'string' ? url : url?.url || String(url);
  if (!href.includes('api.telegram.org')) {
    return realFetch(url, init);
  }

  if (mode === 'timeout') {
    const error = new Error('The operation was aborted due to timeout');
    error.name = 'TimeoutError';
    throw error;
  }
  if (mode === 'network_error') {
    const error = new TypeError('fetch failed');
    throw error;
  }
  if (mode === 'http_error') {
    return new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  // Default: 'ok'
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};
