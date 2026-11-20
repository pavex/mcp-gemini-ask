// Thrown by a tool's run() when the work failed in a way the agent should
// know about; Tool turns it into an isError answer with the message as it is.
/** A failure meant for the agent: its message is the whole answer. */
export class ToolError extends Error {

    constructor(message: string) {
        super(message)
        this.name = 'ToolError'
    }
}
