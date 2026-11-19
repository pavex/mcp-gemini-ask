// GeminiClient.js — askGemini(): tries models in order until one answers.
//
// Returns { ok: true, text } or { ok: false, message }. The message is meant
// for the calling agent and says whether and when retrying makes sense; the
// per-model details go only to the log.
//
// The whole call has to finish within Config.timeoutMs (the hub gives up on
// a request after 30 s); one model gets at most Config.modelTimeoutMs of it.

import { Config } from './Config.js';
import { log }    from './Log.js';
import * as Cache  from './ModelCache.js';
import * as Models from './GeminiModels.js';
import { generate } from './GeminiAPI.js';

// When every model turned out unusable, refresh the list and retry - but not
// more often than this, so a broken catalog does not trigger a probe storm.
const MIN_REFRESH_INTERVAL_MS = 10 * 60_000;
// Below this much time left, starting another model is pointless.
const MIN_ATTEMPT_MS = 3_000;

export function formatWait(sec) {
  if (sec < 60)   return `${Math.max(1, Math.ceil(sec))} s`;
  if (sec < 3600) return `${Math.ceil(sec / 60)} min`;
  return `${Math.ceil(sec / 3600)} h`;
}

const secondsUntil = (ts) => Math.max(0, (ts - Date.now()) / 1000);

async function tryModels(candidates, prompt, deadline) {
  const s = { tried: candidates.length, rpm: 0, rpd: 0, wait: null, transient: 0, rejected: 0, unusable: 0, auth: 0, detail: null, outOfTime: false };
  const noteWait = (sec) => { if (s.wait === null || sec < s.wait) s.wait = sec; };

  for (const { id } of candidates) {
    if (Cache.isBlocked(id)) {
      const entry = Cache.getEntry(id);
      if (entry.status === 'error') s.unusable++;
      else if (entry.status === 'quota_rpd') s.rpd++;
      else if (entry.status === 'slow') s.transient++;
      else { s.rpm++; noteWait(secondsUntil(entry.retry_after_ts)); }
      log(`  ${id}: skipped (${entry.status}${entry.retry_after_ts && entry.status !== 'quota_rpd' ? `, ${formatWait(secondsUntil(entry.retry_after_ts))} left` : ''})`);
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining < MIN_ATTEMPT_MS) {
      s.outOfTime = true;
      log(`  ${id}: not tried, time limit of ${Config.timeoutMs / 1000} s reached`);
      break;
    }

    const started = Date.now();
    const result  = await generate(id, prompt, Math.min(Config.modelTimeoutMs, remaining));
    const took    = `${((Date.now() - started) / 1000).toFixed(1)} s`;

    switch (result.kind) {
      case 'ok':
        Cache.setOk(id);
        log(`  ${id}: OK (${took}, ${result.text.length} chars)`);
        return { ok: true, text: result.text, model: id };

      case 'blocked':
        Cache.countFailure(id);
        log(`  ${id}: blocked (${result.reason})`);
        return { ok: false, blocked: result.reason };

      case 'quota':
        Cache.setQuota(id, result.quotaMetric, result.retryAfterSec);
        if (result.quotaMetric === 'qpd') s.rpd++;
        else { s.rpm++; noteWait(result.retryAfterSec); }
        log(`  ${id}: quota ${result.quotaMetric === 'qpd' ? 'per day' : `per minute, retry in ${result.retryAfterSec} s`}`);
        break;

      case 'timeout':
        Cache.setSlow(id, Models.SLOW_PAUSE_SEC);
        s.transient++;
        s.detail = result.message;
        log(`  ${id}: ${result.message}, paused for ${Models.SLOW_PAUSE_SEC / 60} min`);
        break;

      case 'auth':
        Cache.setError(id);
        s.auth++;
        log(`  ${id}: HTTP ${result.status}, no access (${result.message})`);
        break;

      case 'gone':
        Cache.setError(id);
        s.unusable++;
        log(`  ${id}: HTTP 404, model no longer exists`);
        break;

      case 'rejected':
        Cache.countFailure(id);
        s.rejected++;
        log(`  ${id}: HTTP 400, request rejected (${result.message})`);
        break;

      default: // network, unavailable (5xx)
        Cache.countFailure(id);
        s.transient++;
        s.detail = result.status ? `HTTP ${result.status}` : result.message;
        log(`  ${id}: ${result.kind} (${s.detail}, ${took})`);
    }
  }
  return { ok: false, stats: s };
}

