#!/usr/bin/env node
// Real round trips against the Gemini API with the built dist/mcp.js: one
// discovery in a temporary data folder (one ListModels call plus a short
// probe call per candidate - real quota), then one question. When the
// answer is "getting ready", the question is repeated, as an agent would.
// The server's log goes to this terminal.
//
//   GEMINI_API_KEY=... npm run live

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'


const SERVER = resolve(import.meta.dirname, '..', 'dist', 'mcp.js')
const PROMPT = 'Reply with the single word OK.'
const ATTEMPTS = 4
const RETRY_DELAY_MS = 15_000
const LIMIT_MS = 180_000


if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set - nothing to check.')
    process.exit(1)
}

const folder = mkdtempSync(join(tmpdir(), 'gemini-live-'))
const configPath = join(folder, 'config.json')
writeFileSync(configPath, JSON.stringify({ apiKey: '${GEMINI_API_KEY}', dataDir: 'data' }))

const child = spawn(process.execPath, [SERVER, configPath], { stdio: ['pipe', 'pipe', 'inherit'] })
const waiting = new Map()
let buffer = ''
child.stdout.on('data', chunk => {
    buffer += chunk
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) {
            const message = JSON.parse(line)
            waiting.get(message.id)?.(message)
        }
    }
})

let nextId = 1
const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const call = (method, params) => new Promise(resolve => {
    const id = nextId++
    waiting.set(id, resolve)
    send({ id, method, params })
})

const limit = setTimeout(() => {
    console.error(`No result within ${LIMIT_MS / 1000} s`)
    child.kill()
    process.exit(1)
}, LIMIT_MS)

await call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'live-check', version: '1' } })
send({ method: 'notifications/initialized' })

let answer
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const started = Date.now()
    answer = await call('tools/call', { name: 'ask_gemini', arguments: { prompt: PROMPT } })
    console.log(`\n[live] attempt ${attempt}: ${((Date.now() - started) / 1000).toFixed(1)} s, ${answer.result?.isError ? 'ERROR' : 'OK'}\n`)
    if (!/getting ready/.test(answer.result?.content?.[0]?.text ?? '')) {
        break
    }
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
}

clearTimeout(limit)
child.kill()
rmSync(folder, { recursive: true, force: true })

const failed = Boolean(answer.error || answer.result?.isError)
console.log(`ask_gemini -> ${failed ? 'ERROR' : 'OK'}: ${answer.result?.content?.[0]?.text ?? JSON.stringify(answer.error)}`)
process.exit(failed ? 1 : 0)
