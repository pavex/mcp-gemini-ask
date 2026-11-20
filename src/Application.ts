import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { ApplicationContainer } from './ApplicationContainer'
import { loadConfig } from './config/Config'
import { SERVER_NAME, SERVER_VERSION } from './Consts'
import { registerAskGemini } from './tools/AskGeminiTool'


// Boot reads the config and the stored model list synchronously, then
// serves MCP on stdio. A missing or stale model list is refreshed in the
// background right away, so it is usually ready before the first question.
// serveStdio makes one McpServer per connection, for whichever protocol era
// the client speaks; all of them share the container and its model list.
/** The running server: boot and serve. */
export class Application {

    private constructor(private container: ApplicationContainer) {
    }


    /** Loads the config at `configPath` (none = defaults and GEMINI_API_KEY), loads the model list and serves stdio. */
    static start(configPath?: string): Application {
        const container = new ApplicationContainer(loadConfig(configPath))
        const application = new Application(container)
        const list = container.getModelList()
        list.load()
        application.logStartup(configPath)
        list.refreshIfStale()
        serveStdio(() => application.createServer())
        return application
    }


    /** A new MCP server with the ask_gemini tool. */
    createServer(): McpServer {
        const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
        registerAskGemini(server, this.container.getGeminiAsk(), this.container.getConfig().maxPromptChars)
        return server
    }


    // Which config, where the data is and where the models come from - never the key.
    private logStartup(configPath?: string): void {
        const config = this.container.getConfig()
        const list = this.container.getModelList()
        const logger = this.container.getLogger()
        logger.write(`${SERVER_NAME} ${SERVER_VERSION} started, config ${configPath ?? 'none (defaults)'}, data in ${config.dataDir}`)
        logger.write(list.fixed
            ? `Models: fixed list from config (${config.models.join(', ')}), discovery off`
            : `Models: discovered, include ${config.includeModels?.source ?? 'all'}, ${list.size} stored`)
        logger.write(`Thinking level: ${config.thinkingLevel ?? 'model default'} (Gemini 3 and newer)`)
    }
}
