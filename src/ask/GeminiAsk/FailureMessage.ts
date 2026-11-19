import type { AttemptStats } from '../interfaces/AttemptStats'


/** A wait for the agent: "43 s", "2 min", "6 h". */
export function formatWait(seconds: number): string {
    if (seconds < 60) {
        return `${Math.max(1, Math.ceil(seconds))} s`
    }
    if (seconds < 3_600) {
        return `${Math.ceil(seconds / 60)} min`
    }
    return `${Math.ceil(seconds / 3_600)} h`
}


// The agent sees only this text, so it says what happened in one line and
// what to do: retry when (short waits), not before midnight UTC (daily
// quota), or not at all (blocked, rejected, nothing usable). The details per
// model are in the log.
/** The message to the agent when no model answered. */
export function failureMessage(stats: AttemptStats, timeoutMs: number, now = Date.now()): string {
    if (stats.blocked) {
        return `Gemini refused to answer this prompt (${stats.blocked}). Retrying the same prompt will not help; rephrase it or tell the user.`
    }
    if (stats.perMinute || stats.unavailable || stats.outOfTime) {
        const parts = []
        if (stats.perMinute) {
            parts.push(`${stats.perMinute} over per-minute quota`)
        }
        if (stats.perDay) {
            parts.push(`${stats.perDay} over daily quota`)
        }
        if (stats.unavailable) {
            parts.push(`${stats.unavailable} not responding${stats.detail ? ` (${stats.detail})` : ''}`)
        }
        if (stats.outOfTime) {
            parts.push(`time limit of ${timeoutMs / 1000} s reached`)
        }
        const onlyQuota = !stats.unavailable && !stats.outOfTime
        const wait = onlyQuota ? formatWait(stats.wait ?? 60) : '1 min'
        return `Gemini is temporarily unavailable (${parts.join(', ')}). Try again in about ${wait}; `
            + 'if it still fails after 2-3 attempts, tell the user Gemini is unavailable.'
    }
    if (stats.perDay) {
        const midnight = new Date(now)
        midnight.setUTCHours(24, 0, 0, 0)
        return 'Gemini is unavailable: the daily quota of all models is used up. It resets at midnight UTC '
            + `(in about ${formatWait((midnight.getTime() - now) / 1000)}). Do not retry before then; tell the user.`
    }
    if (stats.rejected) {
        return 'Gemini rejected the request (HTTP 400): the prompt is probably too long or in a form the models do not accept. '
            + 'Retrying it unchanged will not help.'
    }
    return 'No usable Gemini model is available right now (no access, or the models are gone). Retrying will not help; tell the user.'
}
