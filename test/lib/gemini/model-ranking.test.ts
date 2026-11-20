import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelVersion, scoreModelId } from '../../../src/lib/gemini'


// The rank of a model ID alone: version, variant, preview as a tie-break;
// and the version read from an ID.

test('newer version first, then pro > flash > flash-lite', () => {
    const ids = ['gemini-2.5-pro', 'gemini-3-flash', 'gemini-3-pro', 'gemini-3-flash-lite', 'gemini-2.5-flash']
    const ranked = [...ids].sort((a, b) => scoreModelId(b) - scoreModelId(a))
    assert.deepEqual(ranked, ['gemini-3-pro', 'gemini-3-flash', 'gemini-3-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flash'])
})


test('preview only breaks ties', () => {
    assert.ok(scoreModelId('gemini-3-pro-preview') > scoreModelId('gemini-2.5-pro'))
    assert.ok(scoreModelId('gemini-3-pro') > scoreModelId('gemini-3-pro-preview'))
})


test('modelVersion: the number after gemini-, null without one', () => {
    assert.deepEqual(['gemini-3.5-flash', 'gemini-4-argon', 'gemini-2.5-flash-lite', 'gemini-3', 'gemini-flash-latest', 'gemma-3-27b'].map(modelVersion),
        [3.5, 4, 2.5, 3, null, null])
})


test('IDs without a version rank last', () => {
    assert.equal(scoreModelId('gemini-flash-latest'), -Infinity)
    assert.equal(scoreModelId('gemini-omni-1.1-flash'), -Infinity)
})
