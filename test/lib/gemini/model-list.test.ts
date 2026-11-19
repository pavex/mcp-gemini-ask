import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestContext, test } from 'node:test'
import { GeminiApi, GeminiModelList, type GeminiModelListOptions, GenerateKind, ModelStatus } from '../../../src/lib/gemini'
import { FAKE_KEY, type FakeBehavior, type FakeGemini, startFakeGemini } from '../../support/FakeGemini'


// GeminiModelList against the local fake API: the name filter, what a probe
// keeps and drops, the rank and the order to try, the storage file over a
// restart (and a filter change), the TTL, a fixed list, one refresh at a
// time, and record() for each outcome.


test('isCandidate: gemini-* matching include, not exclude', () => {
    const list = new GeminiModelList(new GeminiApi({ apiKey: FAKE_KEY }), { include: /flash/i, exclude: /image|tts/i })
    assert.ok(list.isCandidate('gemini-3-flash'))
    assert.ok(list.isCandidate('gemini-3.1-flash-lite-preview'))
    assert.ok(!list.isCandidate('gemini-3-pro'))
    assert.ok(!list.isCandidate('gemini-2.5-flash-image'))
    assert.ok(!list.isCandidate('gemma-3-flash'))
})


test('refresh: filters, probes, drops models that refuse text, ranks and saves', async t => {
    const { list, fake, storagePath } = await setUp(t, {
        'gemini-3-pro': 'ok', 'gemini-3-flash': 'ok', 'gemini-2.5-flash': 'quota_day',
        'gemini-3-flash-image': 'ok', 'gemma-3-flash': 'ok',
        'gemini-2.0-flash-gone': 'gone', 'gemini-2.0-flash-closed': 'forbidden', 'gemini-2.0-flash-odd': 'rejected'
    }, { include: /flash/i, exclude: /image/i })

    const models = await list.refresh()
    assert.deepEqual(models.map(model => model.id), ['gemini-3-flash', 'gemini-2.5-flash'])
    assert.equal(list.state('gemini-2.5-flash').status, ModelStatus.QuotaPerDay)
    assert.equal(fake.calls.length, 5)
    const stored = JSON.parse(readFileSync(storagePath, 'utf8'))
    assert.deepEqual(stored.models.map((model: { id: string }) => model.id), ['gemini-3-flash', 'gemini-2.5-flash'])
    assert.ok(stored.refreshedAt)
    assert.equal(stored.models[0].status, 'ok')
})


test('a probe that gets 503 or silence keeps the model but puts it at the back', async t => {
    const { list } = await setUp(t, { 'gemini-9-flash': 'error503', 'gemini-8-flash': 'stall', 'gemini-2-flash': 'ok' }, { probeTimeoutMs: 300 })
    await list.refresh()
    assert.deepEqual(list.ordered().map(model => model.id), ['gemini-2-flash', 'gemini-9-flash', 'gemini-8-flash'])
    assert.equal(list.state('gemini-8-flash').status, ModelStatus.Slow)
    assert.equal(list.isBlocked('gemini-8-flash'), true)
    assert.equal(list.isBlocked('gemini-9-flash'), false)
})


test('deprioritized models are tried last', async t => {
    const { list } = await setUp(t, { 'gemini-3-pro': 'ok', 'gemini-3-flash': 'ok' }, { deprioritize: /pro/i })
    await list.refresh()
    assert.deepEqual(list.ordered().map(model => model.id), ['gemini-3-flash', 'gemini-3-pro'])
})


test('load: the stored list and states come back; no discovery while fresh', async t => {
    const { list, fake, options } = await setUp(t, { 'gemini-3-flash': 'ok', 'gemini-2.5-flash': 'quota_minute' })
    await list.refresh()

    const again = new GeminiModelList(new GeminiApi({ apiKey: FAKE_KEY, baseUrl: fake.url }), options)
    again.load()
    assert.equal(again.size, 2)
    assert.equal(again.isStale(), false)
    assert.equal(again.state('gemini-2.5-flash').status, ModelStatus.QuotaPerMinute)
    await again.ensure()
    assert.equal(fake.listCalls, 1)
})


