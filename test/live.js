// test/live.js — real round trips against the Gemini API.
// Needs GEMINI_API_KEY. Uses a temporary data directory, so the server runs
// a full model discovery first (one ListModels call plus one short probe
// call per candidate model - real quota). If the answer is "getting ready",
// the call is repeated, like an agent would.
//
// Run: node test/live.js [src|dist]   (default: dist)

import { spawn } from 'node:child_process';
import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is not set - skipping the live test.');
  process.exit(0);
}

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(__dirname, '..', process.argv[2] === 'src' ? 'src' : 'dist', 'mcp.js');
const tmp        = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-ask-live-'));
const configPath = path.join(tmp, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({ apiKey: '${GEMINI_API_KEY}', dataDir: 'data' }));

const child = spawn(process.execPath, [serverPath, configPath], { stdio: ['pipe', 'pipe', 'inherit'] });
const send  = (msg) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

const waiting = new Map();
let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  }
});
const call = (id, method, params) => new Promise((resolve) => { waiting.set(id, resolve); send({ id, method, params }); });

const timer = setTimeout(() => { console.error('Timed out after 180 s'); child.kill(); process.exit(1); }, 180_000);

await call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live', version: '1' } });
send({ method: 'notifications/initialized' });

let res;
for (let attempt = 1; attempt <= 4; attempt++) {
  const started = Date.now();
  res = await call(attempt + 1, 'tools/call', { name: 'ask_gemini', arguments: { prompt: 'Reply with the single word OK.' } });
  const text = res.result?.content?.[0]?.text ?? '';
  console.log(`\n[live] attempt ${attempt}: ${((Date.now() - started) / 1000).toFixed(1)} s, ${res.result?.isError ? 'ERROR' : 'OK'}\n`);
  if (!/getting ready/.test(text)) break;
  await new Promise(r => setTimeout(r, 15_000));
}

clearTimeout(timer);
child.kill();
fs.rmSync(tmp, { recursive: true, force: true });

const result = res.result ?? {};
console.log(`ask_gemini -> ${result.isError ? 'ERROR' : 'OK'}: ${result.content?.[0]?.text ?? JSON.stringify(res.error)}`);
process.exit(result.isError || res.error ? 1 : 0);
