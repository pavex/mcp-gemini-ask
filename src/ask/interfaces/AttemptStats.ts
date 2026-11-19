/** What happened to the models of one try round, for the message to the agent. */
export interface AttemptStats {
    /** Models on the list. */
    tried: number
    perMinute: number
    perDay: number
    /** Seconds until the first per-minute quota runs out. */
    wait: number | null
    /** Timeouts, pauses, 5xx and network errors. */
    unavailable: number
    /** The last of those, for the message. */
    detail: string | null
    /** HTTP 400: the request itself was refused. */
    rejected: number
    /** Gone or no access: needs a refresh. */
    unusable: number
    /** The time limit ended the round before every model was tried. */
    outOfTime: boolean
    /** Safety filters refused the prompt; ends the round. */
    blocked: string | null
}
