/** The answer of GeminiAsk.ask(), or a message for the agent saying whether and when to retry. */
export type AskResult = { ok: true, text: string } | { ok: false, message: string }
