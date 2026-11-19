# mcp-gemini-ask

An MCP server with one tool, `ask_gemini(prompt)`: it sends the prompt to Google Gemini and returns the answer as text.

The server manages the Gemini models on its own. It finds the usable models, uses the best one available, and moves to the next one when a model is out of quota, overloaded or silent. Everything it does with the models goes to the log (stderr); the agent sees only the answer, or an error that says whether and when to try again.

TypeScript, built with esbuild into a single file, `dist/mcp.js`, that needs only Node.js 22+. Built on the MCP SDK `@modelcontextprotocol/server` 2.x (protocol up to `2025-11-25`) and zod. The model handling is a separate package, [`src/lib/gemini`](src/lib/gemini/README.md), usable elsewhere too.

---

## Tool

### `ask_gemini`

| Parameter | Type | Description |
|---|---|---|
| `prompt` | string (required) | The question or instruction, with all the context Gemini needs (max `maxPromptChars`, default 200,000 characters) |

- **Success:** `content[0].text` is Gemini's answer.
- **Failure:** `isError: true`. The text is written for the agent and says what to do:
  - *temporarily unavailable* (per-minute quota, 503, timeout, time limit): try again in about N seconds/minutes, at most 2–3 times;
  - *getting ready* (the first model list is still being prepared): try again in about 30 s;
  - *daily quota used up*: do not retry before midnight UTC;
  - *refused to answer* (safety filter): retrying the same prompt will not help;
  - *request rejected* (HTTP 400, e.g. prompt too long), *no usable model*, *list could not be loaded*: retrying will not help.

Annotations: `readOnlyHint: true`, `openWorldHint: true`.

---

## How models are managed

The model list is kept in `<dataDir>/models.json` together with each model's state (quota, pause, unusable, today's successes and failures), so it survives restarts.

**Your own list:** when `models` in the config is not empty, the server uses exactly those models, in that order: no discovery, no probing, no TTL. Fallback, quotas and pauses work as below.

**Otherwise the server finds the models itself.** Refresh = ListModels → name filter → one short probe call (`"Hi"`, 10 s limit, 8 at a time) per candidate → ranking:
- Name filter: `gemini-*` models matching `includeModels` (default `flash`: flash and flash-lite, the ones usable on the free tier) and not matching `excludeModels` (image, tts, audio, live, …).
- Probe: a model that answers 400/403/404 or is blocked is dropped; the log says why. Quota, 503, network errors or silence keep it (that is availability, not the model type), but it counts as a failure, so the model goes to the back. A model silent for 10 s is paused.
- Ranking: higher version first, then `pro` > `flash` > `flash-lite`; `-preview`/`-exp` only break ties; IDs without a version (`gemini-flash-latest`) last.

**When the list is refreshed:**
- **No list yet** (first start, deleted `models.json`): right at startup, in the background; a question that comes earlier waits for it as long as the time limit allows.
- **List older than `modelsTtlHours`** (default 24 h), **or `includeModels`/`excludeModels` changed:** in the background, at startup or on the next question. The stored list, filtered by the current settings, keeps serving meanwhile.
- **Every model is gone or without access** (404/403): the list is refreshed and the question tried again, at most once every 10 minutes.

**Order of models in a call:** by rank, adjusted at runtime:
- models matching `deprioritizeModels` go last;
- a model failing much of today's (UTC) calls moves back;
- skipped without a call: per-minute quota for its `Retry-After`, daily quota until midnight UTC, a model that did not answer in time for 10 minutes, a 404/403 model until the next refresh.

**Time limits:** one `ask_gemini` call ends within `timeoutMs` (default 25 s, below the 30 s request timeout common in MCP clients and gateways). One model gets at most `modelTimeoutMs` (default 20 s) of it. The limit covers the whole answer, so a model that sends headers and then stalls is cut off too. With fewer than 3 s left, no further model is started.

**Log** (stderr; stdout carries the MCP protocol):

```
2026-11-19T13:46:14.258Z [gemini-ask]   15 candidates of 50 in catalog: gemini-2.5-flash, ...
2026-11-19T13:46:15.173Z [gemini-ask]   probe gemini-3.5-flash: HTTP 503 This model is currently experiencing high demand. (0.9 s)
2026-11-19T13:46:24.625Z [gemini-ask] Model list: 15 usable of 15 candidates (50 in catalog), 10.6 s
2026-11-19T13:46:24.626Z [gemini-ask]   1. gemini-3.5-flash-lite [ok]
2026-11-19T13:46:24.627Z [gemini-ask]   8. gemini-3.8-flash [unknown, failed]
2026-11-19T13:46:29.971Z [gemini-ask]   gemini-3.5-flash-lite: OK (5.3 s, 2 chars)
```

