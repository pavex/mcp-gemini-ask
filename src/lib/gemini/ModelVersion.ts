const VERSION_PATTERN = /^gemini-(\d+(?:\.\d+)?)(?:-|$)/


/** The version in a model ID (gemini-3.5-flash -> 3.5), null for IDs without one (gemini-flash-latest). */
export function modelVersion(id: string): number | null {
    const match = id.match(VERSION_PATTERN)
    return match ? Number.parseFloat(match[1]) : null
}
