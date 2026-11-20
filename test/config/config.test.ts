import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { findConfigPath, loadConfig, parseConfig } from '../../src/config/Config'


// The config: defaults, ${NAME} from the environment, errors that name the
// key, the paths relative to the config file and where the file is found.

const BASE = resolve('/srv/gemini')


test('defaults, with the key from GEMINI_API_KEY', () => {
    const config = parseConfig({}, { GEMINI_API_KEY: 'k' }, BASE)
    assert.equal(config.apiKey, 'k')
    assert.equal(config.dataDir, join(BASE, 'data'))
    assert.deepEqual(config.models, [])
    assert.ok(config.includeModels?.test('gemini-3-flash-lite'))
    assert.ok(config.excludeModels?.test('gemini-3-pro-image'))
    assert.equal(config.deprioritizeModels, null)
    assert.equal(config.modelsTtlMs, 24 * 3_600_000)
    assert.equal(config.thinkingLevel, null)
    assert.deepEqual([config.timeoutMs, config.modelTimeoutMs, config.maxPromptChars], [25_000, 20_000, 200_000])
    assert.match(config.baseUrl, /^https:\/\/generativelanguage\.googleapis\.com\//)
})


test('${NAME} is filled from the environment, $${NAME} stays literal', () => {
    const config = parseConfig({ apiKey: '${MY_KEY}', dataDir: 'd-$${X}' }, { MY_KEY: 'secret' }, BASE)
    assert.equal(config.apiKey, 'secret')
    assert.equal(config.dataDir, join(BASE, 'd-${X}'))
})


test('errors name the key', () => {
    assert.throws(() => parseConfig({ apiKey: '${NOPE}' }, {}, BASE), /NOPE is not set \(used in config\.apiKey\)/)
    assert.throws(() => parseConfig({}, {}, BASE), /apiKey/)
    assert.throws(() => parseConfig({ apiKey: 'k', fetchTimeoutMs: 1 }, {}, BASE), /Invalid config.*fetchTimeoutMs/)
    assert.throws(() => parseConfig({ apiKey: 'k', modelsTtlHours: -1 }, {}, BASE), /modelsTtlHours/)
    assert.throws(() => parseConfig({ apiKey: 'k', excludeModels: '(' }, {}, BASE), /excludeModels/)
    assert.throws(() => parseConfig([], {}, BASE), /JSON object/)
    assert.throws(() => parseConfig({ apiKey: 'k', thinkingLevel: 'extreme' }, {}, BASE), /thinkingLevel/)
    assert.equal(parseConfig({ apiKey: 'k', thinkingLevel: 'low' }, {}, BASE).thinkingLevel, 'low')
})


test('models: "models/" stripped, duplicates dropped; "" turns a pattern off; modelTimeoutMs within timeoutMs', () => {
    const config = parseConfig({ apiKey: 'k', models: ['models/a', 'a', 'b'], includeModels: '', timeoutMs: 10_000, modelTimeoutMs: 60_000 }, {}, BASE)
    assert.deepEqual(config.models, ['a', 'b'])
    assert.equal(config.includeModels, null)
    assert.equal(config.modelTimeoutMs, 10_000)
})


test('loadConfig: dataDir relative to the config file; findConfigPath resolves a given path', t => {
    const folder = mkdtempSync(join(tmpdir(), 'gemini-config-'))
    t.after(() => rmSync(folder, { recursive: true, force: true }))
    const path = join(folder, 'config.json')
    writeFileSync(path, JSON.stringify({ apiKey: 'k', dataDir: 'state' }))
    assert.equal(loadConfig(path, {}).dataDir, join(folder, 'state'))
    assert.equal(findConfigPath(path), path)
    writeFileSync(path, '{ broken')
    assert.throws(() => loadConfig(path, {}), /Invalid JSON/)
    assert.throws(() => loadConfig(join(folder, 'missing.json'), {}), /Unable to read config/)
})
