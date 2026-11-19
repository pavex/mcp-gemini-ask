import type { ModelState } from '../interfaces/ModelState'
import { ModelStatus } from '../types/ModelStatus'
import { QuotaPeriod } from '../types/QuotaPeriod'


const UNKNOWN: ModelState = Object.freeze({
    status: ModelStatus.Unknown,
    retryAfter: null,
    lastChecked: null,
    okCount: 0,
    failCount: 0,
    countDay: null
})


// A quota or pause holds until retryAfter; the first look after that turns
// the model back to Unknown, so it is tried again. Unusable holds until the
// list is refreshed. The success and failure counts are per UTC day: a bad
// morning does not hold a model back tomorrow.
/** The availability of each model, in memory: part of GeminiModelList. */
export class ModelStates {

    private states = new Map<string, ModelState>()


    /** The state of a model; Unknown when nothing is known. */
    get(id: string): ModelState {
        return this.states.get(id) ?? UNKNOWN
    }


    /** Puts back a stored state as it was. */
    restore(id: string, state: Partial<ModelState>): void {
        this.states.set(id, { ...UNKNOWN, ...state })
    }


    ok(id: string, now = Date.now()): void {
        this.states.set(id, { status: ModelStatus.Ok, retryAfter: null, lastChecked: now, ...this.counted(id, true, now) })
    }


    /** Per-minute quota holds for retryAfterSec, per-day quota until midnight UTC. */
    quota(id: string, period: QuotaPeriod, retryAfterSec: number, now = Date.now()): void {
        const perDay = period === QuotaPeriod.Day
        this.states.set(id, {
            status: perDay ? ModelStatus.QuotaPerDay : ModelStatus.QuotaPerMinute,
            retryAfter: perDay ? nextMidnightUtc(now) : now + Math.max(1, retryAfterSec) * 1000,
            lastChecked: now,
            ...this.counted(id, false, now)
        })
    }


    /** A model that did not answer in time is skipped for pauseMs. */
    slow(id: string, pauseMs: number, now = Date.now()): void {
        this.states.set(id, { status: ModelStatus.Slow, retryAfter: now + pauseMs, lastChecked: now, ...this.counted(id, false, now) })
    }


    /** No access or gone: skipped until the list is refreshed. */
    unusable(id: string, now = Date.now()): void {
        this.states.set(id, { status: ModelStatus.Unusable, retryAfter: null, lastChecked: now, ...this.counted(id, false, now) })
    }


    /** Counts a failure without changing the status (5xx, network, a rejected request). */
    failure(id: string, now = Date.now()): void {
        this.states.set(id, { ...this.get(id), lastChecked: now, ...this.counted(id, false, now) })
    }


    /** Whether the model is to be skipped now; a quota or pause that ran out is reset to Unknown. */
    isBlocked(id: string, now = Date.now()): boolean {
        const state = this.get(id)
        if (state.status === ModelStatus.Unusable) {
            return true
        }
        if (state.retryAfter === null) {
            return false
        }
        if (now < state.retryAfter) {
            return true
        }
        this.states.set(id, { ...state, status: ModelStatus.Unknown, retryAfter: null })
        return false
    }


    /** Today's (UTC) share of failed calls, 0 without calls today. */
    failRatio(id: string, now = Date.now()): number {
        const state = this.get(id)
        const total = state.okCount + state.failCount
        return state.countDay !== utcDay(now) || total === 0 ? 0 : state.failCount / total
    }


    // The counts after one more success or failure, started afresh on a new UTC day.
    private counted(id: string, ok: boolean, now: number): Pick<ModelState, 'okCount' | 'failCount' | 'countDay'> {
        const state = this.get(id)
        const day = utcDay(now)
        const okCount = state.countDay === day ? state.okCount : 0
        const failCount = state.countDay === day ? state.failCount : 0
        return { okCount: okCount + (ok ? 1 : 0), failCount: failCount + (ok ? 0 : 1), countDay: day }
    }
}


function utcDay(now: number): string {
    return new Date(now).toISOString().slice(0, 10)
}


function nextMidnightUtc(now: number): number {
    const midnight = new Date(now)
    midnight.setUTCHours(24, 0, 0, 0)
    return midnight.getTime()
}
