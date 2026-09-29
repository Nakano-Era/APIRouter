# API contract

All responses JSON unless SSE. Error: `{error: string, code?:string}`. Auth session is HttpOnly cookie. Fetch credentials same-origin. GET /api/auth/session returns `{user:null|User, needsSetup:boolean, csrfToken?:string}`. Any mutating authenticated request MUST send `X-CSRF-Token`. Setup/login exempt but Origin enforced. Every endpoint uses user isolation; admin routes role-checked. Models empty until real upstream configuration; no demo replies.

User `{id,name,email,role:'admin'|'user',createdAt,disabled?:boolean,dailyLimit?:number}`.

Auth: POST /api/auth/setup `{setupToken,name,email,password}` -> session; POST /api/auth/login `{email,password}` -> session; POST /api/auth/logout; POST /api/auth/password `{currentPassword,newPassword}`. GET /api/auth/invite?token=... -> `{email,expiresAt}`. POST /api/auth/invite/accept `{token,name,email,password}` -> session. Invite token may arrive in URL `?invite=...`. Setup token shown once in server terminal, never exposed by GET API. Password 12–256 chars; user name max60.

GET /api/models -> `{models: Model[],defaultModelId:string|null}`. Public Model `{id,providerId,modelId,name,enabled,vision,providerName?,channelCount?,status:'untested'|'ok'|'error',lastCheckedAt?:string|null,error?:string|null}`. Public models are grouped by `routeKey`; `id` is a stable `r_<hash>` route ID and `name`/`modelId` are the route key. Admin model APIs expose individual channel records: their `id` is the database ID and `modelId` is the real upstream name. See the channel routing extension below.

GET /api/chats -> `{chats:Chat[]}`; Chat `{id,title,modelId,createdAt,updatedAt,pinned:boolean,archived:boolean}`.
POST /api/chats `{modelId?,title?}` -> `{chat}`. GET /api/chats/:id -> `{chat,messages:Message[]}`. PATCH /api/chats/:id `{title?,pinned?,archived?,modelId?}` -> `{chat}`. DELETE /api/chats/:id -> `{ok:true}`.
Message `{id,role:'user'|'assistant',content,modelId?,createdAt,status:'complete'|'streaming'|'error'|'stopped',attachments:Attachment[],error?:string|null}`.
Attachment `{id,name,mime,size,kind:'image'|'text',url}`; POST /api/files multipart field `files` -> `{files:Attachment[]}`. Supports jpg/png/webp/gif/txt/md/csv/json/code/pdf/docx/xlsx, max 10MB each, 5 files/request. GET /api/files/:id/download authenticated. DELETE /api/files/:id -> `{ok:true}`.
POST /api/chats/:id/messages `{content,modelId,attachmentIds?:string[]}` -> SSE.
POST /api/chats/:id/regenerate `{modelId}` -> SSE (remove last assistant only; reuse last user).
POST /api/chats/:id/edit `{messageId,content,modelId,attachmentIds?:string[]}` -> SSE (edit user and prune following messages; explicit UI confirmation).
POST /api/chats/:id/stop -> `{ok:true}`.
SSE events `meta` data `{userMessage?:Message,assistantMessage:Message,chat:Chat}`; `delta` data `{text}`; `done` data `{message:Message}`; `error` data `{error,message?:Message}`. Frontend AbortController plus stop endpoint. Disconnect aborts chat generation. SSE no fake delays.

