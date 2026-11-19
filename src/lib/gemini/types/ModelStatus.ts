/** What is known about a model's availability (GeminiModelList). */
export enum ModelStatus {
    /** Not called yet, or a pause has run out. */
    Unknown = 'unknown',
    Ok = 'ok',
    /** Skipped until its retry time (Retry-After). */
    QuotaPerMinute = 'quota_minute',
    /** Skipped until midnight UTC. */
    QuotaPerDay = 'quota_day',
    /** Did not answer in time; skipped for a pause. */
    Slow = 'slow',
    /** No access or gone; skipped until the next refresh. */
    Unusable = 'unusable'
}
