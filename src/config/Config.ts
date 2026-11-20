import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { ThinkingLevel } from '../lib/gemini'
import { CONFIG_FILE } from '../Consts'
import type { GeminiAskConfig } from './interfaces/GeminiAskConfig'


// The folder of mcp.js once built (dist/), of this file in the tests.
const SERVER_DIR = dirname(fileURLToPath(import.meta.url))
const PLACEHOLDER = /\$?\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

const ConfigSchema = z.object({
    apiKey: z.string().min(1, 'apiKey is missing - set it in the config or via GEMINI_API_KEY'),
    dataDir: z.string().min(1).default('data'),
    models: z.array(z.string().min(1)).default([]),
    includeModels: z.string().default('flash'),
    excludeModels: z.string().default('image|tts|audio|live|computer-use|robotics|embedding'),
    deprioritizeModels: z.string().default(''),
    modelsTtlHours: z.number().positive().default(24),
    thinkingLevel: z.enum(['', ...Object.values(ThinkingLevel)]).default(''),
    timeoutMs: z.number().int().positive().default(25_000),
    modelTimeoutMs: z.number().int().positive().default(20_000),
    maxPromptChars: z.number().int().positive().default(200_000),
    baseUrl: z.url().default('https://generativelanguage.googleapis.com/v1beta/')
}).strict()


/** Where the config is: the given path (relative to the working directory), else config.json next to mcp.js, else none. */
export function findConfigPath(given?: string): string | undefined {
    if (given) {
        return resolve(given)
    }
    const nextToServer = join(SERVER_DIR, CONFIG_FILE)
    return existsSync(nextToServer) ? nextToServer : undefined
}


// Without a file every key takes its default and the key comes from
// GEMINI_API_KEY. Strings may hold ${NAME} - an environment variable, as the
// hub passes ${safebox.GEMINI_API_KEY} on - and $${NAME} stays a literal
// ${NAME}. A relative dataDir is relative to the config file's folder.
/** Reads and validates the config - an error names the key and what is wrong. */
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): GeminiAskConfig {
    if (path === undefined) {
        return parseConfig({}, env, SERVER_DIR)
    }
    let source: string
    try {
        source = readFileSync(path, 'utf8')
    }
    catch (error) {
        throw new Error(`Unable to read config at ${path}: ${(error as Error).message}`)
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(source)
    }
    catch (error) {
        throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`)
    }
    return parseConfig(parsed, env, dirname(path))
}


/** Validates a parsed config; `baseDir` is where a relative dataDir starts. */
export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv, baseDir: string): GeminiAskConfig {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Config must be a JSON object')
    }
    const input = interpolate(raw, env, 'config') as Record<string, unknown>
    if (input.apiKey === undefined && env.GEMINI_API_KEY) {
        input.apiKey = env.GEMINI_API_KEY
    }
    const result = ConfigSchema.safeParse(input)
    if (!result.success) {
        const issues = result.error.issues.map(issue => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('; ')
        throw new Error(`Invalid config: ${issues}`)
    }
    const config = result.data
    return {
        apiKey: config.apiKey,
        dataDir: resolve(baseDir, config.dataDir),
        models: [...new Set(config.models.map(id => id.replace(/^models\//, '')))],
        includeModels: pattern(config.includeModels, 'includeModels'),
        excludeModels: pattern(config.excludeModels, 'excludeModels'),
        deprioritizeModels: pattern(config.deprioritizeModels, 'deprioritizeModels'),
        modelsTtlMs: config.modelsTtlHours * 3_600_000,
        thinkingLevel: config.thinkingLevel === '' ? null : config.thinkingLevel,
        timeoutMs: config.timeoutMs,
        modelTimeoutMs: Math.min(config.modelTimeoutMs, config.timeoutMs),
        maxPromptChars: config.maxPromptChars,
        baseUrl: config.baseUrl
    }
}


// ${NAME} in every string of the value replaced by the environment variable.
function interpolate(value: unknown, env: NodeJS.ProcessEnv, where: string): unknown {
    if (typeof value === 'string') {
        return value.replace(PLACEHOLDER, (match, name: string) => {
            if (match.startsWith('$$')) {
                return match.slice(1)
            }
            const filled = env[name]
            if (filled === undefined) {
                throw new Error(`Environment variable ${name} is not set (used in ${where})`)
            }
            return filled
        })
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => interpolate(item, env, `${where}[${index}]`))
    }
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolate(item, env, `${where}.${key}`)]))
    }
    return value
}


// A case-insensitive pattern; "" means none.
function pattern(source: string, key: string): RegExp | null {
    if (!source) {
        return null
    }
    try {
        return new RegExp(source, 'i')
    }
    catch (error) {
        throw new Error(`Invalid config: ${key}: ${(error as Error).message}`)
    }
}