test('load: a changed include filters the stored list at once and makes it stale', async t => {
    const { list, fake, options } = await setUp(t, { 'gemini-3-pro': 'ok', 'gemini-3-flash': 'ok' }, { include: null })
    await list.refresh()

    const flashOnly = new GeminiModelList(new GeminiApi({ apiKey: FAKE_KEY, baseUrl: fake.url }), { ...options, include: /flash/i })
    flashOnly.load()
    assert.deepEqual(flashOnly.ordered().map(model => model.id), ['gemini-3-flash'])
    assert.equal(flashOnly.isStale(), true)
})


test('isStale: older than the TTL', async t => {
    const { list, storagePath } = await setUp(t, { 'gemini-3-flash': 'ok' }, { ttlMs: 3_600_000 })
    await list.refresh()
    assert.equal(list.isStale(), false)
    assert.equal(list.isStale(Date.now() + 3_600_001), true)
    const stored = JSON.parse(readFileSync(storagePath, 'utf8'))
    stored.refreshedAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
    writeFileSync(storagePath, JSON.stringify(stored))
    list.load()
    assert.equal(list.isStale(), true)
})


test('ensure: waits for the first list, then answers from memory', async t => {
    const { list, fake } = await setUp(t, { 'gemini-3-flash': 'ok' })
    assert.deepEqual((await list.ensure()).map(model => model.id), ['gemini-3-flash'])
    await list.ensure()
    assert.equal(fake.listCalls, 1)
})


test('refresh during a refresh joins it: one ListModels call', async t => {
    const { list, fake } = await setUp(t, { 'gemini-3-flash': 'ok' })
    await Promise.all([list.refresh(), list.refresh(), list.ensure()])
    assert.equal(fake.listCalls, 1)
})


test('a fixed list: used in its order, no discovery, stored "unusable" forgotten', async t => {
    const { fake, storagePath } = await setUp(t, {})
    writeFileSync(storagePath, JSON.stringify({ models: [{ id: 'my-b', tier: 1, status: 'unusable' }, { id: 'my-a', tier: 2, status: 'quota_day', retryAfter: Date.now() + 60_000 }] }))
    const list = new GeminiModelList(new GeminiApi({ apiKey: FAKE_KEY, baseUrl: fake.url }), { storagePath, models: ['my-a', 'models/my-b'] })
    list.load()
    assert.equal(list.fixed, true)
    assert.deepEqual((await list.ensure()).map(model => model.id), ['my-a', 'my-b'])
    assert.equal(list.isBlocked('my-b'), false)
    assert.equal(list.isBlocked('my-a'), true)
    assert.equal(list.isStale(), false)
    await list.refresh()
    assert.equal(fake.listCalls, 0)
})


test('record: each outcome as the model state', () => {
    const list = new GeminiModelList(new GeminiApi({ apiKey: FAKE_KEY }), { slowPauseMs: 60_000 })
    list.record('a', { kind: GenerateKind.Ok, text: 'x' })
    list.record('b', { kind: GenerateKind.Timeout, message: 'no response' })
    list.record('c', { kind: GenerateKind.Gone, status: 404, message: '' })
    list.record('d', { kind: GenerateKind.NoAccess, status: 403, message: '' })
    list.record('e', { kind: GenerateKind.Unavailable, status: 503, message: '' })
    assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(id => list.state(id).status),
        [ModelStatus.Ok, ModelStatus.Slow, ModelStatus.Unusable, ModelStatus.Unusable, ModelStatus.Unknown])
    assert.equal(list.state('e').failCount, 1)
})


// A fake API with these models and a list with its storage in a temporary folder.
async function setUp(t: TestContext, models: Record<string, FakeBehavior>, extra: GeminiModelListOptions = {}):
    Promise<{ list: GeminiModelList, fake: FakeGemini, storagePath: string, options: GeminiModelListOptions }> {
    const fake = await startFakeGemini(models)
    const folder = mkdtempSync(join(tmpdir(), 'gemini-list-'))
    t.after(async () => {
        await fake.close()
        rmSync(folder, { recursive: true, force: true })
    })
    const storagePath = join(folder, 'models.json')
    const options = { storagePath, ...extra }
    return { list: new GeminiModelList(new GeminiApi({ apiKey: FAKE_KEY, baseUrl: fake.url }), options), fake, storagePath, options }
}
