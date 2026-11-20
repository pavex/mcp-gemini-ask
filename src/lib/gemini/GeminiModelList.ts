import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GeminiApi } from './GeminiApi'
import { scoreModelId } from './GeminiModelList/ModelRanking'
import { ModelStates } from './GeminiModelList/ModelStates'
import type { GeminiModelListOptions } from './interfaces/GeminiModelListOptions'
import type { ListedModel } from './interfaces/ListedModel'
import type { ModelState } from './interfaces/ModelState'
import { GenerateKind } from './types/GenerateKind'
import type { GenerateResult } from './types/GenerateResult'
import { ModelStatus } from './types/ModelStatus'
import { QuotaPeriod } from './types/QuotaPeriod'


const DEFAULT_TTL_MS = 24 * 3_600_000
const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const DEFAULT_SLOW_PAUSE_MS = 10 * 60_000
const PROBE_PROMPT = 'Hi'
const PROBE_CONCURRENCY = 8
// How far today's failures move a model back; one tier is 1.
const FAIL_RATIO_WEIGHT = 200
const DEPRIORITIZE_PENALTY = 1_000
// Outcomes of a probe that say the model can't be used for text prompts at all.
const UNUSABLE_ON_PROBE = new Set([GenerateKind.NoAccess, GenerateKind.Gone, GenerateKind.Rejected, GenerateKind.Blocked])


// The list either comes from the options (a fixed list, used as given) or
// the list finds the models itself. Refresh = ListModels -> name filter
// (gemini-*, include, exclude) -> one short probe call per candidate, which
// drops models that refuse text prompts -> rank by ID. A probe that hits a
// quota, 5xx or silence keeps the model: that is availability, not the model
// type - but it counts, so the model goes to the back. ordered() is the
// order to try: rank, then deprioritized models last and today's failures
// further back. record() turns the outcome of a call into the model's state
// (quota, pause, unusable), and the storage file keeps list and states over
// restarts; a change of include/exclude makes a stored list stale.
// One refresh runs at a time: refresh() during a refresh joins it.
/** The Gemini models to use, best first, with what is known about each: found, probed and ordered by itself. */
export class GeminiModelList {

    private states = new ModelStates()
    private models: ListedModel[] = []
    private refreshedAt: number | null = null
    private refreshing?: Promise<ListedModel[]>
    private fixedIds: string[]
    private include: RegExp | null
    private exclude: RegExp | null
    private deprioritize: RegExp | null
    private ttlMs: number
    private probeTimeoutMs: number
    private slowPauseMs: number
    private storagePath?: string
    private log: (message: string) => void


