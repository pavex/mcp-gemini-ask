// ModelCache.js — in-memory availability status per model.
//
// status: 'ok' | 'quota_rpm' | 'quota_rpd' | 'error' | 'unknown'
//   quota_*  skipped until retry_after_ts (per-day quota: next midnight UTC)
//   error    skipped until the next model list refresh re-probes the model
// ok_count / fail_count count today's (UTC) outcomes for adaptive ordering.

const cache = new Map();

const todayUTC = () => new Date().toISOString().slice(0, 10);

const EMPTY = Object.freeze({
  status:         'unknown',
  retry_after_ts: null,
  last_checked:   null,
  ok_count:       0,
  fail_count:     0,
  count_day:      null,
});

/** The cache entry for a model, or a default "unknown" entry. */
export function getEntry(modelId) {
  return cache.get(modelId) ?? EMPTY;
}

function counts(modelId, ok) {
  const prev = cache.get(modelId);
  const day  = todayUTC();
  let ok_count   = prev?.count_day === day ? prev.ok_count   : 0;
  let fail_count = prev?.count_day === day ? prev.fail_count : 0;
  if (ok) ok_count++; else fail_count++;
  return { ok_count, fail_count, count_day: day };
}

export function setOk(modelId) {
  cache.set(modelId, { status: 'ok', retry_after_ts: null, last_checked: Date.now(), ...counts(modelId, true) });
}

/** quotaMetric 'qpd' blocks until midnight UTC, anything else for retryAfterSec. */
export function setQuota(modelId, quotaMetric, retryAfterSec) {
  const perDay = quotaMetric === 'qpd';
  let retry_after_ts;
  if (perDay) {
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    retry_after_ts = midnight.getTime();
  } else {
    retry_after_ts = Date.now() + (retryAfterSec > 0 ? retryAfterSec : 60) * 1000;
  }
  cache.set(modelId, {
    status: perDay ? 'quota_rpd' : 'quota_rpm',
    retry_after_ts,
    last_checked: Date.now(),
    ...counts(modelId, false),
  });
}

export function setError(modelId) {
  cache.set(modelId, { status: 'error', retry_after_ts: null, last_checked: Date.now(), ...counts(modelId, false) });
}

/** Counts a failure without changing the status (timeouts, 5xx, rejected requests). */
export function countFailure(modelId) {
  cache.set(modelId, { ...getEntry(modelId), ...counts(modelId, false) });
}

/** Restores a persisted entry as-is. */
export function restore(modelId, entry) {
  cache.set(modelId, { ...EMPTY, ...entry });
}

/** True while the model is on quota or marked unusable. An expired quota is reset to unknown. */
export function isBlocked(modelId) {
  const entry = getEntry(modelId);
  if (entry.status === 'error') return true;
  if (entry.status === 'quota_rpm' || entry.status === 'quota_rpd') {
    if (entry.retry_after_ts && Date.now() < entry.retry_after_ts) return true;
    cache.set(modelId, { ...entry, status: 'unknown', retry_after_ts: null });
  }
  return false;
}

/** Today's (UTC) failure ratio, 0 without data for today. */
export function getFailRatio(modelId) {
  const entry = getEntry(modelId);
  if (entry.count_day !== todayUTC()) return 0;
  const total = entry.ok_count + entry.fail_count;
  return total === 0 ? 0 : entry.fail_count / total;
}
