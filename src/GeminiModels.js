// GeminiModels.js — the list of usable models, kept up to date by the server itself.
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
const PROBE_CONCURRENCY    = 4;

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

/** Cheap name filter before spending a probe call: gemini-* text models only. */
export function isCandidate(id) {
  return id.startsWith('gemini-')
    && scoreModelId(id) > -Infinity
    && !(Config.excludeModels?.test(id));
}

/** Models in the order to try them: tier, minus penalties for deprioritized and failing models. */
export function orderedModels() {
  const priority = (m) => -m.tier
    - (Config.deprioritizeModels?.test(m.id) ? DEPRIORITIZE_PENALTY : 0)
    - Cache.getFailRatio(m.id) * ADAPTIVE_FAIL_WEIGHT;
  return [...models].sort((a, b) => priority(b) - priority(a));
}

export function isStale() {
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
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(storagePath(), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') log(`WARNING: cannot read ${storagePath()} (${e.message}) - starting with no models`);
    return;
  }
  if (!Array.isArray(raw?.models)) return;

  for (const m of raw.models) {
    if (typeof m?.id !== 'string' || typeof m.tier !== 'number') continue;
    models.push({ id: m.id, tier: m.tier });
    const { id, tier, ...entry } = m;
    Cache.restore(id, entry);
  }
  const ts = Date.parse(raw.refreshed_at ?? '');
  refreshedAt = isNaN(ts) ? null : ts;
}

/** Writes the list and current statuses. Never throws. */
export function save() {
  try {
    fs.mkdirSync(Config.dataDir, { recursive: true });
    const snapshot = {
      refreshed_at: refreshedAt ? new Date(refreshedAt).toISOString() : null,
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

/** Probes one model with a short call. Returns false only if the model is unusable. */
async function probe(id) {
  const result = await generate(id, 'Hi');
  switch (result.kind) {
    case 'ok':    Cache.setOk(id); return true;
    case 'quota': Cache.setQuota(id, result.quotaMetric, result.retryAfterSec); return true;
    case 'auth':  // the key works (ListModels passed), so this model is not available to it
    case 'gone':
    case 'rejected':
    case 'blocked': return false;
    default:      return true; // timeout, network, 5xx: availability, not model type
  }
}

async function runRefresh(reason) {
  const started = Date.now();
  log(`Refreshing model list (${reason})...`);

  const allIds     = await listModelIds();
  const candidates = allIds.filter(isCandidate);

  const usable = [];
  const queue  = [...candidates];
  await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      if (await probe(id)) usable.push(id);
      else log(`  ${id}: unusable for text prompts, dropped`);
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

/** Runs a refresh, or joins the one already running. Throws if it fails. */
export function refresh(reason = 'requested') {
  refreshing ??= runRefresh(reason).finally(() => { refreshing = null; });
  return refreshing;
}

/** Starts a refresh in the background if the list is old; errors are only logged. */
export function refreshIfStale() {
  if (!isStale() || refreshing) return;
  refresh(models.length ? 'list older than TTL' : 'no models yet').catch(e => {
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
