// GeminiAPI.js — low-level Gemini REST calls: ListModels and generateContent.
// Pure: no cache, no persistence; callers decide what to do with the result.

import { Config } from './Config.js';

/**
 * One HTTP request whose timeout covers the whole exchange, body included -
 * a model may send headers and then never finish the body.
 * Returns { status, ok, headers, body } (body parsed as JSON, or null).
 */
async function request(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res  = await fetch(url, {
      ...init,
      headers: { ...init?.headers, 'x-goog-api-key': Config.apiKey },
      signal:  controller.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, headers: res.headers, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Lists IDs of all models that support generateContent (paginated). Throws on failure. */
export async function listModelIds() {
  const ids = [];
  let pageToken;

  do {
    const url = new URL(`${Config.baseUrl}models`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    let res;
    try {
      res = await request(url, {}, Config.modelTimeoutMs);
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? `ListModels: no response within ${Config.modelTimeoutMs} ms` : `ListModels: ${e.message}`);
    }
    if (!res.ok) throw new Error(`ListModels HTTP ${res.status}${res.text ? ` - ${res.text.slice(0, 300)}` : ''}`);

    for (const m of res.body?.models ?? []) {
      if ((m.supportedGenerationMethods ?? []).includes('generateContent')) {
        ids.push(m.name.replace(/^models\//, ''));
      }
    }
    pageToken = res.body?.nextPageToken;
  } while (pageToken);

  return ids;
}

/** Reads quota type (per minute / per day) and wait time from a 429 response. */
function parse429({ headers, body }) {
  let quotaMetric   = 'qpm';
  let retryAfterSec = 60;

  const header = parseInt(headers.get('retry-after') ?? '', 10);
  if (!isNaN(header)) retryAfterSec = header;

  for (const d of body?.error?.details ?? []) {
    const metric = d?.metadata?.quota_metric ?? d?.violations?.[0]?.quotaId ?? '';
    if (/qpd|PerDay/i.test(metric)) { quotaMetric = 'qpd'; break; }
    if (/qpm|PerMinute/i.test(metric)) { quotaMetric = 'qpm'; break; }
    const delay = d?.retryDelay?.match(/^(\d+)/);
    if (delay) retryAfterSec = Number(delay[1]);
  }
  if (quotaMetric === 'qpm' && body?.error?.message?.toLowerCase().includes('per day')) {
    quotaMetric = 'qpd';
  }

  return { quotaMetric, retryAfterSec };
}

/** Returns { text } or { blocked: reason } from a generateContent response. */
function extractResponse(json) {
  const candidate = json?.candidates?.[0];

  if (!candidate) {
    const blockReason = json?.promptFeedback?.blockReason;
    return blockReason ? { blocked: `prompt blocked: ${blockReason}` } : { text: '' };
  }

  const text = (candidate.content?.parts ?? [])
    .filter(p => typeof p.text === 'string' && !p.thought)
    .map(p => p.text)
    .join('');

  if (!text && candidate.finishReason && candidate.finishReason !== 'STOP') {
    const ratings = candidate.safetyRatings
      ?.filter(r => r.blocked)
      .map(r => r.category.replace('HARM_CATEGORY_', ''))
      .join(', ');
    return { blocked: ratings ? `blocked: ${ratings}` : `finish reason: ${candidate.finishReason}` };
  }

  return { text };
}

/** Short reason from an error body, for the log. */
const errorMessage = (res) => (res.body?.error?.message ?? res.text ?? '').replace(/\s+/g, ' ').slice(0, 160);

/**
 * One generateContent request against one model, classified:
 *   { kind: 'ok',          text }
 *   { kind: 'quota',       quotaMetric, retryAfterSec }
 *   { kind: 'auth',        status, message }   401/403 - no access to this model
 *   { kind: 'gone',        status, message }   404 - the model no longer exists
 *   { kind: 'rejected',    status, message }   400 - this model refused this request
 *   { kind: 'unavailable', status, message }   5xx and other HTTP errors - transient
 *   { kind: 'blocked',     reason }
 *   { kind: 'timeout',     message }
 *   { kind: 'network',     message }
 */
export async function generate(modelId, prompt, timeoutMs = Config.modelTimeoutMs) {
  let res;
  try {
    res = await request(`${Config.baseUrl}models/${modelId}:generateContent`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    }, timeoutMs);
  } catch (err) {
    return err.name === 'AbortError'
      ? { kind: 'timeout', message: `no response within ${(timeoutMs / 1000).toFixed(0)} s` }
      : { kind: 'network', message: err.cause?.code ?? err.message };
  }

  const fail = (kind) => ({ kind, status: res.status, message: errorMessage(res) });
  if (res.status === 429) return { kind: 'quota', ...parse429(res) };
  if (res.status === 401 || res.status === 403) return fail('auth');
  if (res.status === 404) return fail('gone');
  if (res.status === 400) return fail('rejected');
  if (!res.ok) return fail('unavailable');

  const result = extractResponse(res.body);
  if (result.blocked) return { kind: 'blocked', reason: result.blocked };
  return { kind: 'ok', text: result.text };
}
