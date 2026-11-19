import type { ModelStatus } from '../types/ModelStatus'


/** A model's availability as GeminiModelList keeps and stores it. */
export interface ModelState {
    status: ModelStatus
    /** Until when (ms timestamp) a quota or pause holds. */
    retryAfter: number | null
    /** When the model last answered or failed (ms timestamp). */
    lastChecked: number | null
    /** Today's (UTC) successes and failures, for the order of tries. */
    okCount: number
    failCount: number
    /** The UTC day (YYYY-MM-DD) the counts belong to. */
    countDay: string | null
}
