/** The validated config (loadConfig()): environment variables filled in, paths absolute, patterns compiled. */
export interface GeminiAskConfig {
    apiKey: string
    /** Where models.json is kept. */
    dataDir: string
    /** A fixed model list, best first; empty = the server finds the models itself. */
    models: string[]
    /** Discovery keeps only matching IDs; null = all gemini-* models. */
    includeModels: RegExp | null
    excludeModels: RegExp | null
    /** Matching models are tried last. */
    deprioritizeModels: RegExp | null
    modelsTtlMs: number
    /** Time limit of a whole ask_gemini call, fallbacks included. */
    timeoutMs: number
    /** Time limit of one model, at most timeoutMs. */
    modelTimeoutMs: number
    maxPromptChars: number
    baseUrl: string
}