---

## Configuration

```
node dist/mcp.js [path/to/config.json]
```

The path is absolute or relative to the working directory. Without it, `config.json` next to `mcp.js` is used when it exists; otherwise every key takes its default and the key comes from `GEMINI_API_KEY`. The build puts `config.example.json` next to `mcp.js`:

```json
{
  "apiKey": "${GEMINI_API_KEY}",
  "dataDir": "data",
  "models": [],
  "includeModels": "flash",
  "excludeModels": "image|tts|audio|live|computer-use|robotics|embedding",
  "deprioritizeModels": "",
  "modelsTtlHours": 24,
  "timeoutMs": 25000,
  "modelTimeoutMs": 20000,
  "maxPromptChars": 200000
}
```

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `GEMINI_API_KEY` env | Gemini API key ([Google AI Studio](https://aistudio.google.com/app/apikey)) |
| `dataDir` | `data` | Where `models.json` is kept, relative to the config file's folder |
| `models` | `[]` | Your own model IDs, best first, e.g. `["gemini-3-flash", "gemini-2.5-flash"]`. Not empty = discovery off. |
| `includeModels` | `flash` | Regex (case-insensitive); discovery keeps only matching models. `""` = all `gemini-*`, `"flash\|pro"` adds pro. |
| `excludeModels` | `image\|tts\|audio\|live\|computer-use\|robotics\|embedding` | Regex; matching models are never discovered |
| `deprioritizeModels` | `""` | Regex; matching models are tried last |
| `modelsTtlHours` | `24` | How old the discovered list may get before it is refreshed |
| `timeoutMs` | `25000` | Time limit of a whole `ask_gemini` call, fallbacks included |
| `modelTimeoutMs` | `20000` | Time limit of one model (at most `timeoutMs`) |
| `maxPromptChars` | `200000` | Max prompt length |
| `baseUrl` | Gemini v1beta | API endpoint (the tests point it to a local fake) |

Strings may hold `${NAME}`, an environment variable (`$${NAME}` stays literal). Unknown keys are rejected; an error names the key.

### In an MCP client

Any client that starts stdio servers takes it the usual way: `mcp.js` with its config next to it, the key in the environment.

```json
{
  "command": "node",
  "args": ["/path/to/gemini-ask/mcp.js", "/path/to/gemini-ask/config.json"],
  "env": { "GEMINI_API_KEY": "your-key" }
}
```

---

## Development

```bash
npm install
npm run build     # tsc --noEmit, then esbuild: dist/mcp.js + dist/config.example.json
npm test          # build, then node --test over test/**/*.test.ts (no key, no network)
npm run style     # brings src, test and scripts to the code style (-- --check only lists)
npm run live      # the built server against the real API; GEMINI_API_KEY from .env (git-ignored) or the environment; uses real quota
```

The tests are TypeScript and run from `test/` directly (`test/support/register.mjs`). They use `test/support/FakeGemini.ts`, a local stand-in for the Gemini API:

- `test/lib/gemini/`: the package (API outcomes, states, ranking, the list with discovery, storage, TTL and a fixed list);
- `test/config/`, `test/ask/`: the config and the fallback with its messages and time limits, without a process;
- `test/deployment/`: the built `dist/mcp.js` as a process over stdio, with a config file;
- `test/structure.test.ts`: the import boundaries and the build.

Code style: 4-space indent, no semicolons, `else` on a new line, one class per file with its parts in a folder of its name, `interfaces/` and `types/` folders, enums instead of string unions. `npm run style` applies the mechanical part.

---

## Project structure

```
src/
  main.ts                         entry: node mcp.js [config.json]
  Application.ts                  boot: config, model list, McpServer per stdio connection
  ApplicationContainer.ts         services: config, logger, GeminiApi, GeminiModelList, GeminiAsk
  Consts.ts                       server name and version, file names
  config/Config.ts                config file: ${NAME}, validation, paths
  log/Logger.ts                   log lines to stderr
  ask/GeminiAsk.ts                one question: fallback across models, time limits
  ask/GeminiAsk/FailureMessage.ts the message to the agent when no model answered
  tools/AskGeminiTool.ts          the ask_gemini tool
  lib/gemini/                     the package: GeminiApi, GeminiModelList (see its README)
test/                             as above
scripts/
  restyle.mjs                     code style (npm run style)
  live-check.mjs                  real round trip with dist/mcp.js
```

---

## License

MIT
