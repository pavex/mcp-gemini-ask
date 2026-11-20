import { z } from 'zod'
import type { GeminiAsk } from '../ask/GeminiAsk'
import type { Logger } from '../log/Logger'
import { Tool } from './Tool'
import { ToolError } from './Tool/ToolError'


// The agent gets the answer as plain text; a failure is isError with the
// message of GeminiAsk, which says whether and when to retry. Nothing about
// the models: that goes to the log.
/** The tool ask_gemini(prompt): one question to Gemini. */
export class AskGeminiTool extends Tool<{ prompt: string }> {

    protected readonly name = 'ask_gemini'
    protected readonly title = 'Ask Gemini'
    protected readonly action = 'ask Gemini'
    protected readonly annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    protected readonly description = [
        'Sends a prompt to Google Gemini and returns its answer as text.',
        'Use it for a second opinion, a review, or a task that benefits from another model.',
        'Gemini sees only the prompt - include all the context it needs.',
        'The server picks the best available Gemini model and falls back to another one on its own.',
        'On failure the result is an error whose text says whether and when to retry.'
    ].join('\n')


    constructor(private ask: GeminiAsk, logger: Logger, private maxPromptChars: number) {
        super(logger)
    }


    protected inputSchema() {
        return z.object({
            prompt: z.string().min(1).max(this.maxPromptChars)
                .describe(`The question or instruction for Gemini, with all needed context (max ${this.maxPromptChars} chars).`)
        })
    }


    protected async run({ prompt }: { prompt: string }): Promise<string> {
        const result = await this.ask.ask(prompt)
        if (!result.ok) {
            throw new ToolError(result.message)
        }
        return result.text
    }
}
