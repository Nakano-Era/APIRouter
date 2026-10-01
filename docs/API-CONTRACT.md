# API contract

This document describes the HTTP API implemented by `server/app.mjs`, `server/provider-tools.mjs`, `server/work.mjs`, and `server/billing.mjs`. Paths below include the `/api` prefix. JSON object examples describe fields; a `?` suffix means optional. Downloads and server-sent events (SSE) are exceptions to JSON responses.

## Authentication and common behavior

- Sessions use the HttpOnly, SameSite=Strict `apirouter_session` cookie. Browser requests use same-origin credentials.
- Authenticated mutations require `X-CSRF-Token`, obtained from the session response. Setup, login, invitation acceptance, and the separately verified Stripe webhook are exceptions. Cross-origin mutations are rejected.
- Ordinary chat, uploaded-file and Work-artifact endpoints are isolated by owner, including for administrators. The separate administrator export can export all users’ chat text and file metadata, but not attachment/artifact binary bodies.
- `/api/admin/*` requires the `admin` role. Skill mutations also require that role although their paths begin with `/api/work/skills`.
- Errors normally return an appropriate 4xx/5xx status and `{error: string, code?: string}`. A completed administrator model probe returns HTTP 200 with `ok:false` when the upstream probe failed. A balance query can return HTTP 200 with `available:false`.
- API responses have `Cache-Control: no-store`; streaming responses use `no-cache, no-transform`. Clients must not persist API keys or password fields in local storage.
- Normal JSON bodies have a 1 MB limit. Chat generation/edit envelopes allow large text subject to the 32 MB message/history safety limits. Provider parse/import request envelopes have an 8 MB limit; pasted configuration text still has its own 2 MB limit. Multipart upload limits are separate.

`User`:

```text
{id, name, email, role:'admin'|'user', disabled:boolean,
 dailyLimit:number|null, createdAt}
```

`Session` is `{user: User|null, needsSetup:boolean, csrfToken?:string}`.

| Method and path | Input | Response |
| --- | --- | --- |
| GET `/api/health` | — | `{ok:true}` |
| GET `/api/auth/session` | — | `Session` |
| POST `/api/auth/setup` | `{setupToken,name,email,password}` | `Session`, 201 |
| POST `/api/auth/login` | `{email,password}` | `Session` |
| POST `/api/auth/logout` | — | `{ok:true}` |
| POST `/api/auth/password` | `{currentPassword,newPassword}` | `{ok:true}` |
| GET `/api/auth/invite?token=...` | Invitation token | `{email,expiresAt}` |
| POST `/api/auth/invite/accept` | `{token,name,email,password}` | `Session`, 201 |

The setup token is shown in the server startup output and is never exposed by a GET endpoint. Passwords must be 12–256 characters; user names have a 60-character limit. Invitation URLs may carry `?invite=...` for the frontend.

## Public models and channel privacy

`GET /api/models` returns `{models:PublicModel[],defaultModelId:string|null}`. Models are filtered by the user's effective plan. There are no built-in demonstration models or simulated production replies.

```text
PublicModel = {
  id, name, modelId, routeKey, variantName,
  vision:boolean, enabled:true, status:'untested'|'ok'|'error',
  modes:('chat'|'work')[], reasoningEfforts:string[],
  contextWindow:number|null
}
```

An administrator-defined `routeKey` is the parent model name; `variantName` identifies its version (empty string means default). Stable IDs use `r_<hash>` for default versions and `v_<hash>` for named versions. Each record is one version; clients group these under the parent, then offer version and effort selection. Only channels matching both parent and version can fail over to one another. This endpoint does not expose provider IDs, provider names, base URLs, channel counts, credentials, or the actual upstream model selected for a response. `Message` likewise omits `sourceProvider` and `sourceModel`.

`reasoningEfforts` always includes `auto`, followed by configured levels supported by at least one enabled channel. Other accepted levels are `low`, `medium`, `high`, `xhigh`, and `max`. Advertised levels are administrator configuration, not a guarantee that an upstream accepts them. A request filters candidate channels by its chosen effort and mode. Unsupported combinations fail before generation.

