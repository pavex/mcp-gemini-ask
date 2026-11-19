import { build } from 'esbuild'
import { copyFile } from 'node:fs/promises'


// Everything imported is bundled - the MCP SDK and zod too - so mcp.js needs
// nothing but Node.js built-ins. The banner gives the bundled CommonJS parts
// a require(). dist/ is what gets deployed: mcp.js and the config template
// next to it. The tests run from the TypeScript sources directly
// (test/support/register.mjs).
await build({
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    legalComments: 'none',
    logLevel: 'warning',
    banner: { js: 'import { createRequire } from \'node:module\'; const require = createRequire(import.meta.url);' },
    entryPoints: ['src/main.ts'],
    outfile: 'dist/mcp.js'
})
await copyFile('config.example.json', 'dist/config.example.json')

console.log('Built dist/ (mcp.js, config.example.json)')
