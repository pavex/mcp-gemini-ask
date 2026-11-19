# mcp-gemini-ask

An MCP server with one tool, `ask_gemini(prompt)`: it sends the prompt to Google Gemini and returns the answer as text.

The server manages the Gemini models on its own. It finds the usable models, uses the best one available, and moves to the next one when a model is out of quota or fails. Everything it does with the models goes to the log (stderr); the agent only sees the answer, or an error that says whether and when to try again.

Built on `@modelcontextprotocol/server` 2.x (protocol up to `2025-11-25`), zod 4 and Node's built-in `fetch`. It is bundled into a single file, `dist/mcp.js`.

---

## Tool

### `ask_gemini`

| Parameter | Type | Description |
|---|---|---|
| `prompt` | string (required) | The question or instruction, with all the context Gemini needs (max `maxPromptChars`, default 200,000 characters) |

- **Success:** `content[0].text` is Gemini's answer.
- **Failure:** `isError: true`. The text is written for the agent and says what to do:
  - *temporarily unavailable* (per-minute quota, timeout, 5xx): try again in about N seconds/minutes, at most 2–3 times;
  - *daily quota used up*: do not retry before midnight UTC;
  - *refused to answer* (safety filter): retrying the same prompt will not help;
  - *request rejected* (HTTP 400, e.g. prompt too long), *API key rejected*, *no usable model*: retrying will not help.

Annotations: `readOnlyHint: true`, `openWorldHint: true`.

---

## How models are managed

The model list is kept in `<dataDir>/models.json` together with each model's status (quota, errors, today's success/failure counts), so it survives restarts.

**Refresh** = ListModels → name filter → one short probe call (`"Hi"`) per candidate → ranking:
- Name filter: only `gemini-<version>-…` models, minus those matching `excludeModels` (image, tts, audio, live, …).
- Probe: a model that answers 400/403/404 or is blocked is dropped. Quota, timeout or 5xx do not drop it: those concern availability, not the model type.
- Ranking: higher version first, then `pro` > `flash` > `flash-lite`; `-preview`/`-exp` only break ties.

**When the list is refreshed:**
- **No list yet** (first start, deleted `models.json`): at startup in the background; a call that comes before it finishes waits for it.
- **List older than `modelsTtlHours`** (default 24 h): in the background, at startup or on the next call. The old list keeps serving meanwhile.
- **Every model failed as unusable** (404, no access): the server refreshes the list and tries again, at most once every 10 minutes.

**Order of models in a call:** by rank, adjusted at runtime:
- models matching `deprioritizeModels` go last (e.g. `"pro"` on a free-tier key);
- a model failing many of today's (UTC) calls moves back;
- a model on quota is skipped without a call: per-minute quota for `Retry-After`, daily quota until midnight UTC;
- a model that answered 404/403 is skipped until the next refresh.

**Log** (stderr; the hub passes it to its terminal):

```
2026-11-19T13:09:21.013Z [gemini-ask] ask_gemini (5 chars)
2026-11-19T13:09:21.028Z [gemini-ask] Model list: 3 usable of 4 candidates (6 in catalog), 0.1 s
2026-11-19T13:09:21.028Z [gemini-ask]   1. gemini-3-pro [ok]
2026-11-19T13:09:21.044Z [gemini-ask]   gemini-3-pro: quota per minute, retry in 30 s
2026-11-19T13:09:21.047Z [gemini-ask]   gemini-3-flash: OK (1.4 s, 812 chars)
```

---

## Configuration

```
node dist/mcp.js [path/to/config.json]
```

The config path is absolute or relative to the working directory. Without it, `config.json` in the project root is used if it exists; otherwise everything takes its default and the key comes from `GEMINI_API_KEY`.

`config.example.json`:

```json
{
  "apiKey": "${GEMINI_API_KEY}",
  "dataDir": "data",
  "modelsTtlHours": 24,
  "fetchTimeoutMs": 60000,
  "maxPromptChars": 200000,
  "excludeModels": "image|tts|audio|live|computer-use|robotics|embedding",
  "deprioritizeModels": ""
}
```

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `GEMINI_API_KEY` env | Gemini API key ([Google AI Studio](https://aistudio.google.com/app/apikey)) |
| `dataDir` | `data` | Where `models.json` is stored. Relative paths are resolved against the directory of the config file. |
| `modelsTtlHours` | `24` | How old the model list may get before it is refreshed |
| `fetchTimeoutMs` | `60000` | Timeout of one request to Gemini |
| `maxPromptChars` | `200000` | Max prompt length |
| `excludeModels` | `image\|tts\|audio\|live\|computer-use\|robotics\|embedding` | Regex (case-insensitive); matching models are never candidates |
| `deprioritizeModels` | — | Regex; matching models are tried last |
| `baseUrl` | Gemini v1beta | API endpoint (the tests point it to a local fake) |

Strings may reference environment variables as `${NAME}` (`$${NAME}` stays literal). Unknown keys are rejected.

### Running it in the hub

```json
{
  "name": "gemini",
  "description": "Ask Google Gemini for a second opinion",
  "command": "node",
  "args": ["servers/gemini-ask/mcp.js", "servers/gemini-ask/config.json"],
  "env": { "GEMINI_API_KEY": "${safebox.GEMINI_API_KEY}" },
  "enabled": true
}
```

---

## Build and tests

```bash
./build.sh        # Linux / macOS
build.cmd         # Windows
```

The scripts install dependencies, build `dist/mcp.js`, run the tests, and remove `node_modules`. When `GEMINI_API_KEY` is set, they also run the live test.

```bash
npm run build                # dist/mcp.js
npm test                     # unit + integration (src and dist), no key, no network
node test/live.js [src|dist] # one real call; needs GEMINI_API_KEY, uses real quota
```

The integration tests run the server over stdio against `test/FakeGemini.js`, a local stand-in for the Gemini API. They cover discovery, fallback on quota, timeout and 5xx, restarts, refresh after TTL and after every model is gone, and error output. Set `VERBOSE=1` to see the server log.

---

## Project structure

```
src/
  mcp.js             entry point: config, model list, McpServer over stdio
  Config.js          config file, ${ENV} interpolation, validation
  Log.js             log lines to stderr
  GeminiAPI.js       REST calls: ListModels, generateContent, response classification
  GeminiModels.js    model list: refresh, ranking, order, TTL, models.json
  ModelCache.js      status per model: quota, errors, today's counts
  GeminiClient.js    askGemini(): fallback across models, message for the agent
  Tools/AskGemini.js the ask_gemini tool
test/
  unit.js            config, ranking, cache
  integration.js     the server over stdio against FakeGemini
  FakeGemini.js      local fake of the Gemini API
  live.js            one real call
```

---

## License

MIT