`modes` includes `work` when the sandbox runner is configured. Native Work accepts any of the three supported API protocols; actual tool calling still depends on the upstream. Check `/api/work/capabilities` as well: configured does not mean Docker is healthy or Work is currently enabled. Legacy internal model IDs are accepted for existing integrations, but new clients should use public route IDs.

Capacity metadata can be null when unknown; it is not inferred from a display name. Public route capacities summarize enabled channels and do not guarantee every channel has the same limits. The full history is retained instead of silently truncating to 300 messages. Declared context limits guide candidate selection using an approximate estimate, with the upstream enforcing the actual tokenizer/model limit; unknown metadata does not impose a guessed context ceiling. Independent 32 MB text/transport safety limits remain enforced.

## Chats, messages, and uploads

```text
Chat = {id,title,modelId,mode:'chat'|'work',effort,skillIds:string[],
        webSearch:boolean,pinned:boolean,archived:boolean,createdAt,updatedAt}
Message = {id,role:'user'|'assistant',content,reasoning:string,modelId,createdAt,
           status:'complete'|'streaming'|'error'|'stopped',
           attachments:Attachment[],error:string|null}
Attachment = {id,name,mime,size,kind:'image'|'text',url}
```

Execution fields accepted when creating, updating, or generating a chat:

```text
{mode?:'chat'|'work', effort?:'auto'|'low'|'medium'|'high'|'xhigh'|'max',
 skillIds?:string[], webSearch?:boolean}
```

Defaults are `chat`, `auto`, `[]`, and `false`; generation otherwise inherits saved chat settings. At most 10 skill IDs can be selected through the chat API. Choosing Chat clears skill selection and disables search. Updating an active chat requires stopping its current reply first.

| Method and path | Input | Response |
| --- | --- | --- |
| GET `/api/chats` | — | `{chats:Chat[]}` |
| POST `/api/chats` | `{modelId?,title?,...execution}` | `{chat}`, 201 |
| GET `/api/chats/:id` | — | `{chat,messages:Message[]}` |
| PATCH `/api/chats/:id` | `{title?,pinned?,archived?,modelId?,...execution}` | `{chat}` |
| DELETE `/api/chats/:id` | — | `{ok:true}` |
| POST `/api/chats/:id/messages` | `{content,modelId?,attachmentIds?:string[],...execution}` | SSE |
| POST `/api/chats/:id/regenerate` | `{modelId?,...execution}` | SSE |
| POST `/api/chats/:id/continue` | `{messageId?,modelId?,...execution}` | SSE appended to the last assistant message |
| POST `/api/chats/:id/edit` | `{messageId,content,modelId?,attachmentIds?:string[],...execution}` | SSE |
| POST `/api/chats/:id/stop` | — | `{ok:true}` |
| POST `/api/files` | Multipart field `files` | `{files:Attachment[]}` |
| GET `/api/files/:id/download` | — | Authenticated file body |
| DELETE `/api/files/:id` | — | `{ok:true}` |

Editing replaces the selected user message and removes all later messages. Regeneration removes messages after the most recent user message and generates again. Clients should make this consequence clear before an edit. Chat deletion also deletes its Work artifacts and releases unreferenced upload attachments.

Continuation retains the last assistant message ID and existing text, adds the saved reply and continuation instruction to a new provider request, and appends new deltas. The optional `messageId` must match the last assistant message. Sending a standalone recognized continuation request such as `继续` or `continue`, without attachments, is routed to the same behavior. It works for failed, stopped, or completed tail replies. Earlier replies and active replies cannot be resumed directly. A sufficiently long exact prefix overlap is removed; semantic repetition cannot be reliably deduplicated. Each continuation is a new generation request and consumes normal quota/upstream usage.

Displayed deltas are saved before emission, including when a connection fails or the application restarts. This does not restore tokens the server never received or an upstream model's hidden session state. Native Work additionally uses owned, encrypted tool checkpoints; completed calls are not replayed, while interrupted calls with uncertain outcomes are returned to the model for inspection. The checkpoint's upstream model ID and protocol must remain compatible. CLI Work resumes only visible conversation and saved output files.

