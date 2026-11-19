import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { GeminiAsk } from '../ask/GeminiAsk'


/** Name of the only tool. */
export const ASK_GEMINI = 'ask_gemini'

const DESCRIPTION = [
    'Sends a prompt to Google Gemini and returns its answer as text.',
    'Use it for a second opinion, a review, or a task that benefits from another model.',
    'Gemini sees only the prompt - include all the context it needs.',
    'The server picks the best available Gemini model and falls back to another one on its own.',
    'On failure the result is an error whose text says whether and when to retry.'
].join('\n')


// The agent gets the answer as plain text; a failure is isError with the
// message of GeminiAsk. Nothing about the models: that goes to the log.
/** Registers ask_gemini(prompt) on the server. */
export function registerAskGemini(server: McpServer, ask: GeminiAsk, maxPromptChars: number): void {
    server.registerTool(ASK_GEMINI, {
        title: 'Ask Gemini',
        description: DESCRIPTION,
        inputSchema: z.object({
            prompt: z.string().min(1).max(maxPromptChars)
                .describe(`The question or instruction for Gemini, with all needed context (max ${maxPromptChars} chars).`)
        }),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    }, async ({ prompt }) => {
        const result = await ask.ask(prompt)
        return result.ok
            ? { content: [{ type: 'text' as const, text: result.text }] }
            : { content: [{ type: 'text' as const, text: result.message }], isError: true }
    })
}
