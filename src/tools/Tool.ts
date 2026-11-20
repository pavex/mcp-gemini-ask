import type { CallToolResult, McpServer, ToolAnnotations } from '@modelcontextprotocol/server'
import type { z } from 'zod'
import type { Logger } from '../log/Logger'
import { ToolError } from './Tool/ToolError'


// A tool says what it is (name, title, description, annotations, input
// schema) and does its work in run(), which returns the text for the agent.
// Registration, the answer and the errors are shared here: a ToolError is
// meant for the agent and goes to it as it is; anything else is a bug of
// the server and goes to the log in full and to the agent only as a short
// note.
/** A tool of the server, registered on every MCP server. */
export abstract class Tool<Input> {

    protected abstract readonly name: string
    protected abstract readonly title: string
    protected abstract readonly description: string
    protected abstract readonly annotations: ToolAnnotations
    /** What failed, for the error answer: "ask Gemini". */
    protected abstract readonly action: string


    constructor(protected logger: Logger) {
    }


    /** Registers the tool on the server. */
    register(server: McpServer): void {
        const { name, title, description, annotations } = this
        server.registerTool(name, { title, description, annotations, inputSchema: this.inputSchema() }, input => this.answer(input as Input))
    }


    /** The input schema; a method, so it can use what the constructor got. */
    protected abstract inputSchema(): z.ZodObject & z.ZodType<Input>


    /** Does the work and returns the text for the agent; throws a ToolError with the text for the agent on failure. */
    protected abstract run(input: Input): Promise<string>


    private async answer(input: Input): Promise<CallToolResult> {
        try {
            return { content: [{ type: 'text', text: await this.run(input) }] }
        }
        catch (error) {
            return this.failure(error)
        }
    }


    private failure(error: unknown): CallToolResult {
        if (error instanceof ToolError) {
            return { content: [{ type: 'text', text: error.message }], isError: true }
        }
        this.logger.write(`Unable to ${this.action}: ${(error as Error).stack ?? error}`)
        return { content: [{ type: 'text', text: `Unable to ${this.action}: server error. Try again later.` }], isError: true }
    }
}