By default, a user can generate in four distinct chats at once (`MAX_CONCURRENT_PER_USER`, 1–32), subject to the global limit of ten (`MAX_CONCURRENT_CHATS`). Each chat permits one active generation; another request for the same chat is rejected until it finishes or stops. The Work runner has a separate default limit of two concurrent sandboxes.

Uploads accept PNG/JPEG/WebP/GIF images, UTF-8 text/code, text PDFs, DOCX text, and XLSX cells. Limits are 10 MB per file and five files per request. PDF OCR, Office macros, and spreadsheet formula execution are not provided by upload parsing. Upload storage is limited to 200 MB and 500 files per user. See the deployment documentation for parsing boundaries.

### SSE events

A streaming request may first fail with ordinary JSON before SSE headers are sent. Once streaming begins, parse the named events below; do not assume each network chunk is a complete event.

| Event | JSON data | Meaning |
| --- | --- | --- |
| `meta` | `{userMessage?:Message,assistantMessage:Message,chat:Chat}` | Saved conversation and initial reply |
| `delta` | `{text:string}` | Append visible assistant text |
| `reasoning` | `{text:string}` | Append provider-marked reasoning/summary or commentary to the separate, collapsed process panel |
| `routing` | `{message:string}` | Generic reconnect/retry notice, without channel identity |
| `activity` | `{label:string}` | Work tool activity such as writing a file or delegating a task |
| `artifact` | `{artifact:WorkArtifact}` | A file was actually saved and is available to download |
| `done` | `{message:Message}` | Final saved reply, including `stopped` replies |
| `error` | `{error:string,message?:Message}` | Failed reply with any partial content |

SSE comment heartbeats are sent while waiting. Browser disconnects abort generation; explicit stop is also supported. Activity labels do not contain tool arguments, credential values, or private chain-of-thought. Ordinary users receive generic generation errors; administrators inspect detailed failures through the administrator endpoints below.

`content` and `reasoning` are journaled separately before emission and recovered independently after interruption or restart. Existing messages receive an empty `reasoning` field; old unmarked text is not reclassified. Clients default the process panel to collapsed. Copying and ordinary single-chat export use `content` only; administrator full-chat exports include reasoning separately. Ordinary conversation history excludes the display-only reasoning field; native Work checkpoints retain protocol-required signed blocks separately.

Recognized process output includes Chat `reasoning_content`/`reasoning`, Anthropic thinking, Responses reasoning summaries and explicit `phase:commentary`, and Claude Code thinking events. Opaque signatures, redacted thinking and encrypted content are not displayed. A leading `<think>` or `<thinking>` block is also recognized across text chunk boundaries; quoted code examples and unmarked prose are left intact. Codex-compatible Responses may wait for an item's phase before displaying that item; ordinary Responses without phases continue to stream. Unclassified text is preserved as answer text if a stream ends before declaring a phase. The combined persisted answer and process have a 32 MB safety limit.

Chat with a direct API channel calls its selected protocol. Chat with a `claude-code` channel uses the optional CLI runner with tools disabled. Work with `runtime:'api'` uses the native API tool engine inside Docker; Work with `runtime:'claude-code'` uses the separately installed optional CLI image and requires Anthropic protocol. Work artifacts and activities have their own events; writing code in a text reply alone does not create a downloadable file.

## Administrator connections and models

`Provider` returned by list/create/update contains:

```text
{id,name,baseUrl,protocol:'openai-chat'|'openai-responses'|'anthropic',
 runtime:'api'|'claude-code',responsesProfile:'auto'|'standard'|'codex',enabled,hasKey,keyHint,lastSyncedAt,lastSyncError,
 createdAt,priority,failureProtectionEnabled,failureThreshold,cooldownSeconds,authMode}
```

Ordinary provider CRUD responses never contain the full saved API key. Parse previews echo only the submitted configuration to an administrator; authenticated export is the explicit exception for saved keys.

