import { type ChildProcess, spawn } from 'node:child_process'
import { resolve } from 'node:path'


/** The built server. */
export const DIST_SERVER = resolve(import.meta.dirname, '..', '..', 'dist', 'mcp.js')


/** A JSON-RPC message from the server. */
export interface RpcMessage {
    id?: number
    result?: Record<string, any>
    error?: { code: number, message: string }
}


/** A server process spoken to over stdio. */
export interface StdioServer {
    call(method: string, params?: unknown): Promise<RpcMessage>
    notify(method: string, params?: unknown): void
    /** initialize + notifications/initialized; the initialize result. */
    initialize(protocolVersion?: string): Promise<RpcMessage>
    /** Everything the server wrote to stderr so far. */
    stderr(): string
    /** Every stdout line that was not JSON-RPC (should stay empty). */
    noise(): string[]
    /** Resolves with the exit code. */
    exited: Promise<number | null>
    stop(): Promise<void>
}


// Spawns `node <script> <args>` and talks newline-delimited JSON-RPC on its
// stdin/stdout. Each call waits at most 15 s for its answer.
/** Starts a server process. */
export function startStdioServer(script: string, args: string[] = [], options: { cwd?: string, env?: NodeJS.ProcessEnv } = {}): StdioServer {
    const child: ChildProcess = spawn(process.execPath, [script, ...args], { cwd: options.cwd, env: options.env ?? process.env })
    const waiting = new Map<number, (message: RpcMessage) => void>()
    const noise: string[] = []
    let buffer = ''
    let errors = ''
    let nextId = 1

    child.stdout?.on('data', chunk => {
        buffer += chunk
        for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
            const line = buffer.slice(0, newline).trim()
            buffer = buffer.slice(newline + 1)
            if (!line) {
                continue
            }
            try {
                const message = JSON.parse(line) as RpcMessage
                if (message.id !== undefined) {
                    waiting.get(message.id)?.(message)
                    waiting.delete(message.id)
                }
            }
            catch {
                noise.push(line)
            }
        }
    })
    child.stderr?.on('data', chunk => {
        errors += chunk
    })
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))

    const send = (message: object) => child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    const call = (method: string, params: unknown = {}) => new Promise<RpcMessage>((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => reject(new Error(`${method} got no answer`)), 15_000)
        waiting.set(id, message => {
            clearTimeout(timer)
            resolve(message)
        })
        send({ id, method, params })
    })
    const notify = (method: string, params: unknown = {}) => {
        send({ method, params })
    }

    return {
        call,
        notify,
        async initialize(protocolVersion = '2025-11-25') {
            const answer = await call('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } })
            notify('notifications/initialized')
            return answer
        },
        stderr: () => errors,
        noise: () => noise,
        exited,
        async stop() {
            child.stdin?.end()
            child.kill()
            await exited
        }
    }
}
