// test/integration.js — runs the server over stdio against a local fake
// Gemini API (test/FakeGemini.js). No API key, no network.
//
// Usage: node test/integration.js [src|dist]   (default: dist)

import { spawn }  from 'node:child_process';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startFakeGemini } from './FakeGemini.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const variant    = process.argv[2] === 'src' ? 'src' : 'dist';
const serverPath = path.resolve(__dirname, '..', variant, 'mcp.js');
const VERBOSE    = process.env.VERBOSE === '1';

let passed = 0, failed = 0;
async function test(label, fn) {
  try {
    await fn();
    console.log(` ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(` ✗ ${label}\n   ${err.message}`);
    failed++;
  }
}

function startServer(configPath) {
  const child = spawn(process.execPath, [serverPath, configPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buffer = '', stderr = '', nextId = 1;

  child.stdout.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  child.stderr.on('data', d => {
    stderr += d;
    if (VERBOSE) process.stderr.write(`   [server] ${d}`);
  });

  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 15_000);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params = {}) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const stop = () => new Promise(resolve => { child.once('exit', resolve); child.stdin.end(); child.kill(); });

  return { call, notify, stop, stderr: () => stderr, child };
}

async function initialize(server) {
  const res = await server.call('initialize', {
    protocolVersion: '2025-11-25',
    capabilities:    {},
    clientInfo:      { name: 'integration-test', version: '1.0' },
  });
  server.notify('notifications/initialized');
  return res;
}

const ask = (server, prompt) => server.call('tools/call', { name: 'ask_gemini', arguments: { prompt } });

// --- Setup ---

console.log(`\nIntegration tests (${variant}/mcp.js)\n`);

const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-ask-'));
const fake = await startFakeGemini({
  'gemini-3-pro':          'ok',
  'gemini-3-flash':        'ok',
  'gemini-2.5-flash':      'ok',
  'gemini-3-pro-image':    'ok',       // excluded by name
  'gemma-3-27b':           'ok',       // not gemini-*
  'gemini-2.0-flash-gone': 'gone',     // dropped by the probe
});

const configPath = path.join(tmp, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  apiKey:         '${FAKE_GEMINI_KEY}',
  dataDir:        'data',
  baseUrl:        fake.url,
  includeModels:  '',        // all gemini-* text models; the default "flash" is tested below
  timeoutMs:      5500,
  modelTimeoutMs: 2000,
}));
process.env.FAKE_GEMINI_KEY = 'test-key';   // inherited by the server, read via ${...}

const modelsFile = path.join(tmp, 'data', 'models.json');
let server = startServer(configPath);

// --- Tests ---

await test('initialize: server info and tools capability', async () => {
  const res = await initialize(server);
  assert.equal(res.result.serverInfo.name, 'mcp-gemini-ask');
  assert.equal(res.result.serverInfo.version, '3.0.0');
  assert.ok(res.result.capabilities.tools);
  assert.equal(res.result.protocolVersion, '2025-11-25');
});

await test('tools/list: exactly one tool, ask_gemini(prompt), with annotations', async () => {
  const res   = await server.call('tools/list');
  const tools = res.result.tools;
  assert.deepEqual(tools.map(t => t.name), ['ask_gemini']);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ['prompt']);
  assert.deepEqual(tools[0].inputSchema.required, ['prompt']);
  assert.equal(tools[0].annotations.openWorldHint, true);
});

await test('first ask with no stored models: discovers, then answers from the best model', async () => {
  const res = await ask(server, 'Hello');
  assert.ok(!res.result.isError, res.result.content?.[0]?.text);
  assert.equal(res.result.content[0].text, 'gemini-3-pro says: Hello');
});

await test('models.json: ranked list without excluded and unusable models', async () => {
  const stored = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  assert.deepEqual(stored.models.map(m => m.id), ['gemini-3-pro', 'gemini-3-flash', 'gemini-2.5-flash']);
  assert.ok(stored.refreshed_at);
  assert.equal(stored.models[0].status, 'ok');
});

await test('fallback: per-minute quota on the best model -> next model answers', async () => {
  fake.models['gemini-3-pro'] = 'quota_rpm';
  const res = await ask(server, 'Second');
  assert.ok(!res.result.isError, res.result.content?.[0]?.text);
  assert.equal(res.result.content[0].text, 'gemini-3-flash says: Second');
});

await test('model on quota is skipped without a call', async () => {
  const before = fake.calls.filter(c => c.id === 'gemini-3-pro').length;
  await ask(server, 'Third');
  assert.equal(fake.calls.filter(c => c.id === 'gemini-3-pro').length, before);
});

await test('fallback: a model that never finishes its answer times out, next model answers', async () => {
  fake.models['gemini-3-flash'] = 'stall';
  const started = Date.now();
  const res = await ask(server, 'Fourth');
  assert.equal(res.result.content[0].text, 'gemini-2.5-flash says: Fourth');
  assert.ok(Date.now() - started < 3500, `took ${Date.now() - started} ms`);
});

await test('a model that timed out is paused: skipped without a call', async () => {
  const before = fake.calls.filter(c => c.id === 'gemini-3-flash').length;
  const res = await ask(server, 'Paused');
  assert.equal(res.result.content[0].text, 'gemini-2.5-flash says: Paused');
  assert.equal(fake.calls.filter(c => c.id === 'gemini-3-flash').length, before);
});

await test('all models on quota or paused: isError with a retry hint', async () => {
  fake.models['gemini-2.5-flash'] = 'quota_rpd';
  const res = await ask(server, 'Fifth');
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /temporarily unavailable.*not responding.*Try again in about/s);
});

await test('empty prompt: validation error', async () => {
  const res = await ask(server, '');
  assert.ok(res.error || res.result.isError);
});

await test('unknown tool: error', async () => {
  const res = await server.call('tools/call', { name: 'list_models', arguments: {} });
  assert.ok(res.error || res.result.isError);
});

await server.stop();

await test('restart: stored list and statuses are reused, no discovery, blocked models not called', async () => {
  for (const id of Object.keys(fake.models)) fake.models[id] = 'ok';
  const listCalls = fake.listCalls;
  const calls     = fake.calls.length;
  server = startServer(configPath);
  await initialize(server);
  const res = await ask(server, 'Again');
  // per-minute quota, pause and daily quota were all stored
  assert.equal(res.result.isError, true);
  assert.equal(fake.listCalls, listCalls);
  assert.equal(fake.calls.length, calls);
});

await test('every model gone: list is refreshed and a new model answers', async () => {
  await server.stop();
  // stored list is old enough to allow a refresh, but within TTL
  const stored = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  stored.refreshed_at = new Date(Date.now() - 3_600_000).toISOString();
  for (const m of stored.models) Object.assign(m, { status: 'unknown', retry_after_ts: null });
  fs.writeFileSync(modelsFile, JSON.stringify(stored));
  fake.models = { 'gemini-4-flash': 'ok' };

  server = startServer(configPath);
  await initialize(server);
  const res = await ask(server, 'New');
  assert.ok(!res.result.isError, res.result.content?.[0]?.text);
  assert.equal(res.result.content[0].text, 'gemini-4-flash says: New');
});

await test('list older than TTL: refreshed in the background at startup', async () => {
  await server.stop();
  const stored = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  stored.refreshed_at = new Date(Date.now() - 25 * 3_600_000).toISOString();
  fs.writeFileSync(modelsFile, JSON.stringify(stored));
  fake.models = { 'gemini-4-flash': 'ok', 'gemini-4-pro': 'ok' };

  server = startServer(configPath);
  await initialize(server);
  for (let i = 0; i < 50 && !server.stderr().includes('Model list:'); i++) await new Promise(r => setTimeout(r, 100));
  const res = await ask(server, 'Fresh');
  assert.equal(res.result.content[0].text, 'gemini-4-pro says: Fresh');
});

await test('logs go to stderr: probes, model list and per-model outcome', async () => {
  assert.match(server.stderr(), /probe gemini-4-pro: ok/);
  assert.match(server.stderr(), /Model list: 2 usable/);
  assert.match(server.stderr(), /gemini-4-pro: OK/);
});

await test('time limit: the whole call ends within timeoutMs even if models hang', async () => {
  fake.models['gemini-4-pro']   = 'stall';
  fake.models['gemini-4-flash'] = 'stall';
  const started = Date.now();
  const res = await ask(server, 'Hang');
  const took = Date.now() - started;
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /temporarily unavailable.*not responding/s);
  assert.ok(took < 5700, `took ${took} ms`);
});

await server.stop();

await test('default includeModels "flash": a filter change shrinks the stored list and triggers a refresh', async () => {
  fake.models = {
    'gemini-4-pro': 'ok', 'gemini-4-flash': 'ok', 'gemini-4-flash-lite': 'ok',
    'gemini-4-flash-image': 'ok', 'gemini-4-argon': 'ok',
  };
  const flashConfig = path.join(tmp, 'flash.json');
  fs.writeFileSync(flashConfig, JSON.stringify({ apiKey: 'test-key', dataDir: 'data', baseUrl: fake.url }));
  server = startServer(flashConfig);
  await initialize(server);
  for (let i = 0; i < 50 && !server.stderr().includes('Model list:'); i++) await new Promise(r => setTimeout(r, 100));
  const stored = JSON.parse(fs.readFileSync(modelsFile, 'utf8'));
  assert.deepEqual(stored.models.map(m => m.id), ['gemini-4-flash', 'gemini-4-flash-lite']);
  const res = await ask(server, 'Flash');
  assert.match(res.result.content[0].text, /^gemini-4-flash(-lite)? says: Flash$/);  // 4-flash failed earlier today, so may go second
  await server.stop();
});

await test('fixed models list: used in its order, no discovery, fallback still works', async () => {
  fake.models = { 'my-model-a': 'quota_rpm', 'my-model-b': 'ok', 'gemini-4-flash': 'ok' };
  const fixedConfig = path.join(tmp, 'fixed.json');
  fs.writeFileSync(fixedConfig, JSON.stringify({
    apiKey: 'test-key', dataDir: 'fixed-data', baseUrl: fake.url, models: ['my-model-a', 'models/my-model-b'],
  }));
  const listCalls = fake.listCalls;
  server = startServer(fixedConfig);
  await initialize(server);
  const res = await ask(server, 'Fixed');
  assert.equal(res.result.content[0].text, 'my-model-b says: Fixed');
  assert.equal(fake.listCalls, listCalls);
  assert.match(server.stderr(), /Fixed model list from config/);
  await server.stop();
});

await test('missing API key: exits with an error', async () => {
  const bad = path.join(tmp, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ dataDir: 'data' }));
  const child = spawn(process.execPath, [serverPath, bad], { env: { ...process.env, GEMINI_API_KEY: '' } });
  let err = '';
  child.stderr.on('data', d => err += d);
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 1);
  assert.match(err, /apiKey/);
});

await fake.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