| Method and path | Input | Response |
| --- | --- | --- |
| GET `/api/admin/providers` | — | `{providers:Provider[]}` |
| POST `/api/admin/providers` | `{name,baseUrl,protocol,apiKey,enabled?,runtime?,responsesProfile?,authMode?,priority?,failureThreshold?,cooldownSeconds?}` | `{provider}`, 201 |
| PATCH `/api/admin/providers/:id` | Optional create fields | `{provider}` |
| DELETE `/api/admin/providers/:id` | — | `{ok:true}` |
| POST `/api/admin/providers/:id/sync` | — | `{models:AdminModel[],count:number}` |
| GET `/api/admin/models` | — | `{models:AdminModel[],defaultModelId}` |
| POST `/api/admin/models` | `{providerId,modelId,name?,routeKey?,vision?,reasoningEfforts?,contextWindow?,maxOutputTokens?}` | `{model}`, 201 |
| PATCH `/api/admin/models/:id` | `{name?,routeKey?,enabled?,vision?,reasoningEfforts?,contextWindow?,maxOutputTokens?,isDefault?}` | `{model}` |
| DELETE `/api/admin/models/:id` | — | `{ok:true}` |
| POST `/api/admin/models/:id/test` | — | `{ok:boolean,latencyMs:number,error?:string,diagnostic?:object}` |
| POST `/api/admin/models/:id/reset-health` | — | `{model}` |

An empty `apiKey` in PATCH preserves the saved key. Allowed authentication modes are `auto`, `bearer`, and `x-api-key`. `claude-code` requires `anthropic` protocol and a configured runner. API base URLs must be public HTTPS addresses without embedded credentials, query strings, or fragments. A loopback-only exception exists for explicitly enabled local tests.

`responsesProfile` selects Responses request compatibility. `auto` uses Codex-compatible requests for `anyrouter.top` and standard requests for ordinary providers; `standard` and `codex` explicitly override that choice. Chat and native Work share this adapter. It adjusts request shape and compatible headers, includes encrypted reasoning content, disables remote storage, and streams with explicit instructions. It does not install or run Codex CLI and does not guarantee access for a provider-restricted key. Codex-compatible requests omit `max_output_tokens`, so the upstream's default determines the individual response limit; standard Responses continues to send the configured budget. Claude-specific access uses the separate Anthropic/Claude Code path instead.

`AdminModel` is a channel record with `{id,providerId,providerName,modelId,name,routeKey,reasoningEfforts,contextWindow,maxOutputTokens,enabled,vision,available,status,lastCheckedAt,error,failureCount,cooldownUntil}`. Its ID is the database model ID, and its `modelId` is the exact upstream model name. The model page groups these records by `routeKey`; the API still returns the individual channel records.

`contextWindow` is null or 1024–10000000 tokens; model `maxOutputTokens` is null or 128–1000000 tokens. These describe provider capabilities, distinct from the workspace's chosen per-request output budget. Synchronization reads capacity metadata where provided, fills missing values, and preserves existing administrator values; null clears a manual value. Unknown limits are left null instead of guessed.

Sync queries the upstream's actual model list, preserves existing administrator choices, disables new records pending selection, and marks disappeared non-manual records unavailable. Manual records remain available and are enabled on creation. A test performs a small real generation and can consume upstream credits; it does not test the entire Work toolchain. Stored `reasoningEfforts` contains the explicit non-`auto` levels; an empty array permits only automatic effort.

### Routing and original failure diagnostics

Provider defaults and ranges: priority 0 (0–1000), failure protection enabled, failure threshold 3 (1–1000), cooldown 60 seconds (1–2592000). Provider create/PATCH accepts `failureProtectionEnabled:boolean`. Each model create/PATCH accepts `variantName` (up to 100 characters) and nullable `failureProtectionEnabled`, `failureThreshold`, `cooldownSeconds` overrides (null inherits the provider); administrator model JSON returns those fields. Disabling protection stops temporary disabling but retains retries, switching and logs. Policy changes reset health counters. Workspace routing defaults are six total attempts (1–10) and one extra attempt on the same channel (0–3). Only channels within the same parent model and version are candidates. Invalid payloads are not retried across paid providers. Failover stops after visible response text or a committed Work tool action/artifact, preventing duplicate execution.

`GET /api/admin/routing-logs` returns the newest 200 attempts:

```text
{attempts:[{id,requestId,providerName,modelId,
 outcome:'running'|'complete'|'error'|'stopped',error,createdAt,hasDetail:boolean}]}
```