Admin GET /api/admin/providers -> `{providers:Provider[]}`. Provider `{id,name,baseUrl,protocol:'openai-chat'|'openai-responses'|'anthropic',enabled,hasKey,keyHint,lastSyncedAt,lastSyncError,createdAt}`; never expose API key. POST /api/admin/providers `{name,baseUrl,protocol,apiKey,enabled?}` -> `{provider}`. PATCH /api/admin/providers/:id same optional fields; empty apiKey preserves current. DELETE route -> `{ok:true}`.
POST /api/admin/providers/:id/sync -> `{models:Model[],count:number}` sync real /models, preserve enabled preferences, mark disappeared auto-synced models unavailable. New synced models disabled pending admin selection; manually added models enabled. Model includes `available:boolean`. GET /api/admin/models -> `{models:Model[],defaultModelId}`. POST /api/admin/models `{providerId,modelId,name?,vision?}` -> `{model}` manual fallback. PATCH /api/admin/models/:id `{name?,enabled?,vision?,isDefault?}` -> `{model}`. DELETE route -> `{ok:true}`. POST /api/admin/models/:id/test -> `{ok:boolean,error?:string,latencyMs:number}` REAL small generation (UI warn consumes tokens).
GET /api/admin/users -> `{users:User[]}`. PATCH /api/admin/users/:id `{disabled?,dailyLimit?}`. POST /api/admin/invites `{email?,days?:number}` -> `{invite:{id,token,expiresAt}}`. GET /api/admin/invites -> `{invites:[{id,email,expiresAt,usedAt,createdAt}]}`. DELETE /api/admin/invites/:id.
GET /api/admin/stats -> `{users,chats,messages,requestsToday}`.
GET /api/settings -> `{settings:{siteName,systemPrompt,defaultModelId,dailyLimit,maxOutputTokens}}`. PATCH /api/admin/settings those fields -> `{settings}`. System prompt visible only to admin. Public settings endpoint should omit systemPrompt for non-admin. siteName max40, dailyLimit 0–100000 (0 forbids new requests), maxOutputTokens 128–32768, chat title max120.

## Channel routing extension

Provider fields and POST/PATCH inputs add `priority` (0–1000, default0), `failureThreshold` (1–10, default3), `cooldownSeconds` (5–86400, default60), `authMode` ('auto'|'bearer'|'x-api-key', default'auto'). Admin models expose `routeKey`, `failureCount`, `cooldownUntil`. Model POST/PATCH accept `routeKey` (max300, defaults to upstream modelId); same key defines equivalent upstream models. Public `/models` groups by routeKey, uses stable `r_<hash>` IDs, exposes `channelCount` and routeKey as name. Admin model APIs continue using database IDs; old internal chat IDs remain accepted. Public default ID normalized to route ID.

Settings add `routingMaxAttempts` (1–10, default6), `retriesPerChannel` (0–3, default1). POST /api/admin/models/:id/reset-health clears count/cooldown. GET /api/admin/routing-logs -> `{attempts:[{id,requestId,providerName,modelId,outcome,error,createdAt}]}` newest200 (outcome running/complete/error/stopped). SSE additionally emits `routing` data `{message:string}` before retries/switches. Message adds `sourceProvider` and `sourceModel` (actual selected source, informational). No automatic cross-route model downgrade; no switch after first visible text.

## Membership and billing

`GET /api/billing` returns `{plans,freePlan,membership,requests,paymentMethods:{stripe,manual},canManageSubscription,canRequestManual,effectiveDailyLimit}`. Membership is null when expired. Plans contain `{id,name,description,priceCents,currency,interval,dailyLimit,allowedRoutes,active,allowStripe,allowManual,sortOrder}`; currency USD/CNY/EUR/HKD, interval month/year, allowedRoutes are route keys (empty = all). Admins bypass model restrictions but not quota. Explicit user `dailyLimit` overrides membership; PATCH `/api/admin/users/:id` with `dailyLimit:null` restores plan/free quota.

- POST `/api/billing/requests` `{planId,note?}` -> `{request}`; only one pending per user. Sole enabled admin cannot submit an unreviewable manual application.
- POST `/api/billing/checkout` `{planId}` and `/api/billing/portal` -> `{url}`. Server prices and official Stripe HTTPS destinations only.
- GET/POST `/api/admin/plans`, PATCH `/api/admin/plans/:id`; existing purchase/application terms are snapshots. Disable plans instead of deleting purchase history.
- GET `/api/admin/billing/requests`; POST `/api/admin/billing/requests/:id/review` `{decision:'approve'|'reject',note?}` -> `{request}`. No self-review or duplicate approval.
- GET/PATCH `/api/admin/billing/settings` uses `{stripeEnabled,freeAllowedRoutes,secretKey?,webhookSecret?}`; GET exposes hints/has-key flags and webhookUrl only. Blank keys retain stored secrets; billing configuration is never stored in public workspace settings.
- POST `/api/billing/webhook` is raw JSON with Stripe-Signature verification, before session/CSRF middleware. Events: checkout.session.completed / async_payment_succeeded, customer.subscription.created / updated / deleted, invoice.paid / payment_failed. Browser redirects never grant access.

See `MEMBERSHIP.md` for deployment, lifecycle, and supported subscription operations.