function describeFailure({ blocked, stats: s }) {
  if (blocked) {
    return `Gemini refused to answer this prompt (${blocked}). Retrying the same prompt will not help; rephrase it or tell the user.`;
  }
  if (s.rpm || s.transient || s.outOfTime) {
    const parts = [];
    if (s.rpm)       parts.push(`${s.rpm} over per-minute quota`);
    if (s.rpd)       parts.push(`${s.rpd} over daily quota`);
    if (s.transient) parts.push(`${s.transient} not responding${s.detail ? ` (${s.detail})` : ''}`);
    if (s.outOfTime) parts.push(`time limit of ${Config.timeoutMs / 1000} s reached`);
    const wait = s.rpm && !s.transient && !s.outOfTime ? formatWait(s.wait ?? 60) : '1 min';
    return `Gemini is temporarily unavailable (${parts.join(', ')}). Try again in about ${wait}; `
      + 'if it still fails after 2-3 attempts, tell the user Gemini is unavailable.';
  }
  if (s.rpd) {
    const midnight = new Date(); midnight.setUTCHours(24, 0, 0, 0);
    return `Gemini is unavailable: the daily quota of all models is used up. It resets at midnight UTC `
      + `(in about ${formatWait(secondsUntil(midnight.getTime()))}). Do not retry before then; tell the user.`;
  }
  if (s.rejected) {
    return 'Gemini rejected the request (HTTP 400): the prompt is probably too long or in a form the models do not accept. '
      + 'Retrying it unchanged will not help.';
  }
  if (s.auth && s.auth === s.tried) {
    return 'Gemini rejected the API key for every model (HTTP 401/403). Retrying will not help; the server configuration needs fixing.';
  }
  return 'No usable Gemini model is available right now. Retrying will not help; tell the user.';
}

/** Resolves to the promise's value, or to `fallback` once `ms` passes. */
function within(promise, ms, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, ms), fallback); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const STILL_LOADING = Symbol('still loading');

/** Sends the prompt to the best available model, falling back to the next on failure. */
export async function askGemini(prompt) {
  const deadline = Date.now() + Config.timeoutMs;
  log(`ask_gemini (${prompt.length} chars)`);

  let candidates;
  try {
    candidates = await within(Models.ensureModels(), deadline - Date.now() - MIN_ATTEMPT_MS, STILL_LOADING);
  } catch (e) {
    log(`Model list unavailable: ${e.message}`);
    return { ok: false, message: `Gemini is unavailable: the list of models could not be loaded (${e.message}). Try again later.` };
  }
  if (candidates === STILL_LOADING) {
    log('Model list is still being prepared - answering with a retry hint');
    return { ok: false, message: 'Gemini is getting ready (the list of available models is being prepared). Try again in about 30 s.' };
  }

  let outcome = await tryModels(candidates, prompt, deadline);

  const allUnusable = !outcome.ok && !outcome.blocked
    && outcome.stats.unusable + outcome.stats.auth === outcome.stats.tried;
  if (allUnusable && !Models.isFixed() && Models.refreshAgeMs() > MIN_REFRESH_INTERVAL_MS) {
    log('No usable model left - refreshing the model list');
    const refreshed = Models.refresh('all models unusable');
    refreshed.catch(e => log(`Model refresh failed: ${e.message}`));
    const ready = await within(refreshed.then(() => true, () => false), deadline - Date.now() - MIN_ATTEMPT_MS, false);
    if (ready) outcome = await tryModels(Models.orderedModels(), prompt, deadline);
    else if (!outcome.ok) outcome = { ok: false, stats: { ...outcome.stats, outOfTime: true } };
  }

  Models.save();

  if (outcome.ok) return { ok: true, text: outcome.text };
  const message = describeFailure(outcome);
  log(`ask_gemini failed: ${message}`);
  return { ok: false, message };
}