`GET /api/admin/routing-logs/:id/detail` returns `{detail:object}` or 404 if the original diagnostic is absent or has been removed. Detail is administrator-only, encrypted in the database, and never included in ordinary chat responses. Completed logs are pruned to a recent bounded history; in-flight attempts are retained until completion.

Details can contain HTTP status, method, request URL, protocol, model ID, selected response headers, response body, `truncated`, and `readNote`; runner errors may have runtime-specific fields. Known API credentials are redacted. This preserves the original error text where available, including HTML as inert text, but is not an unlimited byte-for-byte packet capture: direct upstream error reads are capped at 1 MB and two seconds. An early-ended SSE error body or oversized body is marked accordingly. Never render a diagnostic body as executable HTML.

Administrator model test responses may contain `diagnostic` with a structured explanation and `raw` detail. When raw details are available, the failed probe also creates an encrypted routing-log entry. Model status/errors contain only the safe summary. A successful test clears model failure/cooldown state.

## Provider paste, backup, and balance

All endpoints in this section require administrator authentication; mutations also require CSRF. Parse/import/balance mutations share a 20-per-minute limiter. Export has a separate five-per-15-minutes verification limit, in addition to the general API limiter.

### Parse and import

`POST /api/admin/providers/parse` accepts `{text:string,password?:string}` and returns `{providers:ImportProvider[],warnings:string[]}`. Parsing is local to the application server: it performs no upstream request and saves nothing.

Accepted text formats include:

```json
{"_type":"newapi_channel_conn","key":"sk-XXX","url":"https://xxx.com"}
```

Also supported: an array of connection objects; OpenAI or Anthropic environment-variable assignments; Claude Code `{env:{...}}` settings; one unambiguous URL plus an `sk-...` key; and plain or encrypted APIRouter exports. Conflicting keys/URLs, malformed JSON, unsupported formats, and invalid addresses are rejected without echoing credentials in errors. The AnyRouter hostname suggests Anthropic/Bearer/Claude Code defaults in the editable preview; this is not a connectivity test.

```text
ImportProvider = {
 name,baseUrl,apiKey,protocol,runtime,authMode,enabled,
 priority,failureThreshold,cooldownSeconds,
 balanceAdapter:'none'|'newapi'|'openai-compatible',
 models:[{modelId,name,routeKey,enabled,vision,manual,available,reasoningEfforts}]
}
```

`POST /api/admin/providers/import` accepts `{providers:ImportProvider[]}` and returns `{added,skipped,modelsAdded}`. The whole batch is validated before a transaction. Duplicate normalized URL/key/protocol combinations are skipped, including duplicates within the submitted batch; existing connections are not overwritten. Keys are encrypted for storage. Model mappings are restored with untested health state. Limits: 1–100 providers, up to 5000 model mappings per provider and 10000 per batch. Large backups must fit these import limits.

### Save all connections locally

`POST /api/admin/providers/export` accepts:

```text
{format:'plain'|'encrypted',currentPassword:string,password?:string}
```

`currentPassword` verifies the currently logged-in administrator before any saved keys are returned. `password` is the backup passphrase for encrypted exports and must be 12–1024 characters. Incorrect reauthentication returns 403. Responses are JSON attachments with `Cache-Control: no-store`; the browser UI saves them as a local download.

Plain exports have `{_type:'apirouter_provider_export',version:1,encrypted:false,exportedAt,providers:[...]}` and include complete API keys, provider configuration, balance adapter choices, and model mappings. They do not include users, conversations, billing credentials, or transient balance/error history.

Encrypted exports have the same `_type` and version, `encrypted:true`, and a versioned envelope containing `kdf` and `cipher` fields. The implementation uses scrypt (`N=32768,r=8,p=1`, random salt) and AES-256-GCM with a random nonce and authentication tag. Decryption accepts only the supported fixed parameters. Supply the encrypted file text and backup password to `/parse`, review the result, then call `/import` to restore it. Lost passphrases cannot be recovered by the server.

### Balance adapters

`GET /api/admin/providers/:id/balance` returns `{adapter,balance:Balance|null}` from cache without contacting the upstream.

