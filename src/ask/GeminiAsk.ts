import { type GeminiApi, type GeminiModelList, GenerateKind, type ListedModel, ModelStatus, QuotaPeriod } from '../lib/gemini'
import type { Logger } from '../log/Logger'
import { failureMessage, formatWait } from './GeminiAsk/FailureMessage'
import type { AttemptStats } from './interfaces/AttemptStats'
import type { GeminiAskOptions } from './interfaces/GeminiAskOptions'
import type { AskResult } from './types/AskResult'


// With less time left, another model is not started.
const MIN_ATTEMPT_MS = 3_000
// When every model turned out unusable, the list is refreshed and the round
// repeated - at most this often, so a broken catalog causes no probe storm.
const MIN_REFRESH_INTERVAL_MS = 10 * 60_000
// ensure() answers this when the first model list is not ready in time.
const STILL_LOADING = Symbol('still loading')


// One ask() tries the models in the order of the list until one answers;
// models on quota, paused or unusable are skipped without a call. The whole
// call ends within timeoutMs (the hub gives up on a request after 30 s), one
// model gets at most modelTimeoutMs of it. When no list exists yet, ask()
// waits for the first one as long as the time allows. When every model is
// gone or without access, the list is refreshed once and the round repeated.
// What happens per model goes to the log; the agent gets the answer or one
// message that says whether and when to retry (FailureMessage).
/** Asks Gemini: the best available model, with fallback to the next. */
export class GeminiAsk {

    constructor(private api: GeminiApi, private list: GeminiModelList, private options: GeminiAskOptions, private logger: Logger) {
    }


    /** Sends the prompt and returns the answer, or a message for the agent. Never throws. */
    async ask(prompt: string): Promise<AskResult> {
        const deadline = Date.now() + this.options.timeoutMs
        this.logger.write(`ask_gemini (${prompt.length} chars)`)

        let models: ListedModel[] | typeof STILL_LOADING
        try {
            models = await within(this.list.ensure(), deadline - Date.now() - MIN_ATTEMPT_MS, STILL_LOADING)
        }
        catch (error) {
            this.logger.write(`Model list unavailable: ${(error as Error).message}`)
            return { ok: false, message: `Gemini is unavailable: the list of models could not be loaded (${(error as Error).message}). Try again later.` }
        }
        if (models === STILL_LOADING) {
            this.logger.write('Model list is still being prepared - answering with a retry hint')
            return { ok: false, message: 'Gemini is getting ready (the list of available models is being prepared). Try again in about 30 s.' }
        }

        let outcome = await this.tryModels(models, prompt, deadline)
        if (typeof outcome !== 'string' && this.worthRefresh(outcome)) {
            this.logger.write('No usable model left - refreshing the model list')
            const refreshed = this.list.refresh('all models unusable').then(() => true, error => {
                this.logger.write(`Model refresh failed: ${(error as Error).message}`)
                return false
            })
            if (await within(refreshed, deadline - Date.now() - MIN_ATTEMPT_MS, false)) {
                outcome = await this.tryModels(this.list.ordered(), prompt, deadline)
            }
            else {
                outcome.outOfTime = true
            }
        }
        this.list.save()

        if (typeof outcome === 'string') {
            return { ok: true, text: outcome }
        }
        const message = failureMessage(outcome, this.options.timeoutMs)
        this.logger.write(`ask_gemini failed: ${message}`)
        return { ok: false, message }
    }


