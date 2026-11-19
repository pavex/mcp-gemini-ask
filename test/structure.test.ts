import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix, relative, resolve } from 'node:path'
import { test } from 'node:test'


// Guards the layout that a wrong import would break silently: lib/ knows
// nothing of the server, only the application talks MCP, and the build
// makes only dist/ from src/main.ts. Reads the files, runs nothing.

const ROOT = resolve(import.meta.dirname, '..')
const SRC = join(ROOT, 'src')


test('lib/ knows nothing of the server: it imports only from lib/', () => {
    const wrong = imports()
        .filter(({ file }) => file.startsWith('lib/'))
        .flatMap(({ file, targets }) => targets.filter(target => !target.startsWith('lib/')).map(target => `${file} -> ${target}`))
    assert.deepEqual(wrong, [])
})


test('the server uses lib/gemini through its index only', () => {
    const wrong = imports()
        .filter(({ file }) => !file.startsWith('lib/'))
        .flatMap(({ file, targets }) => targets.filter(target => target.startsWith('lib/gemini/')).map(target => `${file} -> ${target}`))
    assert.deepEqual(wrong, [])
})


test('only Application.ts and tools/ know the MCP SDK; lib/ has no packages but node:', () => {
    const sdk = sources().filter(file => /from '@modelcontextprotocol\//.test(read(file))).map(toPosix).sort()
    assert.deepEqual(sdk, ['Application.ts', 'tools/AskGeminiTool.ts'])
    const packages = sources().filter(file => toPosix(file).startsWith('lib/') && /from '(?!\.|node:)/.test(read(file)))
    assert.deepEqual(packages, [])
})


test('the build makes dist/mcp.js from src/main.ts; the tests run from test/ directly', () => {
    const build = readFileSync(join(ROOT, 'esbuild.config.mjs'), 'utf8')
    assert.doesNotMatch(build, /dist-test|\.test\.|'test\//)
    assert.match(build, /entryPoints: \['src\/main\.ts'\]/)
    assert.match(build, /outfile: 'dist\/mcp\.js'/)
})


function sources(): string[] {
    return (readdirSync(SRC, { recursive: true }) as string[]).filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'))
}


function read(file: string): string {
    return readFileSync(join(SRC, file), 'utf8')
}


// Every source file with the files it imports, as paths relative to src/.
function imports(): { file: string, targets: string[] }[] {
    return sources().map(file => {
        const targets = [...read(file).matchAll(/from '(\.{1,2}\/[^']+)'/g)]
            .map(match => toPosix(relative(SRC, resolve(SRC, dirname(file), match[1]))))
        return { file: toPosix(file), targets }
    })
}


function toPosix(path: string): string {
    return path.split(/[\\/]/).join(posix.sep)
}
