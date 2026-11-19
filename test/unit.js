// test/unit.js — unit tests without API calls or a running server.
// Run: node test/unit.js

import assert from 'node:assert/strict';
import path   from 'node:path';
import { Config, parseConfig, interpolateEnv } from '../src/Config.js';
import * as Cache  from '../src/ModelCache.js';
import { scoreModelId, isCandidate } from '../src/GeminiModels.js';
import * as Models from '../src/GeminiModels.js';
import { formatWait } from '../src/GeminiClient.js';

let passed = 0, failed = 0;
function test(label, fn) {
  try {
    fn();
    console.log(` ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(` ✗ ${label}\n   ${err.message}`);
    failed++;
  }
}

// --- Config ---

console.log('\n--- Config ---');

test('defaults with the key from GEMINI_API_KEY', () => {
  const c = parseConfig({}, { env: { GEMINI_API_KEY: 'k' }, baseDir: '/srv/app' });
  assert.equal(c.apiKey, 'k');
  assert.equal(c.dataDir, path.resolve('/srv/app', 'data'));
  assert.equal(c.modelsTtlMs, 24 * 3_600_000);
  assert.ok(c.excludeModels.test('gemini-3-pro-image'));
  assert.ok(c.includeModels.test('gemini-3-flash-lite'));
  assert.deepEqual(c.models, []);
  assert.equal(c.timeoutMs, 25_000);
  assert.equal(c.modelTimeoutMs, 20_000);
  assert.equal(c.deprioritizeModels, null);
  assert.ok(c.baseUrl.startsWith('https://generativelanguage.googleapis.com/'));
});

test('${ENV} in strings is replaced, $${X} stays literal', () => {
  assert.equal(interpolateEnv('${A}-$${B}', { A: '1' }), '1-${B}');
  const c = parseConfig({ apiKey: '${MY_KEY}' }, { env: { MY_KEY: 'secret' } });
  assert.equal(c.apiKey, 'secret');
});

test('missing env variable names the place', () => {
  assert.throws(() => parseConfig({ apiKey: '${NOPE}' }, { env: {} }), /NOPE.*apiKey/);
});

test('missing key fails with a clear message', () => {
  assert.throws(() => parseConfig({}, { env: {} }), /apiKey/);
});

test('unknown keys and bad values are rejected', () => {
  assert.throws(() => parseConfig({ apiKey: 'k', foo: 1 }, { env: {} }), /Invalid config/);
  assert.throws(() => parseConfig({ apiKey: 'k', modelsTtlHours: -1 }, { env: {} }), /modelsTtlHours/);
  assert.throws(() => parseConfig({ apiKey: 'k', excludeModels: '(' }, { env: {} }), /excludeModels/);
});

test('models list: "models/" prefix stripped, duplicates removed; includeModels "" = no filter', () => {
  const c = parseConfig({ apiKey: 'k', models: ['models/gemini-3-flash', 'gemini-3-flash', 'x'], includeModels: '' }, { env: {} });
  assert.deepEqual(c.models, ['gemini-3-flash', 'x']);
  assert.equal(c.includeModels, null);
});

test('modelTimeoutMs never exceeds timeoutMs', () => {
  const c = parseConfig({ apiKey: 'k', timeoutMs: 10_000, modelTimeoutMs: 60_000 }, { env: {} });
  assert.equal(c.modelTimeoutMs, 10_000);
});

test('absolute dataDir stays, TTL in hours, deprioritize regex', () => {
  const abs = path.resolve('/var/gemini');
  const c = parseConfig({ apiKey: 'k', dataDir: abs, modelsTtlHours: 2, deprioritizeModels: 'pro' }, { env: {} });
  assert.equal(c.dataDir, abs);
  assert.equal(c.modelsTtlMs, 7_200_000);
  assert.ok(c.deprioritizeModels.test('gemini-3-pro'));
});

// --- Model ranking and filter ---

console.log('\n--- Model ranking ---');

Config.use(parseConfig({ apiKey: 'k', deprioritizeModels: 'lite' }, { env: {} }));

test('newer version first, then pro > flash > flash-lite', () => {
  const ids = ['gemini-2.5-pro', 'gemini-3-flash', 'gemini-3-pro', 'gemini-3-flash-lite', 'gemini-2.5-flash'];
  const ranked = [...ids].sort((a, b) => scoreModelId(b) - scoreModelId(a));
  assert.deepEqual(ranked, ['gemini-3-pro', 'gemini-3-flash', 'gemini-3-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash']);
});

test('preview only breaks ties', () => {
  assert.ok(scoreModelId('gemini-3-pro-preview') > scoreModelId('gemini-2.5-pro'));
  assert.ok(scoreModelId('gemini-3-pro') > scoreModelId('gemini-3-pro-preview'));
});

test('candidates (default include "flash"): flash and flash-lite text models only', () => {
  assert.ok(isCandidate('gemini-3-flash'));
  assert.ok(isCandidate('gemini-3.1-flash-lite-preview'));
  assert.ok(isCandidate('gemini-2.5-flash-preview-05-20'));
  assert.ok(!isCandidate('gemini-3-pro'));
  assert.ok(!isCandidate('gemini-4-argon'));
  assert.ok(!isCandidate('gemini-3.5-transcribe'));
  assert.ok(!isCandidate('gemini-2.5-flash-image'));
  assert.ok(!isCandidate('gemini-2.5-flash-native-audio-latest'));
  assert.ok(!isCandidate('gemma-3-27b-it'));
  assert.ok(!isCandidate('gemini-3-pro-image'));
  assert.ok(!isCandidate('gemini-2.5-flash-preview-tts'));
  assert.ok(!isCandidate('gemini-exp-1206'));
});

test('order: tier, deprioritized last, failing models later', () => {
  Models.setModels([{ id: 'gemini-3-flash-lite' }, { id: 'gemini-3-pro' }, { id: 'gemini-3-flash' }]);
  assert.deepEqual(Models.orderedModels().map(m => m.id), ['gemini-3-pro', 'gemini-3-flash', 'gemini-3-flash-lite']);
  Cache.setQuota('gemini-3-pro', 'qpm', 1);
  Cache.countFailure('gemini-3-pro');
  assert.deepEqual(Models.orderedModels().map(m => m.id), ['gemini-3-flash', 'gemini-3-pro', 'gemini-3-flash-lite']);
});

test('stale after TTL', () => {
  Models.setModels([{ id: 'gemini-3-pro' }], Date.now());
  assert.equal(Models.isStale(), false);
  Models.setModels([{ id: 'gemini-3-pro' }], Date.now() - 25 * 3_600_000);
  assert.equal(Models.isStale(), true);
});

// --- ModelCache ---

console.log('\n--- ModelCache ---');

test('unknown by default, ok after success', () => {
  assert.equal(Cache.getEntry('m-new').status, 'unknown');
  Cache.setOk('m-new');
  assert.equal(Cache.getEntry('m-new').status, 'ok');
  assert.equal(Cache.isBlocked('m-new'), false);
});

test('per-minute quota blocks until it expires', () => {
  Cache.setQuota('m-rpm', 'qpm', 30);
  assert.equal(Cache.isBlocked('m-rpm'), true);
  Cache.restore('m-rpm', { ...Cache.getEntry('m-rpm'), retry_after_ts: Date.now() - 1 });
  assert.equal(Cache.isBlocked('m-rpm'), false);
  assert.equal(Cache.getEntry('m-rpm').status, 'unknown');
});

test('per-day quota blocks until midnight UTC', () => {
  Cache.setQuota('m-rpd', 'qpd', 0);
  const midnight = new Date(); midnight.setUTCHours(24, 0, 0, 0);
  assert.equal(Cache.getEntry('m-rpd').retry_after_ts, midnight.getTime());
  assert.equal(Cache.isBlocked('m-rpd'), true);
});

test('error blocks, fail ratio counts today', () => {
  Cache.setOk('m-err');
  Cache.setError('m-err');
  assert.equal(Cache.isBlocked('m-err'), true);
  assert.equal(Cache.getFailRatio('m-err'), 0.5);
  assert.equal(Cache.getFailRatio('m-none'), 0);
});

// --- formatWait ---

console.log('\n--- formatWait ---');

test('seconds, minutes, hours', () => {
  assert.equal(formatWait(0.2), '1 s');
  assert.equal(formatWait(43), '43 s');
  assert.equal(formatWait(61), '2 min');
  assert.equal(formatWait(7200), '2 h');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
