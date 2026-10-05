# API contract

This document describes the HTTP API implemented by `server/app.mjs` and its provider, Work, billing, announcement and user-routing modules. Paths below include the `/api` prefix. JSON object examples describe fields; a `?` suffix means optional. Downloads and server-sent events (SSE) are exceptions to JSON responses.

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
| GET `/api/auth/sessions` | — | `{sessions:LoginSession[]}` |
| DELETE `/api/auth/sessions/:id` | Opaque device-session ID | `{ok:true,current:boolean}` |
| POST `/api/auth/sessions/logout-others` | — | `{ok:true,revokedCount:number}` |
| GET `/api/auth/invite?token=...` | Invitation token | `{email,expiresAt}` |
| POST `/api/auth/invite/accept` | `{token,name,email,password}` | `Session`, 201 |

The setup token is shown in the server startup output and is never exposed by a GET endpoint. Passwords must be 12–256 characters; user names have a 60-character limit. Invitation URLs may carry `?invite=...` for the frontend.

`LoginSession` is `{id,deviceName,deviceType:'desktop'|'mobile'|'tablet'|'unknown',loginIp:string|null,geoLocation:string,createdAt,lastSeenAt,expiresAt:string|null,current:boolean}`. Device-management endpoints require authentication; mutations require CSRF. The list includes only the caller's valid sessions, with the current session first. IDs are random public identifiers, not authentication tokens or token hashes; raw user agents, CSRF secrets and cookie values are never returned in this list. Login IP, approximate GeoIP location and device type are snapshots taken at sign-in, not live tracking. Device names are coarse browser/OS labels and do not identify physical hardware. Recent activity updates at most once per minute. Legacy missing metadata is returned as `loginIp:null`, `geoLocation:'未记录'`, `deviceType:'unknown'`.

Administrators may also use `GET /api/admin/users/:id/sessions` to read `{sessions:LoginSession[]}` for a selected user. The endpoint requires the administrator role and returns only that user's valid sessions, never cookie values, token hashes or CSRF secrets. Missing users return 404; disabled users and users without active sessions return an empty list. `current` is true only for the requesting administrator's own current session. This read does not renew or touch the target user's sessions. The administrator UI exposes this read-only view under each member in “成员与邀请”; ordinary users cannot inspect other users' devices. These lists show current sessions rather than a permanent login audit history.

An account may hold multiple independent sessions with no server-side expiry (`expiresAt:null`). A one-time migration promotes still-valid old sessions; expired sessions are not revived. Browser cookies use a 400-day Max-Age and renew on authenticated activity at most once per day, preserving HttpOnly, SameSite=Strict and the deployment's Secure setting. Browser storage can still be cleared or expire independently. Signing in with an existing same-account cookie replaces only that browser session; other devices remain signed in. `/auth/logout` deletes only the current session and clears its cookie. Deleting a current session also clears its cookie; a missing or other-user ID returns 404. `logout-others` retains the caller's session and counts valid sessions removed. Password changes revoke other sessions; account disable revokes all of that account's sessions. Revocation blocks subsequent authenticated requests and does not cancel account-wide background tasks. Existing valid session cookies remain usable after migration; older unidentified sessions are labeled `原有设备`.

IP extraction uses Express's configured trusted-proxy result, normalizes IPv4/IPv6 and does not directly accept arbitrary `X-Forwarded-For` or `X-Real-IP` headers. Cloudflare client-IP headers are accepted only when that result belongs to a verified Cloudflare proxy range. GeoIP lookup uses the bundled local database; no per-login address is sent to third-party lookup services. Nonpublic, missing or unmapped addresses return descriptive local/unknown labels rather than invented locations.