    constructor(private api: GeminiApi, options: GeminiModelListOptions = {}) {
        this.fixedIds = [...new Set((options.models ?? []).map(id => id.replace(/^models\//, '')))]
        this.include = options.include ?? null
        this.exclude = options.exclude ?? null
        this.deprioritize = options.deprioritize ?? null
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
        this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS
        this.slowPauseMs = options.slowPauseMs ?? DEFAULT_SLOW_PAUSE_MS
        this.storagePath = options.storagePath
        this.log = options.log ?? (() => { })
        if (this.fixed) {
            this.models = this.fixedIds.map((id, index) => ({ id, tier: index + 1 }))
        }
    }


    /** Whether the list is fixed by the options (no discovery). */
    get fixed(): boolean {
        return this.fixedIds.length > 0
    }


    /** How many models are on the list. */
    get size(): number {
        return this.models.length
    }


    /** Whether discovery would take this model ID: gemini-*, matching include, not exclude. */
    isCandidate(id: string): boolean {
        return id.startsWith('gemini-') && (!this.include || this.include.test(id)) && !this.exclude?.test(id)
    }


    /** Whether a discovered list is due for a refresh: none yet or older than the TTL. Never for a fixed list. */
    isStale(now = Date.now()): boolean {
        return !this.fixed && (this.refreshedAt === null || now - this.refreshedAt > this.ttlMs)
    }


    /** Milliseconds since the last refresh, Infinity when there was none. */
    refreshAgeMs(now = Date.now()): number {
        return this.refreshedAt === null ? Infinity : now - this.refreshedAt
    }


    /** The models in the order to try them: rank, deprioritized last, today's failures further back. */
    ordered(now = Date.now()): ListedModel[] {
        const priority = (model: ListedModel) => -model.tier
            - (this.deprioritize?.test(model.id) ? DEPRIORITIZE_PENALTY : 0)
            - this.states.failRatio(model.id, now) * FAIL_RATIO_WEIGHT
        return [...this.models].sort((a, b) => priority(b) - priority(a))
    }


    /** What is known about a model now. */
    state(id: string): ModelState {
        return this.states.get(id)
    }


    /** Whether a model is to be skipped now (quota, pause, unusable). */
    isBlocked(id: string, now = Date.now()): boolean {
        return this.states.isBlocked(id, now)
    }


    /** Turns the outcome of a call into the model's state: answer, quota, pause, unusable or one more failure. */
    record(id: string, result: GenerateResult, now = Date.now()): void {
        switch (result.kind) {
            case GenerateKind.Ok:
                this.states.ok(id, now)
                break
            case GenerateKind.Quota:
                this.states.quota(id, result.period, result.retryAfterSec, now)
                break
            case GenerateKind.Timeout:
                this.states.slow(id, this.slowPauseMs, now)
                break
            case GenerateKind.NoAccess:
            case GenerateKind.Gone:
                this.states.unusable(id, now)
                break
            default:
                this.states.failure(id, now)
        }
    }


    /** Counts one failure without changing the status - e.g. a timeout under the caller's shortened limit, which says nothing about the model. */
    recordFailure(id: string, now = Date.now()): void {
        this.states.failure(id, now)
    }


    /** Reads the storage file: the list (filtered by the current include/exclude) and the states. A missing file is an empty start. */
    load(): void {
        const stored = this.readStorage()
        if (this.fixed) {
            // States carry over, except "unusable": the fixed list is the user's call.
            for (const model of this.models) {
                const state = stored?.models.find(entry => entry.id === model.id)
                if (state && state.status !== ModelStatus.Unusable) {
                    this.states.restore(model.id, stateOf(state))
                }
            }
            return
        }
        this.models = []
        this.refreshedAt = null
        if (!stored) {
            return
        }
        for (const entry of stored.models) {
            if (this.isCandidate(entry.id)) {
                this.models.push({ id: entry.id, tier: entry.tier })
                this.states.restore(entry.id, stateOf(entry))
            }
        }
        const refreshedAt = Date.parse(stored.refreshedAt ?? '')
        this.refreshedAt = Number.isNaN(refreshedAt) || stored.filter !== this.filterKey() ? null : refreshedAt
    }


    /** Writes the list and the states to the storage file. Never throws: a failure only goes to the log. */
    save(): void {
        if (!this.storagePath) {
            return
        }
        const stored: StoredList = {
            refreshedAt: this.refreshedAt === null ? null : new Date(this.refreshedAt).toISOString(),
            filter: this.fixed ? null : this.filterKey(),
            models: this.models.map(model => ({ ...model, ...this.states.get(model.id) }))
        }
        try {
            mkdirSync(dirname(this.storagePath), { recursive: true })
            const temporary = `${this.storagePath}.tmp`
            writeFileSync(temporary, JSON.stringify(stored, null, 2))
            renameSync(temporary, this.storagePath)
        }
        catch (error) {
            this.log(`WARNING: cannot write ${this.storagePath}: ${(error as Error).message}`)
        }
    }


    /** Finds and probes the models anew, or joins the refresh that runs. Throws when the catalog can't be read. A fixed list stays as it is. */
    refresh(reason = 'requested'): Promise<ListedModel[]> {
        if (this.fixed) {
            return Promise.resolve(this.ordered())
        }
        this.refreshing ??= this.discover(reason).finally(() => {
            this.refreshing = undefined
        })
        return this.refreshing
    }


    /** Starts a refresh in the background when the list is stale; a failure only goes to the log. */
    refreshIfStale(): void {
        if (!this.isStale() || this.refreshing) {
            return
        }
        this.refresh(this.models.length ? 'list older than TTL or filter changed' : 'no models yet').catch(error => {
            this.log(`WARNING: model refresh failed: ${(error as Error).message}`)
        })
    }


    /** The models to try: waits for a refresh when there are none, otherwise refreshes a stale list in the background. */
    async ensure(): Promise<ListedModel[]> {
        if (!this.models.length && !this.fixed) {
            await this.refresh('no models yet')
        }
        else {
            this.refreshIfStale()
        }
        return this.ordered()
    }


    // ListModels, name filter, probes, rank; the result replaces the list and is saved.
    private async discover(reason: string): Promise<ListedModel[]> {
        const started = Date.now()
        this.log(`Refreshing model list (${reason})...`)
        const catalog = await this.api.listModelIds()
        const candidates = catalog.filter(id => this.isCandidate(id))
        this.log(`  ${candidates.length} candidates of ${catalog.length} in catalog: ${candidates.join(', ')}`)

        const usable: string[] = []
        const queue = [...candidates]
        const worker = async () => {
            for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
                if (await this.probe(id)) {
                    usable.push(id)
                }
            }
        }
        await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker))

        this.models = usable.sort(byRank).map((id, index) => ({ id, tier: index + 1 }))
        this.refreshedAt = Date.now()
        this.save()
        this.log(`Model list: ${this.models.length} usable of ${candidates.length} candidates (${catalog.length} in catalog), `
            + `${((Date.now() - started) / 1000).toFixed(1)} s`)
        this.ordered().forEach((model, index) => {
            const state = this.states.get(model.id)
            this.log(`  ${index + 1}. ${model.id} [${state.status}${state.failCount && !state.okCount ? ', failed' : ''}]`)
        })
        return this.ordered()
    }


    // One short call; false when the model can't be used for text prompts.
    private async probe(id: string): Promise<boolean> {
        const started = Date.now()
        const result = await this.api.generate(id, PROBE_PROMPT, this.probeTimeoutMs)
        this.record(id, result)
        const took = `${((Date.now() - started) / 1000).toFixed(1)} s`
        const outcome = describe(result, this.slowPauseMs)
        if (UNUSABLE_ON_PROBE.has(result.kind)) {
            this.log(`  probe ${id}: ${outcome} - dropped`)
            return false
        }
        this.log(`  probe ${id}: ${outcome} (${took})`)
        return true
    }


    // The discovery filter as stored with the list: a change makes the stored list stale.
    private filterKey(): string {
        return `include=${this.include?.source ?? ''};exclude=${this.exclude?.source ?? ''}`
    }


    private readStorage(): StoredList | null {
        if (!this.storagePath) {
            return null
        }
        let parsed: unknown
        try {
            parsed = JSON.parse(readFileSync(this.storagePath, 'utf8'))
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.log(`WARNING: cannot read ${this.storagePath} (${(error as Error).message}) - starting with no models`)
            }
            return null
        }
        const stored = parsed as Partial<StoredList> | null
        const models = Array.isArray(stored?.models) ? stored.models : []
        return {
            refreshedAt: typeof stored?.refreshedAt === 'string' ? stored.refreshedAt : null,
            filter: typeof stored?.filter === 'string' ? stored.filter : null,
            models: models.filter(entry => typeof entry?.id === 'string' && typeof entry.tier === 'number')
        }
    }
}


// The storage file.
interface StoredList {
    refreshedAt: string | null
    filter: string | null
    models: (ListedModel & Partial<ModelState>)[]
}


// The state part of a stored entry.
function stateOf({ id, tier, ...state }: ListedModel & Partial<ModelState>): Partial<ModelState> {
    return state
}


// Better rank first; IDs without a version (-Infinity) last, by name.
function byRank(a: string, b: string): number {
    const scoreA = scoreModelId(a)
    const scoreB = scoreModelId(b)
    if (scoreA === scoreB) {
        return a.localeCompare(b)
    }
    return scoreB > scoreA ? 1 : -1
}


// A probe's outcome for the log.
function describe(result: GenerateResult, slowPauseMs: number): string {
    switch (result.kind) {
        case GenerateKind.Ok:
            return 'ok'
        case GenerateKind.Quota:
            return `quota per ${result.period === QuotaPeriod.Day ? 'day' : 'minute'}`
        case GenerateKind.Timeout:
            return `${result.message}, paused for ${Math.round(slowPauseMs / 60_000)} min`
        case GenerateKind.Blocked:
            return result.reason
        case GenerateKind.Network:
            return `network: ${result.message}`
        default:
            return `HTTP ${result.status} ${result.message}`
    }
}