    // One round over the models: the answer text, or what happened to them.
    private async tryModels(models: ListedModel[], prompt: string, deadline: number): Promise<string | AttemptStats> {
        const stats: AttemptStats = {
            tried: models.length, perMinute: 0, perDay: 0, wait: null, unavailable: 0, detail: null,
            rejected: 0, unusable: 0, outOfTime: false, blocked: null
        }
        const noteWait = (seconds: number) => {
            stats.wait = stats.wait === null ? seconds : Math.min(stats.wait, seconds)
        }

        for (const { id } of models) {
            if (this.list.isBlocked(id)) {
                this.skipped(id, stats, noteWait)
                continue
            }
            const remaining = deadline - Date.now()
            if (remaining < MIN_ATTEMPT_MS) {
                stats.outOfTime = true
                this.logger.write(`  ${id}: not tried, time limit of ${this.options.timeoutMs / 1000} s reached`)
                break
            }

            const started = Date.now()
            const result = await this.api.generate(id, prompt, Math.min(this.options.modelTimeoutMs, remaining))
            this.list.record(id, result)
            const took = `${((Date.now() - started) / 1000).toFixed(1)} s`
            switch (result.kind) {
                case GenerateKind.Ok:
                    this.logger.write(`  ${id}: OK (${took}, ${result.text.length} chars)`)
                    return result.text
                case GenerateKind.Blocked:
                    this.logger.write(`  ${id}: blocked (${result.reason})`)
                    stats.blocked = result.reason
                    return stats
                case GenerateKind.Quota:
                    if (result.period === QuotaPeriod.Day) {
                        stats.perDay++
                        this.logger.write(`  ${id}: quota per day`)
                    }
                    else {
                        stats.perMinute++
                        noteWait(result.retryAfterSec)
                        this.logger.write(`  ${id}: quota per minute, retry in ${result.retryAfterSec} s`)
                    }
                    break
                case GenerateKind.NoAccess:
                case GenerateKind.Gone:
                    stats.unusable++
                    this.logger.write(`  ${id}: HTTP ${result.status} ${result.message} - skipped until the next refresh`)
                    break
                case GenerateKind.Rejected:
                    stats.rejected++
                    this.logger.write(`  ${id}: HTTP 400, request rejected (${result.message})`)
                    break
                case GenerateKind.Timeout:
                    stats.unavailable++
                    stats.detail = result.message
                    this.logger.write(`  ${id}: ${result.message}, paused`)
                    break
                case GenerateKind.Network:
                    stats.unavailable++
                    stats.detail = result.message
                    this.logger.write(`  ${id}: network error (${result.message}, ${took})`)
                    break
                case GenerateKind.Unavailable:
                    stats.unavailable++
                    stats.detail = `HTTP ${result.status}`
                    this.logger.write(`  ${id}: HTTP ${result.status} (${result.message}, ${took})`)
                    break
            }
        }
        return stats
    }


    // Counts and logs a model that is skipped without a call.
    private skipped(id: string, stats: AttemptStats, noteWait: (seconds: number) => void): void {
        const state = this.list.state(id)
        const left = state.retryAfter === null ? '' : `, ${formatWait((state.retryAfter - Date.now()) / 1000)} left`
        switch (state.status) {
            case ModelStatus.Unusable:
                stats.unusable++
                break
            case ModelStatus.QuotaPerDay:
                stats.perDay++
                break
            case ModelStatus.Slow:
                stats.unavailable++
                break
            default:
                stats.perMinute++
                noteWait(state.retryAfter === null ? 60 : (state.retryAfter - Date.now()) / 1000)
        }
        this.logger.write(`  ${id}: skipped (${state.status}${state.status === ModelStatus.QuotaPerDay ? '' : left})`)
    }


    // A refresh can help only when every model is gone or without access; not for a fixed list, not too often.
    private worthRefresh(stats: AttemptStats): boolean {
        return !stats.blocked && stats.unusable === stats.tried && !this.list.fixed
            && this.list.refreshAgeMs() > MIN_REFRESH_INTERVAL_MS
    }
}


// The promise's value, or `fallback` once `ms` has passed. The promise runs
// on; should it fail after that, nobody is waiting - its failure is ignored
// here rather than crashing the process as an unhandled rejection.
function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
    promise.catch(() => { })
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<F>(resolve => {
        timer = setTimeout(resolve, Math.max(0, ms), fallback)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
