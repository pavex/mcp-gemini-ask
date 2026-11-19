// stdout carries the MCP protocol, so every line goes to stderr - the hub
// passes its servers' stderr through to its own terminal.
/** Writes what the server does to stderr, one timestamped line each. */
export class Logger {

    /** `print`: false keeps it quiet (tests). */
    constructor(private print = true) {
    }


    /** Writes one line: <ISO time> [gemini-ask] message. */
    write(message: string): void {
        if (this.print) {
            console.error(`${new Date().toISOString()} [gemini-ask] ${message}`)
        }
    }
}
