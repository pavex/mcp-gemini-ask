import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelStates } from '../../../src/lib/gemini/GeminiModelList/ModelStates'
import { ModelStatus, QuotaPeriod } from '../../../src/lib/gemini'


// ModelStates on its own, with a given clock: how long each block holds,
// that it turns back to Unknown, and today's counts.

const NOON = Date.parse('2026-11-19T12:00:00Z')


test('unknown by default, ok after an answer, not blocked', () => {
    const states = new ModelStates()
    assert.equal(states.get('m').status, ModelStatus.Unknown)
    states.ok('m', NOON)
    assert.equal(states.get('m').status, ModelStatus.Ok)
    assert.equal(states.isBlocked('m', NOON), false)
})


test('per-minute quota holds for its seconds, then the model is Unknown again', () => {
    const states = new ModelStates()
    states.quota('m', QuotaPeriod.Minute, 30, NOON)
    assert.equal(states.isBlocked('m', NOON + 29_000), true)
    assert.equal(states.isBlocked('m', NOON + 30_000), false)
    assert.equal(states.get('m').status, ModelStatus.Unknown)
})


test('per-day quota holds until midnight UTC', () => {
    const states = new ModelStates()
    states.quota('m', QuotaPeriod.Day, 0, NOON)
    assert.equal(states.get('m').retryAfter, Date.parse('2026-11-20T00:00:00Z'))
    assert.equal(states.isBlocked('m', Date.parse('2026-11-19T23:59:59Z')), true)
})


test('a slow model is paused, an unusable one blocked until a refresh', () => {
    const states = new ModelStates()
    states.slow('slow', 600_000, NOON)
    states.unusable('gone', NOON)
    assert.equal(states.isBlocked('slow', NOON + 599_000), true)
    assert.equal(states.isBlocked('slow', NOON + 600_000), false)
    assert.equal(states.isBlocked('gone', NOON + 86_400_000), true)
})


test('fail ratio counts today only; a failure keeps the status', () => {
    const states = new ModelStates()
    states.ok('m', NOON)
    states.failure('m', NOON)
    assert.equal(states.get('m').status, ModelStatus.Ok)
    assert.equal(states.failRatio('m', NOON), 0.5)
    assert.equal(states.failRatio('m', NOON + 86_400_000), 0)
    states.ok('m', NOON + 86_400_000)
    assert.deepEqual([states.get('m').okCount, states.get('m').failCount], [1, 0])
})
