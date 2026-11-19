import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { ApplicationContainer } from '../../src/ApplicationContainer'
import { formatWait } from '../../src/ask/GeminiAsk/FailureMessage'
import type { AskResult } from '../../src/ask/types/AskResult'
import { parseConfig } from '../../src/config/Config'
import { Logger } from '../../src/log/Logger'
import { FAKE_KEY, type FakeBehavior, type FakeGemini, startFakeGemini } from '../support/FakeGemini'


// GeminiAsk through the container, against the local fake API, without a
// process: the first answer waits for discovery, fallback on quota, 503 and
// a stalled answer, skipping blocked models without a call, the message for
// each kind of failure, the time limit, the refresh when every model is
// gone, and a fixed list. Time limits are short: 5.5 s a call, 2 s a model.


test('the first ask waits for discovery and answers from the best model', async t => {
    const { ask, fake } = await setUp(t, { 'gemini-3-pro': 'ok', 'gemini-3-flash': 'ok', 'gemini-2.0-flash': 'gone' })
    assert.deepEqual(await ask('Hello'), { ok: true, text: 'gemini-3-pro says: Hello' })
    assert.equal(fake.listCalls, 1)
})


test('fallback: quota, 503 and a stalled answer move on; a model on quota is skipped without a call', async t => {
    const { ask, fake } = await setUp(t, { 'gemini-3-pro': 'ok', 'gemini-3-flash': 'ok', 'gemini-2.5-flash': 'ok' })
    await ask('warm up')
    fake.models['gemini-3-pro'] = 'quota_minute'
    fake.models['gemini-3-flash'] = 'stall'
    fake.models['gemini-2.5-flash'] = 'ok'
    const started = Date.now()
    assert.deepEqual(await ask('Second'), { ok: true, text: 'gemini-2.5-flash says: Second' })
    assert.ok(Date.now() - started < 3_500)

    const calls = fake.calls.length
    assert.deepEqual(await ask('Third'), { ok: true, text: 'gemini-2.5-flash says: Third' })
    assert.deepEqual(fake.calls.slice(calls).map(call => call.id), ['gemini-2.5-flash'])
})


test('every model on quota or paused: a retry hint with the shortest wait', async t => {
    const { ask, fake } = await setUp(t, { 'gemini-3-pro': 'ok', 'gemini-3-flash': 'ok' })
    await ask('warm up')
    fake.models['gemini-3-pro'] = 'quota_minute'
    fake.models['gemini-3-flash'] = 'quota_day'
    const result = await ask('x')
    assert.equal(result.ok, false)
    assert.match((result as { message: string }).message,
        /^Gemini is temporarily unavailable \(1 over per-minute quota, 1 over daily quota\)\. Try again in about (29|30) s;/)
})


test('only daily quota: do not retry before midnight UTC', async t => {
    const { ask } = await setUp(t, { 'gemini-3-flash': 'quota_day' })
    const result = await ask('x')
    assert.match((result as { message: string }).message, /daily quota of all models is used up.*Do not retry before then/)
})


test('a blocked prompt ends the round: rephrase, no retry', async t => {
    const { ask, fake } = await setUp(t, { 'gemini-3-pro': 'ok', 'gemini-3-flash': 'ok' })
    await ask('warm up')
    fake.models['gemini-3-pro'] = 'blocked'
    const result = await ask('x')
    assert.match((result as { message: string }).message, /refused to answer this prompt \(prompt blocked: SAFETY\)/)
    assert.deepEqual(fake.calls.filter(call => call.prompt === 'x').map(call => call.id), ['gemini-3-pro'])
})


test('every model rejects the request (400): the prompt is the problem', async t => {
    const { ask, fake } = await setUp(t, { 'gemini-3-flash': 'ok' })
    await ask('warm up')
    fake.models['gemini-3-flash'] = 'rejected'
    assert.match((await ask('x') as { message: string }).message, /rejected the request \(HTTP 400\)/)
})


test('the whole call ends within timeoutMs even when every model hangs', async t => {
    const { ask, fake } = await setUp(t, { 'gemini-3-pro': 'ok', 'gemini-3-flash': 'ok', 'gemini-2.5-flash': 'ok' })
    await ask('warm up')
    for (const id of Object.keys(fake.models)) {
        fake.models[id] = 'stall'
    }
    const started = Date.now()
    const result = await ask('x')
    assert.ok(Date.now() - started < 5_700)
    assert.match((result as { message: string }).message, /not responding.*time limit of 5\.5 s reached/)
})


test('a slow first discovery: "getting ready" within the time limit', async t => {
    const { ask, fake } = await setUp(t, { 'gemini-3-flash': 'ok' })
    fake.listDelayMs = 4_000
    const started = Date.now()
    assert.match((await ask('x') as { message: string }).message, /getting ready/)
    assert.ok(Date.now() - started < 3_500)
})


test('every model gone: the list is refreshed and a new model answers', async t => {
    const { ask, fake, folder, restart } = await setUp(t, { 'gemini-3-flash': 'ok' })
    await ask('warm up')
    // An hour-old list: within the TTL, but old enough to refresh again.
    const path = join(folder, 'models.json')
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), refreshedAt: new Date(Date.now() - 3_600_000).toISOString() }))
    const askAgain = restart()
    fake.models = { 'gemini-4-flash': 'ok' }
    assert.deepEqual(await askAgain('New'), { ok: true, text: 'gemini-4-flash says: New' })
    assert.equal(fake.listCalls, 2)
})


test('a fixed list: its order, no discovery, fallback inside it', async t => {
    const { ask, fake } = await setUp(t, { 'my-a': 'quota_minute', 'my-b': 'ok', 'gemini-3-flash': 'ok' }, { models: ['my-a', 'my-b'] })
    assert.deepEqual(await ask('Fixed'), { ok: true, text: 'my-b says: Fixed' })
    assert.equal(fake.listCalls, 0)
})


test('formatWait: seconds, minutes, hours', () => {
    assert.deepEqual([formatWait(0.2), formatWait(43), formatWait(61), formatWait(7_200)], ['1 s', '43 s', '2 min', '2 h'])
})


type Ask = (prompt: string) => Promise<AskResult>


// A fake API with these models and a quiet container whose data is in a
// temporary folder; restart() is a new container on the same folder.
async function setUp(t: TestContext, models: Record<string, FakeBehavior>, extra: Record<string, unknown> = {}):
    Promise<{ ask: Ask, fake: FakeGemini, folder: string, restart: () => Ask }> {
    const fake = await startFakeGemini(models)
    const folder = mkdtempSync(join(tmpdir(), 'gemini-ask-'))
    t.after(async () => {
        await fake.close()
        rmSync(folder, { recursive: true, force: true })
    })
    const config = parseConfig({
        apiKey: FAKE_KEY, dataDir: folder, baseUrl: fake.url, includeModels: '', timeoutMs: 5_500, modelTimeoutMs: 2_000, ...extra
    }, {}, folder)
    const restart = (): Ask => {
        const container = new ApplicationContainer(config, new Logger(false))
        container.getModelList().load()
        return prompt => container.getGeminiAsk().ask(prompt)
    }
    return { ask: restart(), fake, folder, restart }
}
