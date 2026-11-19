/** How GeminiModelList finds, keeps and orders the models. All optional. */
export interface GeminiModelListOptions {
    /** JSON file that keeps the list and the states over restarts; none = memory only. */
    storagePath?: string
    /** A fixed list, best first: used as given, no discovery, no probing, no TTL. */
    models?: string[]
    /** Discovery keeps only IDs matching this (null = all gemini-* models). */
    include?: RegExp | null
    /** Discovery drops IDs matching this. */
    exclude?: RegExp | null
    /** Models matching this are tried last. */
    deprioritize?: RegExp | null
    /** How old a discovered list may get before it is refreshed (default 24 h). */
    ttlMs?: number
    /** Time limit of one probe call (default 10 s). */
    probeTimeoutMs?: number
    /** How long a model that did not answer in time is skipped (default 10 min). */
    slowPauseMs?: number
    /** Where the list says what it does (refresh, probes, the order); default silent. */
    log?: (message: string) => void
}
