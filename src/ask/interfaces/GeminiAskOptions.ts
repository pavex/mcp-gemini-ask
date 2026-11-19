/** Time limits of GeminiAsk. */
export interface GeminiAskOptions {
    /** A whole ask(), fallbacks included. */
    timeoutMs: number
    /** One model, at most what is left of timeoutMs. */
    modelTimeoutMs: number
}
