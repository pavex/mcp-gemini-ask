// GeminiModels.js — the list of usable models, kept up to date by the server itself.
//
// A fixed list in Config.models is used as given, in that order: no discovery,
// no probing, no TTL. Otherwise the server discovers the models itself:
//
// The list is stored in <dataDir>/models.json together with each model's
// status, so it survives restarts. It is refreshed (ListModels -> name filter
// -> one short probe call per candidate -> ranking):
//   - when there is no list yet: the first ask_gemini call waits for it;
//   - when the list is older than modelsTtlHours: in the background, the
//     current list keeps serving meanwhile (also checked at startup);
//   - when every model failed as unusable: GeminiClient refreshes and retries.
// Only one refresh runs at a time.

import fs   from 'node:fs';
import path from 'node:path';
import { Config }  from './Config.js';
import { log }     from './Log.js';
import * as Cache  from './ModelCache.js';
import { listModelIds, generate } from './GeminiAPI.js';

const ADAPTIVE_FAIL_WEIGHT = 200;   // max deduction for a model failing all of today's calls
const DEPRIORITIZE_PENALTY = 1000;  // models matching deprioritizeModels go last
const PROBE_CONCURRENCY    = 8;
const PROBE_TIMEOUT_MS     = 10_000;  // "Hi" needs no thinking; a model silent this long is paused
export const SLOW_PAUSE_SEC = 600;    // how long a model that did not answer in time is skipped

let models      = [];   // [{ id, tier }], tier 1 = best
let refreshedAt = null; // ms timestamp of the last completed refresh
let refreshing  = null; // in-flight refresh promise

const storagePath = () => path.join(Config.dataDir, 'models.json');

/**
 * Ranks a model ID: higher version first, then pro > flash > flash-lite.
 * "-preview"/"-exp" only break ties - some current flagships exist only as
 * previews. Returns -Infinity for IDs that are not gemini-<version>-...
 */
export function scoreModelId(id) {
  const match = id.match(/^gemini-(\d+(?:\.\d+)?)-?(pro|flash-lite|flash-8b|flash|nano)?(.*)$/);
  if (!match) return -Infinity;

  let score = parseFloat(match[1]) * 100;
  const variant = match[2] ?? '';
  if (variant === 'pro') score += 30;
  else if (variant === 'flash') score += 20;
  else if (variant) score += 10;

  const tags = match[3] ?? '';
  if (tags.includes('-exp')) score -= 5;
  else if (tags.includes('-preview')) score -= 3;
  return score;
}

/** Cheap name filter before spending a probe call: gemini-* models matching include, not exclude. */
export function isCandidate(id) {
  return id.startsWith('gemini-')
    && (!Config.includeModels || Config.includeModels.test(id))
    && !(Config.excludeModels?.test(id));
}

/** True when the config pins the model list. */
export const isFixed = () => Config.models.length > 0;

/** The discovery filter as stored with the list; a change makes the stored list stale. */
const filterKey = () => `include=${Config.includeModels?.source ?? ''};exclude=${Config.excludeModels?.source ?? ''}`;

/** Models in the order to try them: tier, minus penalties for deprioritized and failing models. */
export function orderedModels() {
  const priority = (m) => -m.tier
    - (Config.deprioritizeModels?.test(m.id) ? DEPRIORITIZE_PENALTY : 0)
    - Cache.getFailRatio(m.id) * ADAPTIVE_FAIL_WEIGHT;
  return [...models].sort((a, b) => priority(b) - priority(a));
}

export function isStale() {
  if (isFixed()) return false;
  return !refreshedAt || Date.now() - refreshedAt > Config.modelsTtlMs;
}

/** Milliseconds since the last completed refresh, Infinity if none. */
export function refreshAgeMs() {
  return refreshedAt ? Date.now() - refreshedAt : Infinity;
}

// --- Persistence ---

