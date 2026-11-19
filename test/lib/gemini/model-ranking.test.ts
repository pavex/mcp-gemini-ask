import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scoreModelId } from '../../../src/lib/gemini'


// The rank of a model ID alone: version, variant, preview as a tie-break.

test('newer version first, then pro > flash > flash-lite', () => {
    const ids = ['gemini-2.5-pro', 'gemini-3-flash', 'gemini-3-pro', 'gemini-3-flash-lite', 'gemini-2.5-flash']
    const ranked = [...ids].sort((a, b) => scoreModelId(b) - scoreModelId(a))
    assert.deepEqual(ranked, ['gemini-3-pro', 'gemini-3-flash', 'gemini-3-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash'])
})


test('preview only breaks ties', () => {
    assert.ok(scoreModelId('gemini-3-pro-preview') > scoreModelId('gemini-2.5-pro'))
    assert.ok(scoreModelId('gemini-3-pro') > scoreModelId('gemini-3-pro-preview'))
})


test('IDs without a version rank last', () => {
    assert.equal(scoreModelId('gemini-flash-latest'), -Infinity)
    assert.equal(scoreModelId('gemini-omni-1.1-flash'), -Infinity)
})
