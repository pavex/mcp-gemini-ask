import { Application } from './Application'
import { findConfigPath } from './config/Config'
import { Logger } from './log/Logger'


// Entry point of mcp.js: node mcp.js [config.json]
// Without a path, config.json next to mcp.js is used when it exists,
// otherwise the defaults with GEMINI_API_KEY. A config problem stops the
// server with one line that says what to fix.

try {
    Application.start(findConfigPath(process.argv[2]))
}
catch (error) {
    new Logger().write(`ERROR: ${(error as Error).message}`)
    process.exit(1)
}
