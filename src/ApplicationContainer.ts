import { join } from 'node:path'
import { GeminiAsk } from './ask/GeminiAsk'
import type { GeminiAskConfig } from './config/interfaces/GeminiAskConfig'
import { GeminiApi, GeminiModelList } from './lib/gemini'
import { Logger } from './log/Logger'
import { MODELS_FILE } from './Consts'


// Services live as long as the process: lazy getters (`??=`), no DI
// library. The container gets the config (and, in tests, a quiet logger),
// the rest it makes itself. The model list is shared by every MCP
// connection, so its state stays in one place.
/** The server's services, wired together. */
export class ApplicationContainer {

    private api?: GeminiApi
    private modelList?: GeminiModelList
    private geminiAsk?: GeminiAsk


    constructor(private config: GeminiAskConfig, private logger = new Logger()) {
    }


    getConfig(): GeminiAskConfig {
        return this.config
    }


    getLogger(): Logger {
        return this.logger
    }


    getGeminiApi(): GeminiApi {
        return this.api ??= new GeminiApi({
            apiKey: this.config.apiKey,
            baseUrl: this.config.baseUrl,
            timeoutMs: this.config.modelTimeoutMs,
            thinkingLevel: this.config.thinkingLevel
        })
    }


    getModelList(): GeminiModelList {
        return this.modelList ??= new GeminiModelList(this.getGeminiApi(), {
            storagePath: join(this.config.dataDir, MODELS_FILE),
            models: this.config.models,
            include: this.config.includeModels,
            exclude: this.config.excludeModels,
            deprioritize: this.config.deprioritizeModels,
            ttlMs: this.config.modelsTtlMs,
            log: message => this.logger.write(message)
        })
    }


    getGeminiAsk(): GeminiAsk {
        return this.geminiAsk ??= new GeminiAsk(this.getGeminiApi(), this.getModelList(), {
            timeoutMs: this.config.timeoutMs,
            modelTimeoutMs: this.config.modelTimeoutMs
        }, this.logger)
    }
}
