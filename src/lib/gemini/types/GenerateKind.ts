/** How one generateContent call ended (GeminiApi.generate()). */
export enum GenerateKind {
    Ok = 'ok',
    /** HTTP 429: per-minute or per-day quota. */
    Quota = 'quota',
    /** HTTP 401/403: the key has no access to this model. */
    NoAccess = 'no_access',
    /** HTTP 404: the model no longer exists. */
    Gone = 'gone',
    /** HTTP 400: the model refused this request (prompt too long, unsupported input). */
    Rejected = 'rejected',
    /** HTTP 5xx and other errors: overloaded or down for a while. */
    Unavailable = 'unavailable',
    /** The answer was blocked (safety filters). */
    Blocked = 'blocked',
    /** No complete answer within the time limit. */
    Timeout = 'timeout',
    /** The request did not get through (DNS, connection). */
    Network = 'network'
}