This product includes GeoLite2 data created by [MaxMind](https://www.maxmind.com/), distributed with `geoip-lite` under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## Public models and channel privacy

`GET /api/models` returns `{models:PublicModel[],defaultModelId:string|null,modelAliases:Record<string,string>}`. Models are filtered by the user's effective plan. Rename aliases map old public IDs to their current IDs and include only targets available to that user; current live model IDs take precedence over aliases. There are no built-in demonstration models or simulated production replies.

```text
PublicModel = {
  id, name, modelId, routeKey, variantName,
  vision:boolean, enabled:true, status:'untested'|'ok'|'error',
  modes:('chat'|'work')[], reasoningEfforts:string[],
  contextWindow:number|null
}
```

An administrator-defined `routeKey` is the parent model name; `variantName` identifies its version (empty string means default). Stable IDs use `r_<hash>` for default versions and `v_<hash>` for named versions. Each record is one version; clients group these under the parent, then offer version and effort selection. Normal channel retries are confined to that parent/version; an explicitly configured per-user execution list can move between versions/models as described below. This endpoint does not expose provider IDs, provider names, base URLs, channel counts, credentials, or the actual upstream model selected for a response. `Message` likewise omits `sourceProvider` and `sourceModel`.

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
| POST `/api/admin/models` | `{providerId,modelId,name?,routeKey?,vision?,reasoningEfforts?,contextWindow?,maxOutputTokens?,retries?:number|null}` | `{model}`, 201 |
| PATCH `/api/admin/models/:id` | `{name?,routeKey?,enabled?,vision?,reasoningEfforts?,contextWindow?,maxOutputTokens?,isDefault?,retries?:number|null}` | `{model}` |
| DELETE `/api/admin/models/:id` | — | `{ok:true}` |
| POST `/api/admin/models/:id/test` | — | `{ok:boolean,latencyMs:number,error?:string,diagnostic?:object}` |
| POST `/api/admin/models/:id/reset-health` | — | `{model}` |

An empty `apiKey` in PATCH preserves the saved key. Allowed authentication modes are `auto`, `bearer`, and `x-api-key`. `claude-code` requires `anthropic` protocol and a configured runner. API base URLs must be public HTTPS addresses without embedded credentials, query strings, or fragments. A loopback-only exception exists for explicitly enabled local tests.

`responsesProfile` selects Responses request compatibility. `auto` uses Codex-compatible requests for `anyrouter.top` and standard requests for ordinary providers; `standard` and `codex` explicitly override that choice. Chat and native Work share this adapter. It adjusts request shape and compatible headers, includes encrypted reasoning content, disables remote storage, and streams with explicit instructions. It does not install or run Codex CLI and does not guarantee access for a provider-restricted key. Codex-compatible requests omit `max_output_tokens`, so the upstream's default determines the individual response limit; standard Responses continues to send the configured budget. Claude-specific access uses the separate Anthropic/Claude Code path instead.

`AdminModel` is a channel record with `{id,providerId,providerName,modelId,name,routeKey,reasoningEfforts,contextWindow,maxOutputTokens,enabled,vision,available,status,lastCheckedAt,error,failureCount,cooldownUntil}`. Its ID is the database model ID, and its `modelId` is the exact upstream model name. The model page groups these records by `routeKey`; the API still returns the individual channel records.

`contextWindow` is null or 1024–10000000 tokens; model `maxOutputTokens` is null or 128–1000000 tokens. These describe provider capabilities, distinct from the workspace's chosen per-request output budget. Synchronization reads capacity metadata where provided, fills missing values, and preserves existing administrator values; null clears a manual value. Unknown limits are left null instead of guessed.

Sync queries the upstream's actual model list, preserves existing administrator choices, disables new records pending selection, and marks disappeared non-manual records unavailable. Manual records remain available and are enabled on creation. A test performs a small real generation and can consume upstream credits; it does not test the entire Work toolchain. Stored `reasoningEfforts` contains the explicit non-`auto` levels; an empty array permits only automatic effort.

### Routing and original failure diagnostics

Provider defaults and ranges: priority 0 (0–1000), failure protection enabled, failure threshold 3 (1–1000), cooldown 60 seconds (1–2592000). Provider create/PATCH accepts `failureProtectionEnabled:boolean`. Each model create/PATCH accepts `variantName` (up to 100 characters) and nullable `failureProtectionEnabled`, `failureThreshold`, `cooldownSeconds` overrides (null inherits the provider); administrator model JSON returns those fields. Disabling protection stops temporary disabling but retains retries, switching and logs. Policy changes reset health counters.

Model `retries` is null (inherit the workspace) or an integer 0–100 representing additional attempts on the same channel: 5 allows the initial call plus at most 5 retries, 6 calls total. It is returned by administrator model APIs and included in provider export/import. The workspace's `retriesPerChannel` is 0–3, default 1; `routingMaxAttempts` is 1–100, default 6, counting initial calls and retries across only channels inheriting workspace policy **for each execution target**, not the whole fallback list. Explicit model overrides have their own (1 + retries) budget, unaffected by the workspace cap or cooldown opened by that same request; a preexisting cooldown still skips the model.

All upstream failures consume this same retry budget, including every HTTP error status (400/401/403/404/429/500 included), connection errors, timeouts, broken or incomplete streams, empty output and invalid upstream responses. Website Chat/Work preserve already emitted text and use remaining attempts to continue from it; partial output does not reset the budget or bypass same-channel retries. Native Work restores saved tool state without automatically repeating completed operations. After this channel's budget is exhausted, routing tries other eligible channels in the same version, followed by the explicitly configured per-user fallback list. User cancellation, local authorization/request validation and local safety limits stop the request; unsafe tool state is preserved for inspection rather than replayed.

The exported native-protocol API uses a different delivery strategy when retries or alternate channels are available: it buffers an upstream SSE attempt, verifies completion, then delivers that attempt's original events. Failed attempts are discarded and retried within the same configured budget. SSE comments keep the downstream connection active while waiting. This delays the first response events until the upstream attempt completes, preserves native tool IDs and usage events, and avoids concatenating a fresh response into an interrupted stream. This buffering does not change website Chat/Work streaming.

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
 tools:string[],webSearchSupported:boolean,webSearchNote:string,limits:WorkSettings}
