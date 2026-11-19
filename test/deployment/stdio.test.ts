import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { loadConfig } from '../../src/config/Config'
import { FAKE_KEY, type FakeGemini, startFakeGemini } from '../support/FakeGemini'
import { DIST_SERVER, type StdioServer, startStdioServer } from '../support/stdio'


// The built dist/mcp.js as the hub runs it: a process on stdio with a config
// file, against the local fake API. The handshake in two protocol versions,
// the one tool, an answer end to end, data next to the config from any
// working directory, the log on stderr and nothing but JSON-RPC on stdout,
// a restart without discovery, bad input, a config without a key, and the
// config template of the build.


test('the build: mcp.js and the config template, which is valid', () => {
    assert.ok(existsSync(DIST_SERVER))
    const template = join(DIST_SERVER, '..', 'config.example.json')
    assert.ok(existsSync(template))
    assert.equal(loadConfig(template, { GEMINI_API_KEY: 'k' }).apiKey, 'k')
})


test('handshake in 2025-11-25 and 2025-06-18; exactly one tool, ask_gemini(prompt)', async t => {
    const { start } = await setUp(t)
    for (const version of ['2025-11-25', '2025-06-18']) {
        const server = start()
        const answer = await server.initialize(version)
        assert.equal(answer.result?.protocolVersion, version)
        assert.deepEqual(answer.result?.serverInfo, { name: 'mcp-gemini-ask', version: '3.0.0' })
        const tools = (await server.call('tools/list')).result?.tools
        assert.deepEqual(tools.map((tool: { name: string }) => tool.name), ['ask_gemini'])
        assert.deepEqual(tools[0].inputSchema.required, ['prompt'])
        assert.deepEqual(Object.keys(tools[0].inputSchema.properties), ['prompt'])
        assert.equal(tools[0].annotations.openWorldHint, true)
        await server.stop()
    }
})


test('an answer end to end; data next to the config, the log on stderr, stdout only JSON-RPC', async t => {
    const { start, folder, fake } = await setUp(t)
    const server = start()
    await server.initialize()
    const answer = await server.call('tools/call', { name: 'ask_gemini', arguments: { prompt: 'Hello' } })
    assert.deepEqual(answer.result?.content, [{ type: 'text', text: 'gemini-3-flash says: Hello' }])
    assert.ok(!answer.result?.isError)
    await server.stop()

    const stored = JSON.parse(readFileSync(join(folder, 'state', 'models.json'), 'utf8'))
    assert.deepEqual(stored.models.map((model: { id: string }) => model.id), ['gemini-3-flash', 'gemini-2.5-flash'])
    assert.match(server.stderr(), /mcp-gemini-ask 3\.0\.0 started/)
    assert.match(server.stderr(), /probe gemini-3-flash: ok/)
    assert.match(server.stderr(), /Model list: 2 usable of 2 candidates \(3 in catalog\)/)
    assert.match(server.stderr(), /gemini-3-flash: OK/)
    assert.deepEqual(server.noise(), [])
    assert.equal(fake.listCalls, 1)
})


test('a restart uses the stored list: no discovery', async t => {
    const { start, fake } = await setUp(t)
    let server = start()
    await server.initialize()
    await server.call('tools/call', { name: 'ask_gemini', arguments: { prompt: 'One' } })
    await server.stop()

    server = start()
    await server.initialize()
    const answer = await server.call('tools/call', { name: 'ask_gemini', arguments: { prompt: 'Two' } })
    assert.equal(answer.result?.content[0].text, 'gemini-3-flash says: Two')
    assert.match(server.stderr(), /Models: discovered, include flash, 2 stored/)
    await server.stop()
    assert.equal(fake.listCalls, 1)
})


test('bad input: an empty prompt and an unknown tool are errors, the server keeps running', async t => {
    const { start } = await setUp(t)
    const server = start()
    await server.initialize()
    const empty = await server.call('tools/call', { name: 'ask_gemini', arguments: { prompt: '' } })
    assert.ok(empty.error || empty.result?.isError)
    const unknown = await server.call('tools/call', { name: 'list_models', arguments: {} })
    assert.ok(unknown.error || unknown.result?.isError)
    assert.ok((await server.call('ping')).result)
    await server.stop()
})


test('a config without a key: exit code 1 and one line saying what to fix', async t => {
    const { folder } = await setUp(t)
    const path = join(folder, 'no-key.json')
    writeFileSync(path, JSON.stringify({ dataDir: 'state' }))
    const server = startStdioServer(DIST_SERVER, [path], { env: { ...process.env, GEMINI_API_KEY: '' } })
    assert.equal(await server.exited, 1)
    assert.match(server.stderr(), /ERROR: Invalid config: apiKey/)
})


// A fake API, a config in a temporary folder (key from the environment,
// data in "state") and start(), which runs dist/mcp.js from another folder.
async function setUp(t: TestContext): Promise<{ start: () => StdioServer, folder: string, fake: FakeGemini }> {
    const fake = await startFakeGemini({ 'gemini-3-flash': 'ok', 'gemini-2.5-flash': 'ok', 'gemini-3-pro': 'ok' })
    const folder = mkdtempSync(join(tmpdir(), 'gemini-deploy-'))
    const elsewhere = mkdtempSync(join(tmpdir(), 'gemini-cwd-'))
    const servers: StdioServer[] = []
    t.after(async () => {
        await Promise.all(servers.map(server => server.stop()))
        await fake.close()
        rmSync(folder, { recursive: true, force: true })
        rmSync(elsewhere, { recursive: true, force: true })
    })
    const configPath = join(folder, 'config.json')
    writeFileSync(configPath, JSON.stringify({ apiKey: '${FAKE_GEMINI_KEY}', dataDir: 'state', baseUrl: fake.url }))
    const start = () => {
        const server = startStdioServer(DIST_SERVER, [configPath], { cwd: elsewhere, env: { ...process.env, FAKE_GEMINI_KEY: FAKE_KEY } })
        servers.push(server)
        return server
    }
    return { start, folder, fake }
}
