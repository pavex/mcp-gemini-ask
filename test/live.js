// test/live.js — one real round trip against the Gemini API.
// Needs GEMINI_API_KEY. Uses a temporary data directory, so the first call
// runs a full model discovery (one ListModels call plus one short probe
// call per candidate model - real quota).
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

let buffer = '';
const response = new Promise((resolve) => {
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (const line of buffer.split('\n').slice(0, -1)) {
      const msg = JSON.parse(line);
      if (msg.id === 2) resolve(msg);
    }
    buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
  });
});

send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live', version: '1' } } });
send({ method: 'notifications/initialized' });
send({ id: 2, method: 'tools/call', params: { name: 'ask_gemini', arguments: { prompt: 'Reply with the single word OK.' } } });

const timer = setTimeout(() => { console.error('Timed out after 180 s'); child.kill(); process.exit(1); }, 180_000);
const res   = await response;
clearTimeout(timer);
child.kill();
fs.rmSync(tmp, { recursive: true, force: true });

const result = res.result ?? {};
console.log(`\nask_gemini -> ${result.isError ? 'ERROR' : 'OK'}: ${result.content?.[0]?.text ?? JSON.stringify(res.error)}`);
process.exit(result.isError || res.error ? 1 : 0);
