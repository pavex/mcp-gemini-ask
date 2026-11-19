import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GeminiApi, GenerateKind, QuotaPeriod } from '../../../src/lib/gemini'
import { FAKE_KEY, startFakeGemini } from '../../support/FakeGemini'


// GeminiApi against the local fake API: the model list, each outcome of
// generateContent as its GenerateKind, the time limit over the whole body
// and a server that is not there.

test('listModelIds: the generateContent models, without "models/"', async t => {
    const fake = await startFakeGemini({ 'gemini-3-flash': 'ok', 'gemini-3-pro': 'ok' })
    t.after(() => fake.close())
    const api = new GeminiApi({ apiKey: FAKE_KEY, baseUrl: fake.url })
    assert.deepEqual(await api.listModelIds(), ['gemini-3-flash', 'gemini-3-pro'])
})


test('listModelIds: a rejected key throws with the status and the reason', async t => {
    const fake = await startFakeGemini({})
    t.after(() => fake.close())
    const api = new GeminiApi({ apiKey: 'wrong', baseUrl: fake.url })
    await assert.rejects(api.listModelIds(), /ListModels HTTP 400 - .*API key not valid/)
})


test('generate: each answer of the API as its kind', async t => {
    const fake = await startFakeGemini({
        ok: 'ok', minute: 'quota_minute', day: 'quota_day', gone: 'gone', rejected: 'rejected',
        forbidden: 'forbidden', busy: 'error503', blocked: 'blocked'
    })
    t.after(() => fake.close())
    const api = new GeminiApi({ apiKey: FAKE_KEY, baseUrl: fake.url })

    assert.deepEqual(await api.generate('ok', 'Hello'), { kind: GenerateKind.Ok, text: 'ok says: Hello' })
    assert.deepEqual(await api.generate('minute', 'x'), { kind: GenerateKind.Quota, period: QuotaPeriod.Minute, retryAfterSec: 30 })
    assert.deepEqual(await api.generate('day', 'x'), { kind: GenerateKind.Quota, period: QuotaPeriod.Day, retryAfterSec: 60 })
    assert.equal((await api.generate('gone', 'x')).kind, GenerateKind.Gone)
    assert.equal((await api.generate('rejected', 'x')).kind, GenerateKind.Rejected)
    assert.equal((await api.generate('forbidden', 'x')).kind, GenerateKind.NoAccess)
    assert.deepEqual(await api.generate('busy', 'x'), { kind: GenerateKind.Unavailable, status: 503, message: 'This model is currently experiencing high demand.' })
    assert.deepEqual(await api.generate('blocked', 'x'), { kind: GenerateKind.Blocked, reason: 'prompt blocked: SAFETY' })
})


test('generate: the time limit covers the body - a stalled answer is a timeout', async t => {
    const fake = await startFakeGemini({ stuck: 'stall' })
    t.after(() => fake.close())
    const api = new GeminiApi({ apiKey: FAKE_KEY, baseUrl: fake.url })
    const started = Date.now()
    const result = await api.generate('stuck', 'x', 300)
    assert.equal(result.kind, GenerateKind.Timeout)
    assert.ok(Date.now() - started < 2_000)
})


test('generate: no server is a network error with its cause, not a throw', async () => {
    const fake = await startFakeGemini({})
    await fake.close()
    const api = new GeminiApi({ apiKey: FAKE_KEY, baseUrl: fake.url })
    const result = await api.generate('any', 'x', 2_000)
    assert.equal(result.kind, GenerateKind.Network)
    assert.match((result as { message: string }).message, /ECONNREFUSED|fetch failed/)
})