`POST /api/admin/providers/:id/balance` accepts `{adapter:'none'|'newapi'|'openai-compatible',refresh?:boolean}`. It saves the choice; only `refresh:true` requests a balance. Selecting `none` never sends an upstream query. Concurrent queries for the same provider are rejected. A changed base URL or key invalidates cached results.

```text
Balance = {available:boolean,adapter,checkedAt,message,
 remaining?:number|null,used?:number,granted?:number,unit?:string,
 unlimited?:boolean,expiresAt?:string|null,modelLimits?:string[],
 periodStart?:string,upstreamStatus?:number}
```

The explicit `newapi` adapter queries the fixed `/api/usage/token/` endpoint using the saved key in a Bearer header. A configured reverse-proxy path prefix is preserved. It returns raw token quota (`unit:'quota'`), with `remaining:null` for unlimited quota. Token quota is not necessarily the account cash balance. See the [New API token usage contract](https://doc.newapi.pro/en/api/token-usage/).

The explicit `openai-compatible` adapter queries the fixed legacy `/dashboard/billing/subscription` and `/dashboard/billing/usage` paths, using the current UTC month's start and the next UTC date for the usage query. It computes `hard_limit_usd - total_usage / 100`, but labels the result `provider-units`: compatible gateways can use their own display unit and accounting period, despite the historical field names. See the [New API billing implementation](https://github.com/QuantumNous/new-api/blob/main/controller/billing.go).

Only the configured provider origin and service prefix are used. URLs are DNS-checked and pinned; private/reserved destinations and redirects are rejected. No arbitrary balance URL can be supplied. Unsupported, inaccessible, or malformed responses produce `available:false` with an explanation, not a fabricated zero balance. Clients should offer manual refresh and display the query timestamp.

## Work capabilities, skills, and artifacts

`GET /api/work/capabilities` requires a session and returns:

```text
{available:boolean,reason:string|null,runtime:'sandbox',
 engines?:{native:boolean,'claude-code':boolean},skills:Skill[],
 tools:string[],webSearchSupported:true,webSearchNote:string,limits:WorkSettings}
```

`available` checks configuration, the administrator's enabled flag, and runner health; health is briefly cached. `engines`, when returned by runner health, distinguishes the default native sandbox from the separately installed optional CLI image. The `webSearchSupported` flag means the integration offers a search option: native search uses Anthropic or Responses server tools; Chat Completions has no standard built-in search. Actual availability depends on the selected upstream channel and model. It is not a general-purpose unrestricted browser API.

`Skill` is `{id,name,description,createdAt,updatedAt,content?:string}`. Skills are workspace-wide administrator-managed Markdown instructions, not arbitrary installed application plugins.

| Method and path | Access / input | Response |
| --- | --- | --- |
| GET `/api/work/skills` | Signed in | `{skills:Skill[]}`; full content only for admins in this list |
| POST `/api/work/skills` | Admin; `{name?,description?,content?,url?}` | `{skill}`, 201 |
| PATCH `/api/work/skills/:id` | Admin; same optional fields | `{skill}` |
| DELETE `/api/work/skills/:id` | Admin | `{ok:true}` |
| GET `/api/work/skills/:id/download` | Signed in | Markdown attachment named `<name>-SKILL.md` |
| GET `/api/work/chats/:id/artifacts` | Chat owner | `{artifacts:WorkArtifact[]}` |
| GET `/api/work/artifacts/:id/download` | Artifact owner | File attachment |
| GET `/api/work/chats/:chatId/artifacts/:id/download` | Chat and artifact owner | File attachment scoped to this chat |
| GET `/api/work/chats/:id/artifacts/download?path=...` | Chat owner; optional saved directory prefix | ZIP of saved files, preserving paths; 30 MB total |
| GET `/api/admin/work/settings` | Admin | Work status, settings, and bounds |
| PATCH `/api/admin/work/settings` | Admin; partial `WorkSettings` | Updated status, settings, and bounds |

A skill can be submitted as Markdown or downloaded from a final public HTTPS raw-file URL. Metadata may be read from front matter and explicitly overridden. Skill names use 1–64 lowercase letters, digits, and hyphens; descriptions have a 500-character limit; content is limited to 64 KB; at most 32 skills are installed. URL imports reject private addresses, redirects, and HTML pages. Imports rebuild front matter and reject dynamic `!` plus backtick command syntax; they do not install hooks, MCP servers, executable packages, or referenced auxiliary files.

`WorkArtifact` is `{id,chatId,path,name,size,mime,createdAt,downloadUrl}`. The runner must actually create a file under its output directory before the server stores and exposes an artifact. Downloads use attachment disposition and restrictive response headers; HTML/SVG content is not executed by the artifact endpoint. A task can return up to 30 files, 10 MB each and 30 MB total. Saved Work artifact storage is separately limited to 500 files and 200 MB per user. Replacing an output path in the same chat replaces its saved artifact. Deleting that chat deletes its saved artifacts.

Work settings responses are `{configured,...capabilities,settings:WorkSettings,limits:Bounds}`. Here `limits` contains bounds, overriding the current-value `limits` field used by the capabilities endpoint. Runner URL and authentication token are deployment configuration, not browser-editable fields.

| Work setting | Default | Accepted range |
| --- | --- | --- |
| `enabled` | `true` | Boolean |
| `maxTurns` | 20 | 1–80 |
| `timeoutSeconds` | 600 | 30–1800 |
| `memoryMb` | 768 | 512–4096 |
| `cpus` | 1 | 0.25–4 |
| `maxBudgetUsd` | 2 | 0.1–20 |
| `maxConcurrentJobs` | 2 | 1–4 |

Unknown settings are rejected. `maxBudgetUsd` applies only to the optional Claude Code execution budget; native execution enforces rounds/output/time/resources rather than an inferred USD amount. Neither is a prepaid balance reservation or a guarantee about third-party billing. The application's outer streaming deadline uses the configured runner timeout plus 60 seconds for runner-backed requests. Direct API requests use a default one-hour outer limit (`CHAT_TIMEOUT_SECONDS`, 60–21600 seconds) and an independent inactivity timeout (`UPSTREAM_TIMEOUT_MS`, default 180000 ms) refreshed by received data. Work job submission is integrated into chat generation; there is no public standalone `/jobs` API or durable background-task API. See [WORK.md](WORK.md) for runner deployment and sandbox boundaries.

## Workspace settings, users, and invitations

`GET /api/settings` returns `{settings}`. Non-admin responses omit `systemPrompt`. Workspace settings include `siteName`, `defaultModelId`, `dailyLimit`, `maxOutputTokens`, `routingMaxAttempts`, and `retriesPerChannel`; stored `workSettings` can also appear. Billing secrets and provider keys are not stored in these public settings.

`PATCH /api/admin/settings` accepts workspace fields above plus `systemPrompt`; use the dedicated Work endpoint to modify runner limits. `siteName` has a 40-character limit, `systemPrompt` 20000 characters, daily quota 0–100000 (zero disables new requests), and direct-API output limit 128–32768. Chat titles have a 120-character limit.

| Method and path | Input | Response |
| --- | --- | --- |
| GET `/api/admin/users` | — | `{users:User[]}` |
| PATCH `/api/admin/users/:id` | `{disabled?,dailyLimit?:number|null}` | `{user}` |
| GET `/api/admin/invites` | — | `{invites:[{id,email,expiresAt,usedAt,createdAt}]}` |
| POST `/api/admin/invites` | `{email?,days?:number}` | `{invite:{id,token,expiresAt}}`, 201 |
| DELETE `/api/admin/invites/:id` | — | `{ok:true}` |
| GET `/api/admin/stats` | — | `{users,chats,messages,requestsToday}` |

Invitation validity is 1–30 days, default seven. Administrators cannot be disabled through the user endpoint. Disabling a member ends their sessions and active requests. Explicit daily limits override membership; `dailyLimit:null` restores plan/free limits.

## Membership and billing

`GET /api/billing` returns `{plans,freePlan,membership,requests,paymentMethods:{stripe,manual},canManageSubscription,canRequestManual,effectiveDailyLimit}`. Membership is null when expired. Plans contain `{id,name,description,priceCents,currency,interval,dailyLimit,allowedRoutes,active,allowStripe,allowManual,sortOrder}`; currency is USD/CNY/EUR/HKD, interval is month/year, and `allowedRoutes` contains route keys (empty means all). Administrators bypass model restrictions but not quota.

- POST `/api/billing/requests` `{planId,note?}` returns `{request}`. Only one pending request per user; the sole enabled administrator cannot submit an application requiring their own approval.
- POST `/api/billing/checkout` `{planId}` and `/api/billing/portal` return `{url}`. The server chooses prices and validates official Stripe destinations.
- GET/POST `/api/admin/plans` and PATCH `/api/admin/plans/:id` manage plans. Existing purchase/application terms are snapshots; disable plans rather than deleting purchase history.
- GET `/api/admin/billing/requests`; POST `/api/admin/billing/requests/:id/review` `{decision:'approve'|'reject',note?}` returns `{request}`. Self-review and duplicate approvals are rejected.
- GET/PATCH `/api/admin/billing/settings` uses `{stripeEnabled,freeAllowedRoutes,secretKey?,webhookSecret?}`. GET exposes only key hints/presence flags and the webhook URL; blank keys preserve saved secrets.
- POST `/api/billing/webhook` accepts raw JSON with Stripe-Signature verification before session/CSRF middleware. Supported events include checkout completion/async payment success, subscription created/updated/deleted, and invoice paid/payment failed. Browser redirects never grant access.

See [MEMBERSHIP.md](MEMBERSHIP.md) for deployment and subscription lifecycle details.

## Model catalog and versions

- GET `/api/admin/model-groups` returns `{groups:[{name,variants:[{name,modelIds:string[]}]}]}`, including empty drafts.
- PUT `/api/admin/model-groups` accepts one `{name,variants}` and atomically replaces that parent's mapping. Names are up to 300 characters, at most 100 unique versions per parent and 500 channel records per version. Each upstream record belongs to one version. Selected records become enabled and move to the target parent/version; removed records are disabled and retained with their mapping reset. Empty drafts are excluded from public choices. Involved providers must be idle.
- Channel-level model endpoints remain available. Provider backups retain assigned version mappings and failure overrides; empty catalog drafts and user quotas require a full data backup.

## Per-user, per-version quota

GET and PUT `/api/admin/users/:id/model-limits` require admin access; PUT requires CSRF and atomically replaces `{limits:[{routeKey,variantName,dailyLimit,monthlyLimit}]}` (maximum 500 rules). Variant names are strings, with `''` as the default; legacy incoming null is an alias for `''`, never a shared family rule. Limits are integers 0–1000000000 or null: zero blocks use, null leaves that dimension unlimited.

Both return `{limits:[{routeKey,variantName,dailyLimit,monthlyLimit,usedToday,usedMonth,updatedAt}],timeZone:'Asia/Taipei',resetsAt:{daily,monthly}}`. Versions count independently. Multiple channels inside one version share its counter. Existing account/plan total limits still apply separately. Model/version usage is snapshotted on accepted requests so later channel remapping does not rewrite historical use. Failed/stopped requests count, continuation/regeneration reserve one new request, and internal routing retries do not reserve again. The quota check and reservation are in the same SQLite transaction before history mutation. Errors use `USER_MODEL_DISABLED` (403), `USER_MODEL_DAILY_LIMIT` or `USER_MODEL_MONTHLY_LIMIT` (429).

Day/month boundaries use UTC+8 natural calendar periods; account/plan aggregate daily limits retain UTC boundaries. Existing legacy family rules migrate into independent rules for each existing version, with explicitly configured version rules taking precedence.

## Administrator chat archive

GET `/api/admin/chats/export?format=json|markdown` requires an administrator and returns an attachment ZIP with no-store caching. Default format is JSON. It contains a manifest, user records and every user's chats including archived chats, with messages, separate reasoning, active journal chunks and file metadata. It omits attachment/artifact binary data, service credentials, password hashes and payment configuration; user-written message content is retained. Files are organized by user/chat ID. A dedicated read-only database snapshot keeps an export consistent while writes continue; at most two exports run concurrently (429 when busy). This is a reading/archive export, not a complete application restore backup.

