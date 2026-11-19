// Log.js — diagnostic output. stdout carries the MCP protocol, so everything
// goes to stderr; the hub passes it through to its terminal.

export function log(message) {
  console.error(`${new Date().toISOString()} [gemini-ask] ${message}`);
}
