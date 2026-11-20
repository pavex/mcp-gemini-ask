import type { GeminiApiOptions } from './interfaces/GeminiApiOptions'
import { modelVersion } from './ModelVersion'
import { GenerateKind } from './types/GenerateKind'
import type { GenerateResult } from './types/GenerateResult'
import { QuotaPeriod } from './types/QuotaPeriod'
import type { ThinkingLevel } from './types/ThinkingLevel'


const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/'
const DEFAULT_TIMEOUT_MS = 20_000
// ListModels is metadata only and quick; its limit does not follow generate's.
const LIST_TIMEOUT_MS = 30_000
// thinkingLevel exists since Gemini 3; 2.5 knows only thinkingBudget and rejects it.
const THINKING_LEVEL_SINCE = 3
const DEFAULT_RETRY_AFTER_SEC = 60


// Plain REST over fetch, no SDK. The time limit covers the whole exchange,
// body included: a model may send its headers and then never finish the
// answer. generate() never throws - every outcome is a GenerateResult, so the
// caller decides what a quota, a 404 or a timeout means for it. A thinking
// level goes only to models whose ID says version 3 or newer.
/** The Gemini REST API: the list of models and one generateContent call. */
export class GeminiApi {

    private apiKey: string
    private baseUrl: string
    private timeoutMs: number
    private thinkingLevel: ThinkingLevel | null


    constructor(options: GeminiApiOptions) {
        this.apiKey = options.apiKey
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/?$/, '/')
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
        this.thinkingLevel = options.thinkingLevel ?? null
    }


    /** IDs of all models that support generateContent, without the "models/" prefix. Throws when the list can't be read. */
    async listModelIds(timeoutMs = LIST_TIMEOUT_MS): Promise<string[]> {
        const ids: string[] = []
        let pageToken: string | undefined
        do {
            const url = new URL(`${this.baseUrl}models`)
            url.searchParams.set('pageSize', '1000')
            if (pageToken) {
                url.searchParams.set('pageToken', pageToken)
            }
            let response: ApiResponse
            try {
                response = await this.request(url, {}, timeoutMs)
            }
            catch (error) {
                throw new Error(isAbort(error) ? `ListModels: no response within ${seconds(timeoutMs)}` : `ListModels: ${networkMessage(error)}`)
            }
            if (!response.ok) {
                throw new Error(`ListModels HTTP ${response.status}${response.text ? ` - ${response.text.slice(0, 300)}` : ''}`)
            }
            const body = response.body as ModelsPage | null
            for (const model of body?.models ?? []) {
                if (model.supportedGenerationMethods?.includes('generateContent')) {
                    ids.push(model.name.replace(/^models\//, ''))
                }
            }
            pageToken = body?.nextPageToken
        } while (pageToken)
        return ids
    }


    /** Sends one prompt to one model and says how it ended. Never throws. */
    async generate(modelId: string, prompt: string, timeoutMs = this.timeoutMs): Promise<GenerateResult> {
        let response: ApiResponse
        try {
            response = await this.request(`${this.baseUrl}models/${modelId}:generateContent`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(this.requestBody(modelId, prompt))
            }, timeoutMs)
        }
        catch (error) {
            return isAbort(error)
                ? { kind: GenerateKind.Timeout, message: `no response within ${seconds(timeoutMs)}` }
                : { kind: GenerateKind.Network, message: networkMessage(error) }
        }

        const { status } = response
        if (status === 429) {
            return { kind: GenerateKind.Quota, ...quotaOf(response) }
        }
        if (status === 401 || status === 403) {
            return { kind: GenerateKind.NoAccess, status, message: errorMessage(response) }
        }
        if (status === 404) {
            return { kind: GenerateKind.Gone, status, message: errorMessage(response) }
        }
        if (status === 400) {
            return { kind: GenerateKind.Rejected, status, message: errorMessage(response) }
        }
        if (!response.ok) {
            return { kind: GenerateKind.Unavailable, status, message: errorMessage(response) }
        }
        return answerOf(response.body as GenerateBody | null)
    }


    // The prompt, and the thinking level for a model that knows it.
    private requestBody(modelId: string, prompt: string): object {
        const body: Record<string, unknown> = { contents: [{ role: 'user', parts: [{ text: prompt }] }] }
        if (this.thinkingLevel && (modelVersion(modelId) ?? 0) >= THINKING_LEVEL_SINCE) {
            body.generationConfig = { thinkingConfig: { thinkingLevel: this.thinkingLevel } }
        }
        return body
    }


    // One request whose timeout covers the body too; the body parsed as JSON when it is JSON.
    private async request(url: string | URL, init: RequestInit, timeoutMs: number): Promise<ApiResponse> {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
            const response = await fetch(url, {
                ...init,
                headers: { ...init.headers as Record<string, string>, 'x-goog-api-key': this.apiKey },
                signal: controller.signal
            })
            const text = await response.text()
            return { ok: response.ok, status: response.status, headers: response.headers, text, body: parseJson(text) }
        }
        finally {
            clearTimeout(timer)
        }
    }
}