```

`available` checks configuration, the administrator's enabled flag, and runner health; health is briefly cached. `engines`, when returned by runner health, distinguishes the default native sandbox from the separately installed optional CLI image. `webSearchSupported` follows the administrator's search-enabled setting; it does not prove service connectivity. Native Work exposes independent `web_search` and `web_fetch` functions for all three API protocols, requiring ordinary tool calling rather than provider-native search. Searches use the configured SearXNG-compatible service; webpage reads go through the controlled gateway. The optional Claude Code engine retains its own search integration. This is not an unrestricted browser: no authenticated sessions or webpage JavaScript execution, and private destinations are blocked.

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
| GET `/api/work/chats/:id/artifacts/download?path=...` | Chat owner; optional saved directory prefix | Streamed ZIP of saved files, preserving paths |
| GET `/api/admin/work/settings` | Admin | Work status, settings, and bounds |
| PATCH `/api/admin/work/settings` | Admin; partial `WorkSettings` | Updated status, settings, and bounds |
| GET `/api/admin/work/search` | Admin | `{settings:{enabled:boolean,baseUrl:string}}` |
| PATCH `/api/admin/work/search` | Admin; `{enabled?,baseUrl?}` | `{settings:{enabled,baseUrl}}` |
| POST `/api/admin/work/search/test` | Admin; `{query?:string}` | `{ok:true,query,results:[{title,url,snippet}],retrievedAt}` |

Search defaults to enabled with `baseUrl:'http://work-search:8080'`. The bundled service address is the sole private-address exception; custom services must be public HTTPS endpoints without embedded credentials, query strings or fragments and must expose SearXNG JSON `/search`. Unknown setting fields are rejected. Tests use the saved configuration and return at most five actual results, never mock success. Queries are 1–500 characters. Native tool searches accept 1–10 results; fetched pages are public HTTPS text/HTML/JSON with checked redirects, a 2 MB response cap and up to 30000 extracted characters. There is no per-task search/fetch call-count cap; the former combined 20-call restriction has been removed from both broker and runner. Task duration, model-round limits and individual network timeouts still apply. Search settings are independent of runner resource settings. Local tests use mocked search/network responses; Docker, real search-engine availability and deployment connectivity require environment acceptance.

A skill can be submitted as Markdown or downloaded from a final public HTTPS raw-file URL. Metadata may be read from front matter and explicitly overridden. Skill names use 1–64 lowercase letters, digits, and hyphens; descriptions have a 500-character limit; content is limited to 64 KB; at most 32 skills are installed. URL imports reject private addresses, redirects, and HTML pages. Imports rebuild front matter and reject dynamic `!` plus backtick command syntax; they do not install hooks, MCP servers, executable packages, or referenced auxiliary files.

`WorkArtifact` is `{id,chatId,path,name,size,mime,createdAt,downloadUrl}`. The runner must actually create a file under its output directory before the server stores and exposes an artifact. Downloads use attachment disposition and restrictive response headers; HTML/SVG content is not executed by the artifact endpoint. Each file remains limited to 10 MB. Conversation file count/total and per-user storage are configurable, with zero disabling that quota (the default). Replacing an output path in the same chat counts only the replacement's actual decoded bytes. Deleting that chat deletes its saved artifacts. Restore includes every saved file; it never silently selects only the newest 30. A restore JSON payload is limited to 512 MB, each NDJSON event to 48 MB; repeated file snapshots have no cumulative wire-byte quota. Sandbox memory, 256 MB workspace and disk capacity still apply.

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
| `artifactTotalMb` | 0 | 0–1048576, per-conversation total; 0 = unlimited quota |
| `artifactMaxFiles` | 0 | 0–1000000, per-conversation count; 0 = unlimited quota |
| `userStorageMb` | 0 | 0–1048576, per-user Work storage; 0 = unlimited quota |

Unknown settings are rejected. `maxBudgetUsd` applies only to the optional Claude Code execution budget; native execution enforces rounds/output/time/resources rather than an inferred USD amount. Neither is a prepaid balance reservation or a guarantee about third-party billing. Each explicit execution target gets an outer streaming deadline: configured runner timeout plus 60 seconds for runner-backed requests, or the direct-API default one hour (`CHAT_TIMEOUT_SECONDS`, 60–21600 seconds). Direct calls also have an independent inactivity timeout (`UPSTREAM_TIMEOUT_MS`, default 180000 ms) refreshed by received data. Reaching one target's deadline may advance a configured fallback; browser disconnect or manual stop cancels the whole request. Work job submission is integrated into chat generation; there is no public standalone `/jobs` API or durable background-task API. See [WORK.md](WORK.md) for runner deployment and sandbox boundaries.

## Workspace settings, users, and invitations

`GET /api/settings` returns `{settings}`. Non-admin responses omit `systemPrompt`. Workspace settings include `siteName`, `defaultModelId`, `dailyLimit`, `maxOutputTokens`, `routingMaxAttempts`, and `retriesPerChannel`; stored `workSettings` can also appear. Billing secrets and provider keys are not stored in these public settings.

`PATCH /api/admin/settings` accepts workspace fields above plus `systemPrompt`; use the dedicated Work endpoint to modify runner limits. `siteName` has a 40-character limit, `systemPrompt` 20000 characters, daily quota 0–100000 (zero disables new requests), and direct-API output limit 128–32768. `routingMaxAttempts` is 1–100 and `retriesPerChannel` is 0–3. Chat titles have a 120-character limit.

| Method and path | Input | Response |
| --- | --- | --- |
| GET `/api/admin/users` | — | `{users:User[]}` |
| GET `/api/admin/users/:id/sessions` | Selected user ID | `{sessions:LoginSession[]}`; read-only current sessions |
| PATCH `/api/admin/users/:id` | `{disabled?,dailyLimit?:number|null}` | `{user}` |
| GET `/api/admin/invites` | — | `{invites:[{id,email,expiresAt,usedAt,createdAt,groupId,groupName}]}` |
| POST `/api/admin/invites` | `{email?,days?:number,groupId?:string|null}` | `{invite:{id,token,expiresAt}}`, 201 |
| DELETE `/api/admin/invites/:id` | — | `{ok:true}` |
| GET `/api/admin/stats` | — | `{users,chats,messages,requestsToday}` |

Invitation validity is 1–30 days, default seven. Administrators cannot be disabled through the user endpoint. Disabling a member ends their sessions and active requests. Explicit daily limits override membership; `dailyLimit:null` restores plan/free limits.

### Special invitation groups

All group endpoints require administrator authentication; writes additionally require CSRF.

| Method and path | Input | Response |
| --- | --- | --- |
| GET `/api/admin/invite-groups` | — | `{groups:InviteGroup[]}`, enabled groups first |
| POST `/api/admin/invite-groups` | Group fields | `{group:InviteGroup}`, 201 |
| PATCH `/api/admin/invite-groups/:id` | Partial group fields | `{group:InviteGroup}` |
| DELETE `/api/admin/invite-groups/:id` | — | `{ok:true}` |

`InviteGroup` is `{id,name,enabled,planId,duration,activeUntil,rules,createdAt,updatedAt}`. Writable fields are `name` (unique, 1–80 characters), `enabled` (default true), `planId` (null for normal free entitlement, `'free'` for a frozen free-plan grant, or an existing plan ID including unpublished plans), `duration:'period'|'permanent'|'until'` (default period), `activeUntil`, and `rules` (default empty). A null plan normalizes duration to period with no expiry. An enabled timed grant requires a future zoned datetime. Unknown fields are rejected. Rules use the same shape, validation, 100-source-rule maximum and ordered fallback semantics as per-user execution routing; enabled groups validate target availability when saved and when creating a link.

POST `/api/admin/invites` with a group ID freezes its plan rights, grant duration, source/target routes, efforts and fallbacks at link creation. Later group/plan edits do not change that link's snapshot; a model rename updates current group and unused-invite references. The public invite lookup still returns only email/expiry and never administrator routing details. Acceptance creates a new user, consumes the single-use link, grants a local administrator entitlement and installs the snapshotted rules in one transaction. Existing accounts cannot redeem again. Period grants start on acceptance (one plan month/year; free uses month); permanent grants have no expiry; fixed expiry does not move. Grants create no Stripe payment or subscription.

A disabled group blocks unused links until re-enabled; deletion permanently invalidates its unused links. An expired link/grant deadline or invalidated issuing administrator also prevents redemption. Temporary upstream unavailability after issuance does not itself prevent registration. Changing, disabling or deleting a group never modifies already registered members' entitlements or routes. Group templates are included in configuration migration; tokens and redemption records are not. Recreate invitation links on the target server.

## Membership and billing

`GET /api/billing` returns `{plans,freePlan,membership,underlyingMembership,hasAdminOverride,hasStripeSubscription,requests,paymentMethods:{stripe,manual},canManageSubscription,canRequestManual,effectiveDailyLimit}`. `membership` is the effective administrator override or active purchased membership, null when neither applies. `underlyingMembership` retains an active manual/Stripe membership beneath an override. A membership has `{planId,planName,activeUntil,source:'manual'|'stripe'|'admin',status,cancelAtPeriodEnd,dailyLimit,allowedRoutes}`; administrator-granted free access uses `planId:null`, and permanent access uses `activeUntil:null`. Administrative notes and actor IDs are omitted from user responses. Plans contain `{id,name,description,priceCents,currency,interval,dailyLimit,allowedRoutes,active,allowStripe,allowManual,sortOrder}`; currency is USD/CNY/EUR/HKD, interval is month/year, and `allowedRoutes` contains route keys (empty means all). Administrators bypass model restrictions but not quota.

- POST `/api/billing/requests` `{planId,note?}` returns `{request}`. Only one pending request per user; the sole enabled administrator cannot submit an application requiring their own approval.
- POST `/api/billing/checkout` `{planId}` and `/api/billing/portal` return `{url}`. The server chooses prices and validates official Stripe destinations.
- GET/POST `/api/admin/plans` and PATCH `/api/admin/plans/:id` manage plans. Existing purchase/application terms are snapshots; disable plans rather than deleting purchase history.
- GET `/api/admin/billing/requests`; POST `/api/admin/billing/requests/:id/review` `{decision:'approve'|'reject',note?}` returns `{request}`. Self-review and duplicate approvals are rejected.
- GET/PATCH `/api/admin/billing/settings` uses `{stripeEnabled,freeAllowedRoutes,secretKey?,webhookSecret?}`. GET exposes only key hints/presence flags and the webhook URL; blank keys preserve saved secrets.
- POST `/api/billing/webhook` accepts raw JSON with Stripe-Signature verification before session/CSRF middleware. Supported events include checkout completion/async payment success, subscription created/updated/deleted, and invoice paid/payment failed. Browser redirects never grant access.

See [MEMBERSHIP.md](MEMBERSHIP.md) for deployment and subscription lifecycle details.

### Administrator membership assignments

- GET `/api/admin/users/:id/membership` returns `{effective,override,underlyingMembership,hasStripeSubscription,plans,history}`. `plans` includes unpublished plans. `effective` is `{planId,planName,dailyLimit,allowedRoutes,activeUntil,source}`. `override` is null or a membership plus `{reason,adminId,updatedAt}`; it can have `status:'expired'` while the effective entitlement has already reverted. `history` contains up to 30 newest audit records `{id,action:'set'|'restore',adminName,reason,createdAt,previous,next}`.
- PUT at the same path accepts `{planId:'free'|planId,duration?:'period'|'permanent'|'until',activeUntil?:ISODateTime,note?:string}`. Default `period` starts one month/year from now according to the chosen plan (free uses month); `until` requires a future zoned datetime; `permanent` has no expiry. Notes are at most 1000 characters.
- DELETE at the same path accepts optional `{note}` and removes the administrator override, restoring the currently valid underlying membership or current free entitlement. It does not extend the original term. Repeated deletion is idempotent.

All three routes require an administrator; mutations require CSRF and an existing user. Assignments save plan rights as a snapshot, never clear usage counters, and retain the precedence of an explicit user daily limit. They neither charge nor cancel Stripe subscriptions. Webhooks continue to update underlying purchased rights without overriding the administrator selection; the customer's payment portal remains available. New manual applications/payments and approving a pending application are blocked while a current override applies. Model renames update current override snapshots but never rewrite historical audit values.

## Announcements

`Announcement` is `{id,title,body,status:'draft'|'published',revision,createdAt,updatedAt,publishedAt}`. Title and Markdown body must be nonempty, capped at 120 and 20000 characters respectively. Rendering uses the existing safe Markdown/math pipeline with HTML disabled; no announcement script execution or external-image loading occurs.

| Method and path | Input / access | Response |
| --- | --- | --- |
| GET `/api/announcements` | Signed in | `{announcements:Announcement[]}` containing published revisions unread by this user |
| POST `/api/announcements/:id/read` | Signed in; `{revision:number}` | `{ok:true}` |
| GET `/api/admin/announcements` | Admin | `{announcements:Announcement[]}` including drafts |
| POST `/api/admin/announcements` | Admin; `{title,body,status?:'draft'|'published'}` | `{announcement}`, 201; default draft |
| PATCH `/api/admin/announcements/:id` | Admin; `{revision,title?,body?,status?}` | `{announcement}` |

Mutations require CSRF. Drafts are not returned to ordinary users. Read records are keyed by the authenticated user and announcement, so closing on one device syncs to the user's other devices on refresh; the frontend refreshes on focus and every 60 seconds. Editing content/status increments its revision, making newly published content unread again; a no-op edit preserves the revision. Unpublishing retains a draft. Stale editor/read revisions return 409 instead of overwriting or dismissing new content. Unknown/unpublished read targets return 404. There is no scheduled publication or public unauthenticated announcement endpoint.

## Model catalog and versions

- GET `/api/admin/model-groups` returns `{groups:[{name,variants:[{name,modelIds:string[]}]}]}`, including empty drafts.
- PUT `/api/admin/model-groups` accepts one `{name,variants:[{name,modelIds,retries?:number|null}],originalName?}` and atomically replaces that parent's mapping. When editing, `originalName` identifies the existing parent; a changed `name` renames it in the same transaction. Names are up to 300 characters, at most 100 unique versions per parent and 500 channel records per version. Each upstream record belongs to one version. Selected records become enabled, except that renaming preserves the enabled state of existing bindings retained in their original version. Removed records are disabled and retained with their mapping reset. An omitted version `retries` preserves each selected record’s existing value; null restores workspace inheritance; an integer 0–100 sets the same extra retry count on all selected channel records for that version. Empty drafts are excluded from public choices. Involved providers must be idle.
- DELETE `/api/admin/model-groups/:name` accepts a URL-encoded existing catalog name and returns `{ok:true,groups}`. It removes the catalog and its versions, disables and unassigns all upstream records under that name, removes rename aliases and clears a matching default selection. Upstream records and chat/usage history are preserved. Existing quota, routing, invitation and plan references are not silently redirected; administrators must replace stale model references. A missing name returns 404, and related active generation, provider or payment operations can return 409.

Renaming retains upstream IDs and versions, migrates public model references, default selection, per-user version limits and usage labels, both ends of user routing rules including ordered fallback targets, and allowed model names in free/paid plans and stored membership/administrator-override/application/checkout snapshots. Historical request route labels use the renamed model while request counts, timestamps, token usage and upstream attempt records remain intact. Administrator entitlement audit snapshots retain their original values. Old public IDs remain accepted through rename aliases, subject to current model availability and plan permissions. The frontend remaps the current selection instead of falling back to another model. Name collisions return 409 without partial changes; a missing original name returns 404. Active related tasks or in-progress payment operations temporarily return 409 so they cannot write back stale routing or plan data.

Channel-level model endpoints remain available. Provider backups retain assigned version mappings and failure overrides. Complete configuration transfers also include empty catalog drafts and user quota settings; only full data backup preserves historical usage.

## Per-user, per-version quota

GET and PUT `/api/admin/users/:id/model-limits` require admin access; PUT requires CSRF and atomically replaces `{limits:[{routeKey,variantName,dailyLimit,monthlyLimit}]}` (maximum 500 rules). Variant names are strings, with `''` as the default; legacy incoming null is an alias for `''`, never a shared family rule. Limits are integers 0–1000000000 or null: zero blocks use, null leaves that dimension unlimited.

Both return `{limits:[{routeKey,variantName,dailyLimit,monthlyLimit,usedToday,usedMonth,updatedAt}],timeZone:'Asia/Taipei',resetsAt:{daily,monthly}}`. Versions count independently. Multiple channels inside one version share its counter. Existing account/plan total limits still apply separately. Model/version usage is snapshotted on accepted requests so later channel remapping does not rewrite historical use. Failed/stopped requests count, continuation/regeneration reserve one new request, and internal routing retries do not reserve again. The quota check and reservation are in the same SQLite transaction before history mutation. Errors use `USER_MODEL_DISABLED` (403), `USER_MODEL_DAILY_LIMIT` or `USER_MODEL_MONTHLY_LIMIT` (429).

Day/month boundaries use UTC+8 natural calendar periods; account/plan aggregate daily limits retain UTC boundaries. Existing legacy family rules migrate into independent rules for each existing version, with explicitly configured version rules taking precedence.

## Administrator chat archive

GET `/api/admin/chats/export?format=json|markdown&userId=<user-id>` requires an administrator and returns an attachment ZIP with no-store caching. Default format is JSON. Omit `userId` to export all users; supply a single nonempty user ID to include only that user's profile, chats and messages (including archived chats and disabled accounts). A nonexistent user returns 404; empty, repeated or overlong user IDs return 400. A user without chats still has their profile exported. Ordinary users cannot export even their own records through this admin endpoint.

The archive retains its existing per-user/chat file layout and schema version. `manifest.json` adds `scope: "all" | "user"` and `userId: string | null`; all user/chat/message counts are scoped to the selected export. Attachment filenames contain `all` or `user-<id>`, format and creation time. Messages include separate reasoning, active journal chunks and owned file metadata. Attachment/artifact metadata is restricted to the chat owner's records, including for stale cross-user references. It omits attachment/artifact binary data, service credentials, password hashes and payment configuration; user-written message content is retained. A dedicated read-only database snapshot keeps an export consistent while writes continue; at most two exports run concurrently (429 when busy). This is a reading/archive export, not a complete application restore backup.

## Per-user execution routing

GET and PUT `/api/admin/users/:id/model-routing` require administrator access; PUT also requires CSRF. Both return `{rules:[{sourceRouteKey,sourceVariantName,targetRouteKey,targetVariantName,enabled,effort,fallbacks:[{targetRouteKey,targetVariantName,effort}]}]}`. PUT atomically replaces the user's rules, up to 100, with one rule per source model/version. The fallback array has no fixed count cap but remains subject to the HTTP body limit. Empty version strings mean the default version. `enabled` defaults to true; each target's `effort` defaults to `auto` and accepts `low`, `medium`, `high`, `xhigh`, `max`. Enabled targets must have available enabled channels supporting the fixed effort. A source cannot equal its primary target; it may appear explicitly as a backup. Duplicate model/version/effort combinations within a rule are rejected. Disabled stale entries can be retained or removed. Changing rules while that user has an active generation returns 409.

Source entitlement and requested capabilities are validated first. A rule supplies one ordered list: primary followed by explicit backups; mappings do not chain or recurse. A usable backup can start if an earlier target is unavailable. If all targets fail preflight, no message/history mutation or quota reservation occurs. Target failure, timeout, empty output or explicit upstream incomplete status can advance to the next target. Already emitted text stays in the same assistant message and becomes continuation context; normal completion is not heuristically reclassified from its prose. Each target independently applies the inherited-channel workspace budget, explicit per-model retry budgets and its own deadline. There is no implicit fallback to the source or unlisted models.

The administrator's rule authorizes target execution without a second plan-model or target-version quota check. Account/plan aggregate quotas still apply; one accepted request reserves the selected source version only once across the entire list. User stop/disconnect and local output/storage safety limits stop fallback. Native Work can hand off saved, compatible tool checkpoints and files; completed tools are not automatically replayed. Committed operations without a reliable checkpoint, or a CLI run that already performed actions, block automatic handoff. Ordinary same-target Work continuation preserves its model/protocol checks. Upper-layer text continuation cannot recover arbitrary process memory or private upstream state.

Ordinary models/chat/message APIs and SSE retain the selected source identity and do not expose the mapping. The app does not change system prompts to impersonate the selected model. Administrator routing logs additionally expose `userId`, `sourceRouteKey`, `sourceVariantName`, `executionRouteKey`, `executionVariantName`, `requestedEffort`, `executionEffort`, `userRoutingApplied`; these fields are snapshots recorded on the generation request. Provider/channel backups do not include per-user mappings; complete configuration transfers and full database backups do.

## Complete configuration transfer

All `/api/admin/config/*` endpoints require an administrator session, CSRF, and current-password reauthentication. These are configuration merge operations, separate from provider-only backups and full database restores.

| Method and path | Input | Response |
| --- | --- | --- |
| POST `/api/admin/config/export` | `{currentPassword,password}` | Encrypted version-1 JSON attachment |
| POST `/api/admin/config/preview` | `{currentPassword,password,document}` | `{fingerprint,confirmation,expiresAt,summary,conflicts,warnings}` |
| POST `/api/admin/config/import` | `{currentPassword,fingerprint,confirmation}` | `{ok:true,summary}`; no document resubmission |

`password` is an independent 12–256-character backup passphrase; `document` is the parsed encrypted envelope. The envelope is `{_type:'apirouter_configuration_export',version:1,encrypted:true,kdf:{name:'scrypt',N:32768,r:8,p:1,salt},cipher:{name:'AES-256-GCM',iv,tag,data}}`, with Base64 binary values, a 16-byte salt, 12-byte IV and 16-byte authentication tag. Only these fixed algorithms and version are accepted. Decrypted JSON is capped at 32 MiB; the UI accepts encrypted files up to 44 MiB, and the authenticated HTTP routes parse at most 48 MiB including request wrapping. These routes share a ten-per-minute operation limiter. Stored source provider/payment secrets are decrypted into the encrypted package and re-encrypted with the target's master key on import; host keys and environment files are not transferred.

Preview contains no plaintext credentials or password hashes. `summary` contains `{section,create,update,preserve}` rows, `conflicts` contains `{section,label,action}` rows, and `warnings` describes operational boundaries. Confirmation must equal `合并导入配置`. A preview is bound to its administrator and process, expires after ten minutes, and must be regenerated after target configuration changes. Import rechecks identity, preview validity, configuration state and in-flight operation guards before a single database transaction.

The manifest includes site/Work/search settings, users and valid scrypt password hashes, provider secrets and model configuration, balance adapters, model catalog/version/rename aliases, skills, plans/payment configuration, effective entitlement snapshots, per-user version limits and ordered execution routes, special invitation group templates, announcements, and external API credential hashes/allowlists. Source-only users retain their password/role/disabled state. Same-email target users retain their existing ID/password/role/disabled state while imported profile and access configuration is merged. IDs and references are mapped to target records; repeated imports from the same source retain provenance. Natural-key matches include provider name/URL/protocol/runtime, provider plus raw model ID, named model catalogs/versions/plans/skills/invitation groups, API token hash, and unique announcement titles. Ambiguous multiple matches are rejected. Target-only records are preserved.

Current source membership rights become local administrator overrides retaining their original snapshot and expiry, without creating charges or transferring renewal associations. Existing target Stripe assets protect conflicting target payment configuration. Sessions, invite tokens, announcement reads, conversations/files/Work checkpoints, request usage, balance/health/error history, Stripe transactions/customers/subscriptions/events and historical audit are excluded. New target usage starts at zero; existing target usage remains. Source subscriptions continue independently. See [CONFIG-MIGRATION.md](CONFIG-MIGRATION.md) for merge behavior, payment limitations and post-import checks.

## External API credentials

The independent external-client API uses root `/v1/*` endpoints rather than the browser's `/api/*` session interface. Administrators manage credentials through GET/POST `/api/admin/api-keys` and PATCH/DELETE `/api/admin/api-keys/:id`; these management routes use normal administrator session authentication and CSRF. Creation returns `{key,apiKey}` once, listing returns `{keys}`, updates return `{key}`. A credential record is `{id,name,enabled,modelIds,keyHint,createdAt,lastUsedAt}`. `modelIds` references explicitly allowed upstream channel-record IDs, not public aliases. The database stores the credential hash, not recoverable plaintext.

External GET `/v1/models` lists authorized enabled original upstream model IDs, deduplicated in `{object:'list',data:[{id,object:'model',created:0,owned_by:'apirouter'}]}`; listing does not guarantee real-time upstream health. POST `/v1/chat/completions`, `/v1/responses`, and `/v1/messages` accept their respective native request protocols and only use authorized matching-protocol direct-API channels. An identical upstream ID on an unselected channel is not authorized implicitly. These endpoints do not translate protocols or run the website's Work/Claude Code engines, user-specific routing or browser membership quotas, and do not create website chat records. They accept the site's independently issued API Key through Bearer or `x-api-key` authentication; conflicting dual headers are rejected, and saved provider credentials are applied only server-side. JSON/SSE responses pass through without protocol conversion, with provider-secret redaction; an interrupted committed stream is not retried into another provider's response.

External requests have a 32 MiB JSON limit, 64 MiB response limit, fixed one-hour total deadline, default 180-second upstream inactivity timeout, per-key limit of 10 concurrent generations and per-IP limit of 300 requests/minute. Keys have no automatic expiry; disabling/revoking or changing their allowlist aborts their active external requests as well as preventing later unauthorized calls. Disabling an upstream model/provider is rechecked before retries and after awaited stream reads. An owner account that is disabled or no longer an administrator invalidates its keys. See [EXPORTED-API.md](EXPORTED-API.md) for setup, one-time credential download and examples.

External channel attempts are retained in administrator routing diagnostics under request IDs prefixed `api-export-`, with encrypted, redacted raw failures when available; they do not insert quota-counted website `requests` or chat messages. Caller-facing failures are generic and do not expose administrator diagnostic bodies.

## Mathematical Markdown presentation

Client rendering supports `$...$`, `$$...$$`, `\(...\)` and `\[...\]` with bundled KaTeX fonts. Code, link contents and stored message text are preserved. Copy and Markdown export return the original source rather than rendered HTML. Trusted HTML/URL commands are disabled and macro expansion is bounded. Unmarked plain parentheses or brackets are not inferred as math. This is Markdown/KaTeX display, not an arbitrary LaTeX document compiler.

