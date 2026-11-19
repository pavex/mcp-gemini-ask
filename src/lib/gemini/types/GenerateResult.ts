import type { GenerateKind } from './GenerateKind'
import type { QuotaPeriod } from './QuotaPeriod'


/** The outcome of GeminiApi.generate(): the answer, or why there is none. */
export type GenerateResult =
    | { kind: GenerateKind.Ok, text: string }
    | { kind: GenerateKind.Quota, period: QuotaPeriod, retryAfterSec: number }
    | { kind: GenerateKind.NoAccess | GenerateKind.Gone | GenerateKind.Rejected | GenerateKind.Unavailable, status: number, message: string }
    | { kind: GenerateKind.Blocked, reason: string }
    | { kind: GenerateKind.Timeout | GenerateKind.Network, message: string }