export function load() {
  models      = [];
  refreshedAt = null;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(storagePath(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') log(`WARNING: cannot read ${storagePath()} (${e.message}) - starting with no models`);
  }
  const stored = new Map((Array.isArray(raw?.models) ? raw.models : [])
    .filter(m => typeof m?.id === 'string' && typeof m.tier === 'number')
    .map(({ id, tier, ...entry }) => [id, { tier, entry }]));

  if (isFixed()) {
    // Statuses carry over, except "unusable": the list is the user's call.
    models = Config.models.map((id, i) => ({ id, tier: i + 1 }));
    for (const { id } of models) {
      const entry = stored.get(id)?.entry;
      if (entry && entry.status !== 'error') Cache.restore(id, entry);
    }
    log(`Fixed model list from config (discovery off): ${Config.models.join(', ')}`);
    return;
  }

  for (const [id, { tier, entry }] of stored) {
    if (!isCandidate(id)) continue;  // the filter may have changed since
    models.push({ id, tier });
    Cache.restore(id, entry);
  }
  const ts = Date.parse(raw?.refreshed_at ?? '');
  refreshedAt = isNaN(ts) || raw?.filter !== filterKey() ? null : ts;
}

/** Writes the list and current statuses. Never throws. */
export function save() {
  try {
    fs.mkdirSync(Config.dataDir, { recursive: true });
    const snapshot = {
      refreshed_at: refreshedAt ? new Date(refreshedAt).toISOString() : null,
      filter:       isFixed() ? null : filterKey(),
      models: models.map(m => ({ ...m, ...Cache.getEntry(m.id) })),
    };
    const tmp = `${storagePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, storagePath());
  } catch (e) {
    log(`WARNING: cannot write ${storagePath()}: ${e.message}`);
  }
}

// --- Refresh ---

/**
 * Probes one model with a short call and logs the outcome.
 * Returns false only if the model is unusable; quota, silence or 5xx are
 * about availability, not the model type, so such a model stays listed.
 */
async function probe(id) {
  const started = Date.now();
  const result  = await generate(id, 'Hi', PROBE_TIMEOUT_MS);
  const took    = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  const keep = (note) => { log(`  probe ${id}: ${note} (${took})`); return true; };
  const drop = (note) => { log(`  probe ${id}: ${note} - dropped`); return false; };

  switch (result.kind) {
    case 'ok':
      Cache.setOk(id);
      return keep('ok');
    case 'quota':
      Cache.setQuota(id, result.quotaMetric, result.retryAfterSec);
      return keep(`quota ${result.quotaMetric === 'qpd' ? 'per day' : 'per minute'}`);
    case 'timeout':
      Cache.setSlow(id, SLOW_PAUSE_SEC);
      return keep(`${result.message}, paused for ${SLOW_PAUSE_SEC / 60} min`);
    case 'auth':   // the key works (ListModels passed), so this model is not available to it
    case 'gone':
    case 'rejected':
      return drop(`HTTP ${result.status} ${result.message}`);
    case 'blocked':
      return drop(result.reason);
    default:       // network, 5xx
      return keep(`${result.kind} ${result.status ?? ''} ${result.message ?? ''}`.trim());
  }
}

async function runRefresh(reason) {
  const started = Date.now();
  log(`Refreshing model list (${reason})...`);

  const allIds     = await listModelIds();
  const candidates = allIds.filter(isCandidate);
  log(`  ${candidates.length} candidates of ${allIds.length} in catalog: ${candidates.join(', ')}`);

  const usable = [];
  const queue  = [...candidates];
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      if (await probe(id)) usable.push(id);
    }
  }));

  models = usable
    .sort((a, b) => scoreModelId(b) - scoreModelId(a))
    .map((id, i) => ({ id, tier: i + 1 }));
  refreshedAt = Date.now();
  save();

  log(`Model list: ${models.length} usable of ${candidates.length} candidates `
    + `(${allIds.length} in catalog), ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const m of models) log(`  ${m.tier}. ${m.id} [${Cache.getEntry(m.id).status}]`);
  return models;
}

/** Runs a refresh, or joins the one already running. Throws if it fails. No-op for a fixed list. */
export function refresh(reason = 'requested') {
  if (isFixed()) return Promise.resolve(models);
  refreshing ??= runRefresh(reason).finally(() => { refreshing = null; });
  return refreshing;
}

/** Starts a refresh in the background if the list is old; errors are only logged. */
export function refreshIfStale() {
  if (!isStale() || refreshing) return;
  refresh(models.length ? 'list older than TTL or filter changed' : 'no models yet').catch(e => {
    log(`WARNING: model refresh failed: ${e.message}`);
  });
}

/**
 * Makes sure there is something to try: waits for a refresh when the list
 * is empty, otherwise refreshes an old list in the background.
 */
export async function ensureModels() {
  if (models.length === 0) {
    await refresh('no models yet');
  } else {
    refreshIfStale();
  }
  return orderedModels();
}

/** For tests: replaces the list in memory. */
export function setModels(list, at = Date.now()) {
  models      = list.map((m, i) => ({ id: m.id, tier: m.tier ?? i + 1 }));
  refreshedAt = at;
}
