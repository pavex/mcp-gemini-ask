import { type IncomingMessage, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'


/** The key the fake accepts; any other gets 400 like the real API. */
export const FAKE_KEY = 'test-key'


/** How a fake model behaves on generateContent. */
export type FakeBehavior = 'ok' | 'quota_minute' | 'quota_day' | 'gone' | 'rejected' | 'forbidden' | 'error503' | 'blocked' | 'slow' | 'stall'


/** A running fake: change `models` between calls, read `calls`. */
export interface FakeGemini {
    /** ID -> behavior; only these IDs are listed by ListModels. */
    models: Record<string, FakeBehavior>
    /** Every generateContent call, in order, with the thinking level it carried. */
    calls: { id: string, prompt: string, thinkingLevel?: string }[]
    /** How often ListModels was called. */
    listCalls: number
    /** Delay of ListModels answers (a slow discovery). */
    listDelayMs: number
    /** Base URL for GeminiApi / the config (…/v1beta/). */
    url: string
    close(): Promise<void>
}


// A local stand-in for the Gemini REST API, on a free port of 127.0.0.1:
// ListModels lists the IDs of `models`, generateContent answers by the
// model's behavior - "<id> says: <prompt>" when it is ok, a 429 with the
// quota metric, 400/403/404/503, a blocked prompt, an answer after 5 s ("slow") or headers
// and half a body that never ends ("stall"). Unknown IDs get 404.
/** Starts the fake Gemini API. */
export async function startFakeGemini(models: Record<string, FakeBehavior> = {}): Promise<FakeGemini> {
    const fake = { models, calls: [], listCalls: 0, listDelayMs: 0, url: '' } as unknown as FakeGemini
    const server = createServer((request, response) => void handle(fake, request, response))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/`
    fake.close = () => new Promise(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
    })
    return fake
}


async function handle(fake: FakeGemini, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
        response.end(JSON.stringify(body))
    }
    if (request.headers['x-goog-api-key'] !== FAKE_KEY) {
        return send(400, { error: { message: 'API key not valid' } })
    }
    const path = new URL(request.url ?? '/', 'http://fake').pathname
    if (request.method === 'GET' && path === '/v1beta/models') {
        fake.listCalls++
        await new Promise(resolve => setTimeout(resolve, fake.listDelayMs))
        return send(200, { models: Object.keys(fake.models).map(id => ({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] })) })
    }
    const match = path.match(/^\/v1beta\/models\/([^:]+):generateContent$/)
    if (request.method !== 'POST' || !match) {
        return send(404, { error: { message: 'not found' } })
    }

    let body = ''
    for await (const chunk of request) {
        body += chunk
    }
    const id = match[1]
    const sent = JSON.parse(body)
    const prompt = sent.contents[0].parts[0].text as string
    fake.calls.push({ id, prompt, thinkingLevel: sent.generationConfig?.thinkingConfig?.thinkingLevel })

    switch (fake.models[id]) {
        case 'ok':
            return send(200, { candidates: [{ content: { parts: [{ text: `${id} says: ${prompt}` }] }, finishReason: 'STOP' }] })
        case 'quota_minute':
            return send(429, { error: { message: 'Quota exceeded', details: [{ metadata: { quota_metric: 'generativelanguage.googleapis.com/generate_requests_per_model/qpm' } }] } },
                { 'Retry-After': '30' })
        case 'quota_day':
            return send(429, { error: { message: 'Quota exceeded per day', details: [{ metadata: { quota_metric: 'generativelanguage.googleapis.com/generate_requests_per_model/qpd' } }] } })
        case 'rejected':
            return send(400, { error: { message: 'Invalid argument' } })
        case 'forbidden':
            return send(403, { error: { message: 'Permission denied' } })
        case 'blocked':
            return send(200, { promptFeedback: { blockReason: 'SAFETY' } })
        case 'error503':
            return send(503, { error: { message: 'This model is currently experiencing high demand.' } })
        case 'slow':
            setTimeout(() => send(200, { candidates: [] }), 5_000)
            return
        case 'stall':
            response.writeHead(200, { 'Content-Type': 'application/json' })
            response.write('{"candidates":')
            return
        default:
            return send(404, { error: { message: `models/${id} is not found` } })
    }
}
