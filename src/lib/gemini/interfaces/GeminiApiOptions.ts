import type { ThinkingLevel } from '../types/ThinkingLevel'


/** How GeminiApi reaches the API. */
export interface GeminiApiOptions {
    apiKey: string
    /** Default https://generativelanguage.googleapis.com/v1beta/ - tests point it to a local fake. */
    baseUrl?: string
    /** Time limit of a generate() call that gives none (default 20 s); ListModels has its own 30 s. */
    timeoutMs?: number
    /** Sent to models of version 3 and newer; older ones and IDs without a version get none. Default: the model's own. */
    thinkingLevel?: ThinkingLevel | null
}
