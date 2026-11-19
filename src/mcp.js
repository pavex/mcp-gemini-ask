#!/usr/bin/env node
// mcp.js — entry point of mcp-gemini-ask.
// Usage: node mcp.js [config.json]

import { McpServer }  from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { Config, loadConfig, SERVER_NAME, SERVER_VERSION } from './Config.js';
import { log } from './Log.js';
import * as Models from './GeminiModels.js';
import { createAskGemini } from './Tools/AskGemini.js';

try {
  Config.use(loadConfig());
} catch (e) {
  log(`ERROR: ${e.message}`);
  process.exit(1);
}

Models.load();
log(`${SERVER_NAME} ${SERVER_VERSION} started, data in ${Config.dataDir}`);
Models.refreshIfStale();

const askGemini = createAskGemini(Config);

// serveStdio calls the factory once per connection, for whichever protocol
// era the client opens with. The model list above stays shared.
serveStdio(() => {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  server.registerTool(askGemini.name, askGemini.config, askGemini.handler);
  return server;
});
