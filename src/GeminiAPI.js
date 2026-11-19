// GeminiAPI.js — low-level Gemini REST calls: ListModels and generateContent.
// Pure: no cache, no persistence; callers decide what to do with the result.

import { Config } from './Config.js';

async function request(url, init = {}) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), Config.fetchTimeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: { ...init.headers, 'x-goog-api-key': Config.apiKey },
      signal:  controller.signal,
    });
  } finally {
    clearTimeout(timeout);
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

    const res = await request(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ListModels HTTP ${res.status}${body ? ` - ${body.slice(0, 300)}` : ''}`);
    }

    const json = await res.json();
    for (const m of json.models ?? []) {
      if ((m.supportedGenerationMethods ?? []).includes('generateContent')) {
        ids.push(m.name.replace(/^models\//, ''));
      }
    }
    pageToken = json.nextPageToken;
  } while (pageToken);

  return ids;
}

/** Reads quota type (per minute / per day) and wait time from a 429 response. */
async function parse429(res) {
  let quotaMetric   = 'qpm';
  let retryAfterSec = 60;

  const header = parseInt(res.headers.get('retry-after') ?? '', 10);
  if (!isNaN(header)) retryAfterSec = header;

  try {
    const body = await res.json();
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
  } catch { /* body is not JSON */ }

  return { quotaMetric, retryAfterSec };
}

/** Returns { text } or { blocked: reason } from a generateContent response. */
function extractResponse(json) {
  const candidate = json.candidates?.[0];

  if (!candidate) {
    const blockReason = json.promptFeedback?.blockReason;
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

/**
 * One generateContent request against one model, classified:
 *   { kind: 'ok',         text }
 *   { kind: 'quota',      quotaMetric, retryAfterSec }
 *   { kind: 'auth',       status }          401/403 - the API key is rejected
 *   { kind: 'gone',       status }          404 - the model no longer exists
 *   { kind: 'rejected',   status }          400 - this model refused this request
 *   { kind: 'unavailable', status }         5xx and other HTTP errors - transient
 *   { kind: 'blocked',    reason }
 *   { kind: 'timeout',    message }
 *   { kind: 'network',    message }
 */
export async function generate(modelId, prompt) {
  try {
    const res = await request(`${Config.baseUrl}models/${modelId}:generateContent`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    });

    if (res.status === 429) return { kind: 'quota', ...await parse429(res) };
    if (res.status === 401 || res.status === 403) return { kind: 'auth', status: res.status };
    if (res.status === 404) return { kind: 'gone', status: 404 };
    if (res.status === 400) return { kind: 'rejected', status: 400 };
    if (!res.ok) return { kind: 'unavailable', status: res.status };

    const result = extractResponse(await res.json());
    if (result.blocked) return { kind: 'blocked', reason: result.blocked };
    return { kind: 'ok', text: result.text };
  } catch (err) {
    return err.name === 'AbortError'
      ? { kind: 'timeout', message: `no response within ${Config.fetchTimeoutMs} ms` }
      : { kind: 'network', message: err.message };
  }
}