// A response, read to the end.
interface ApiResponse {
    ok: boolean
    status: number
    headers: Headers
    text: string
    body: unknown
}


// The parts of a ListModels page used here.
interface ModelsPage {
    models?: { name: string, supportedGenerationMethods?: string[] }[]
    nextPageToken?: string
}


// The parts of a generateContent answer used here.
interface GenerateBody {
    candidates?: {
        content?: { parts?: { text?: string, thought?: boolean }[] }
        finishReason?: string
        safetyRatings?: { category: string, blocked?: boolean }[]
    }[]
    promptFeedback?: { blockReason?: string }
}


// The parts of an error body used here.
interface ErrorBody {
    error?: {
        message?: string
        details?: { metadata?: { quota_metric?: string }, violations?: { quotaId?: string }[], retryDelay?: string }[]
    }
}


// Which quota a 429 hit and how long to wait: Retry-After, the quota metric
// or quota ID in the details, "per day" in the message.
function quotaOf(response: ApiResponse): { period: QuotaPeriod, retryAfterSec: number } {
    let period = QuotaPeriod.Minute
    let retryAfterSec = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
    if (Number.isNaN(retryAfterSec)) {
        retryAfterSec = DEFAULT_RETRY_AFTER_SEC
    }
    const error = (response.body as ErrorBody | null)?.error
    for (const detail of error?.details ?? []) {
        const metric = detail.metadata?.quota_metric ?? detail.violations?.[0]?.quotaId ?? ''
        if (/qpd|PerDay/i.test(metric)) {
            period = QuotaPeriod.Day
        }
        const delay = detail.retryDelay?.match(/^(\d+)/)
        if (delay) {
            retryAfterSec = Number(delay[1])
        }
    }
    if (error?.message?.toLowerCase().includes('per day')) {
        period = QuotaPeriod.Day
    }
    return { period, retryAfterSec }
}


// The text of the answer (thoughts left out), or why it was blocked.
function answerOf(body: GenerateBody | null): GenerateResult {
    const candidate = body?.candidates?.[0]
    if (!candidate) {
        const blockReason = body?.promptFeedback?.blockReason
        return blockReason ? { kind: GenerateKind.Blocked, reason: `prompt blocked: ${blockReason}` } : { kind: GenerateKind.Ok, text: '' }
    }
    const text = (candidate.content?.parts ?? [])
        .filter(part => typeof part.text === 'string' && !part.thought)
        .map(part => part.text)
        .join('')
    if (!text && candidate.finishReason && candidate.finishReason !== 'STOP') {
        const categories = (candidate.safetyRatings ?? [])
            .filter(rating => rating.blocked)
            .map(rating => rating.category.replace('HARM_CATEGORY_', ''))
        return { kind: GenerateKind.Blocked, reason: categories.length ? `blocked: ${categories.join(', ')}` : `finish reason: ${candidate.finishReason}` }
    }
    return { kind: GenerateKind.Ok, text }
}


// A short reason from an error body, for the log.
function errorMessage(response: ApiResponse): string {
    const message = (response.body as ErrorBody | null)?.error?.message ?? response.text
    return message.replace(/\s+/g, ' ').trim().slice(0, 160)
}


function parseJson(text: string): unknown {
    try {
        return JSON.parse(text)
    }
    catch {
        return null
    }
}


function isAbort(error: unknown): boolean {
    return (error as Error).name === 'AbortError'
}


// fetch hides the cause (ECONNREFUSED, ENOTFOUND) behind "fetch failed",
// sometimes one level deeper in an AggregateError.
function networkMessage(error: unknown): string {
    const cause = (error as { cause?: { code?: string, message?: string, errors?: { code?: string }[] } }).cause
    return cause?.code ?? cause?.errors?.[0]?.code ?? cause?.message ?? (error as Error).message
}


function seconds(ms: number): string {
    return `${Math.round(ms / 1000)} s`
}
