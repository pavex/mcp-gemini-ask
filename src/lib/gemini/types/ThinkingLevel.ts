/** How much a model thinks before it answers (thinkingConfig.thinkingLevel, Gemini 3 and newer). */
export enum ThinkingLevel {
    /** Little to no thinking; not every model accepts it (Pro models do not). */
    Minimal = 'minimal',
    Low = 'low',
    Medium = 'medium',
    High = 'high'
}
