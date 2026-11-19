// Config.js — server configuration, loaded from a JSON file.
//
// argv[2] is the path to the config file (absolute, or relative to the
// current working directory). Without it, config.json in the project root is
// used if it exists; otherwise defaults apply and the API key comes from the
// GEMINI_API_KEY environment variable.
//
// Strings may reference environment variables as ${NAME}; $${NAME} stays a
// literal ${NAME}. A relative dataDir is resolved against the directory of
// the config file (the project root when there is no file).

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const SERVER_NAME    = 'mcp-gemini-ask';
export const SERVER_VERSION = '3.0.0';

const ConfigSchema = z.object({
  apiKey:          z.string().min(1, 'apiKey is missing - set it in the config or via GEMINI_API_KEY'),
  dataDir:         z.string().min(1).default('data'),
  modelsTtlHours:  z.number().positive().default(24),
  timeoutMs:       z.number().int().positive().default(25_000),   // whole ask_gemini call (the hub gives up at 30 s)
  modelTimeoutMs:  z.number().int().positive().default(20_000),   // one model; a silent model is paused afterwards
  maxPromptChars:  z.number().int().positive().default(200_000),
  models:          z.array(z.string().min(1)).default([]),        // fixed list, in order; turns discovery off
  includeModels:   z.string().default('flash'),                   // discovery keeps only matching IDs ("" = all)
  excludeModels:   z.string().default('image|tts|audio|live|computer-use|robotics|embedding'),
  deprioritizeModels: z.string().default(''),
  baseUrl:         z.url().default('https://generativelanguage.googleapis.com/v1beta/'),
}).strict();

/** Replaces ${NAME} with env value in every string; $${NAME} stays literal ${NAME}. */
export function interpolateEnv(value, env, where = 'config') {
  if (typeof value === 'string') {
    return value.replace(/\$?\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
      if (match.startsWith('$$')) return match.slice(1);
      if (env[name] === undefined) throw new Error(`Environment variable ${name} is not set (used in ${where}).`);
      return env[name];
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolateEnv(v, env, `${where}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolateEnv(v, env, `${where}.${k}`)]));
  }
  return value;
}

function toRegex(source, key) {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch (e) {
    throw new Error(`Invalid config: ${key}: ${e.message}`);
  }
}

/**
 * Validates raw config (already parsed JSON) and returns the runtime config.
 * `baseDir` resolves a relative dataDir.
 */
export function parseConfig(raw, { env = process.env, baseDir = ROOT_DIR } = {}) {
  const input = interpolateEnv(raw ?? {}, env);
  if (input.apiKey === undefined && env.GEMINI_API_KEY) input.apiKey = env.GEMINI_API_KEY;

  const result = ConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map(i => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ');
    throw new Error(`Invalid config: ${issues}`);
  }

  const c = result.data;
  return {
    apiKey:             c.apiKey,
    dataDir:            path.resolve(baseDir, c.dataDir),
    modelsTtlMs:        c.modelsTtlHours * 3_600_000,
    timeoutMs:          c.timeoutMs,
    modelTimeoutMs:     Math.min(c.modelTimeoutMs, c.timeoutMs),
    maxPromptChars:     c.maxPromptChars,
    models:             [...new Set(c.models.map(id => id.replace(/^models\//, '')))],
    includeModels:      toRegex(c.includeModels, 'includeModels'),
    excludeModels:      toRegex(c.excludeModels, 'excludeModels'),
    deprioritizeModels: toRegex(c.deprioritizeModels, 'deprioritizeModels'),
    baseUrl:            c.baseUrl.endsWith('/') ? c.baseUrl : `${c.baseUrl}/`,
  };
}

/** Reads and validates the config file named by argv[2] (see top of file). */
export function loadConfig(arg = process.argv[2], env = process.env) {
  const file = arg
    ? path.resolve(process.cwd(), arg)
    : path.join(ROOT_DIR, 'config.json');

  if (!arg && !fs.existsSync(file)) {
    return parseConfig({}, { env, baseDir: ROOT_DIR });
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read config ${file}: ${e.message}`);
  }
  return parseConfig(raw, { env, baseDir: path.dirname(file) });
}

/**
 * The active configuration. Filled once by mcp.js (Config.use(loadConfig()))
 * before anything else runs; modules read it at call time, never at import.
 */
export const Config = {
  use(config) {
    Object.assign(this, config);
    return this;
  },
};
