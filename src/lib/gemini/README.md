# lib/gemini

The Gemini models to use and the calls to them: `GeminiApi` talks to the REST API, `GeminiModelList` finds the usable models itself, probes and ranks them, keeps what is known about each (quota, pause, unusable, today's failures) and says in which order to try them. It knows nothing of MCP or of the server that uses it.

Depends only on Node.js built-ins (`fetch`, `node:fs`, `node:path`).

## API

The public API is `index.ts`: `import { GeminiApi, GeminiModelList } from './lib/gemini'`. Files of the package import each other directly.

### `GeminiApi`

`new GeminiApi({ apiKey, baseUrl?, timeoutMs? })`, where `timeoutMs` (default 20 s) is the limit of a `generate()` call that gives none.

- `listModelIds(timeoutMs = 30 s): Promise<string[]>`: IDs of the models that support generateContent, without `models/`. Throws when the list can't be read (e.g. a wrong key: `ListModels HTTP 400 - API key not valid`).
- `generate(modelId, prompt, timeoutMs?): Promise<GenerateResult>`: one prompt to one model. Never throws; the result has a `kind` (`GenerateKind`):

| kind | when | fields |
|---|---|---|
| `Ok` | an answer (thoughts left out) | `text` |
| `Quota` | 429 | `period` (`QuotaPeriod.Minute` / `Day`), `retryAfterSec` |
| `NoAccess` | 401/403 | `status`, `message` |
| `Gone` | 404 | `status`, `message` |
| `Rejected` | 400 | `status`, `message` |
| `Unavailable` | 5xx, other HTTP errors | `status`, `message` |
| `Blocked` | safety filters | `reason` |
| `Timeout` | no complete answer in time (the limit covers the body too) | `message` |
| `Network` | no connection | `message` |

### `GeminiModelList`

`new GeminiModelList(api, options)`, all options optional (`GeminiModelListOptions`):

| Option | Default | |
|---|---|---|
| `storagePath` | none (memory only) | JSON file that keeps the list and the states |
| `models` | `[]` | a fixed list, best first: no discovery, no probing, no TTL |
| `include` / `exclude` | `null` | discovery keeps `gemini-*` IDs matching `include`, not `exclude` |
| `deprioritize` | `null` | matching models are tried last |
| `ttlMs` | 24 h | age at which a discovered list is refreshed |
| `probeTimeoutMs` | 10 s | limit of one probe call |
| `slowPauseMs` | 10 min | how long a model that did not answer in time is skipped |
| `log` | silent | `(message) => void` for refresh, probes and the order |

- `load()`: reads the storage file. A changed `include`/`exclude` filters the stored list at once and makes it stale.
- `ensure(): Promise<ListedModel[]>`: the models in the order to try. Waits for a refresh when there are none, otherwise refreshes a stale list in the background.
- `refresh(reason?)`: ListModels → filter → probe each candidate (8 at a time; 400/403/404/blocked drop it, the rest keep it) → rank → save. A refresh that runs is joined. Throws when the catalog can't be read.
- `refreshIfStale()`: the same in the background, failures only to the log.
- `ordered()`: rank, deprioritized last, today's failures further back.
- `isBlocked(id)`: skip now? (quota, pause, unusable; a quota or pause that ran out turns back to `Unknown`).
- `record(id, result)`: turns a `generate()` outcome into the model's state: `Ok`, quota until its time, `Timeout` → paused, `Gone`/`NoAccess` → unusable until the next refresh, anything else one more failure.
- `state(id): ModelState`, `save()`, `fixed`, `size`, `isStale()`, `refreshAgeMs()`, `isCandidate(id)`.

`scoreModelId(id)` is the ranking alone: newer version, then pro > flash > flash-lite, `-preview`/`-exp` as a tie-break, IDs without a version `-Infinity`.

## Example

```ts
import { GeminiApi, GeminiModelList, GenerateKind } from './lib/gemini'


const api = new GeminiApi({ apiKey: process.env.GEMINI_API_KEY! })
const list = new GeminiModelList(api, { storagePath: 'data/models.json', include: /flash/i, log: console.error })
list.load()

async function ask(prompt: string): Promise<string | undefined> {
    for (const { id } of await list.ensure()) {
        if (list.isBlocked(id)) {
            continue
        }
        const result = await api.generate(id, prompt)
        list.record(id, result)
        if (result.kind === GenerateKind.Ok) {
            list.save()
            return result.text
        }
    }
    list.save()
    return undefined
}
```

## What it does not do

- No overall time limit or message for a user: the caller decides how long a question may take and what to say when no model answers (the server's `GeminiAsk`).
- No conversations, system instructions, streaming or files: one text prompt, one text answer.
- One process per storage file: two processes writing the same `models.json` overwrite each other's states.
