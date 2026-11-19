const ID_PATTERN = /^gemini-(\d+(?:\.\d+)?)-?(pro|flash-lite|flash-8b|flash|nano)?(.*)$/


/**
 * Rank of a model ID, higher is better: newer version first, then pro >
 * flash > flash-lite. "-preview" and "-exp" only break ties - some current
 * models exist only as previews. IDs without a version (gemini-flash-latest,
 * gemini-omni-*) rank last: -Infinity.
 */
export function scoreModelId(id: string): number {
    const match = id.match(ID_PATTERN)
    if (!match) {
        return -Infinity
    }
    let score = Number.parseFloat(match[1]) * 100
    const variant = match[2] ?? ''
    if (variant === 'pro') {
        score += 30
    }
    else if (variant === 'flash') {
        score += 20
    }
    else if (variant) {
        score += 10
    }
    const tags = match[3] ?? ''
    if (tags.includes('-exp')) {
        score -= 5
    }
    else if (tags.includes('-preview')) {
        score -= 3
    }
    return score
}
