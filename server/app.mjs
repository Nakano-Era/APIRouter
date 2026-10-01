import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createStore, now, id, digest, hashPassword, verifyPassword } from './store.mjs';
import { validateBaseUrl, listModels, streamReply, sanitizeUpstreamError } from './upstream.mjs';
import { extractUpload } from './files.mjs';
import { createRouter } from './router.mjs';
import { createBilling } from './billing.mjs';
import { createWorkService } from './work.mjs';
import { createProviderTools } from './provider-tools.mjs';
import { continuationInstruction, continuationAppender, isContinuationRequest, checkContext } from './continuation.mjs';
import { reasoningSplitter } from './reasoning.mjs';
import { responseProfiles } from './responses-compat.mjs';
import { createModelCatalog, modelRouteId, variantName } from './model-catalog.mjs';
import { createUserModelAccess } from './user-model-access.mjs';
import { createChatExport } from './chat-export.mjs';

const protocols = new Set(['openai-chat', 'openai-responses', 'anthropic']);
const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
function reasoningEfforts(value) {
  if (!Array.isArray(value) || value.length > 6 || value.some(item => !['auto', ...effortLevels].includes(item))) throw Object.assign(new Error('思考强度配置无效。'), { status: 400 });
  return [...new Set(value.filter(item => item !== 'auto'))];
}
function initialEfforts(modelId) {
  return /^claude-(?:opus|sonnet)-5(?:-|$)|^gpt-6(?:-|$)/.test(modelId) ? effortLevels : [];
}
const messageLimit = 32 * 1024 * 1024;
function capacityValue(value, label, min, max) { return value === null || value === '' ? null : number(value, min, max, label); }
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const cleanText = (value, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function requiredText(value, label, max = 200) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(400, `${label}不能为空，且最多 ${max} 个字符。`); return value.trim(); }
function validEmail(value) { const email = requiredText(value, '邮箱', 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, '请输入有效的邮箱地址。'); return email; }
function validPassword(value) { if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw fail(400, '密码长度需要在 12–256 个字符之间。'); return value; }
function bool(value, name) { if (typeof value !== 'boolean') throw fail(400, `${name}必须是布尔值。`); return value ? 1 : 0; }
function number(value, min, max, name) { if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `${name}需要是 ${min}–${max} 之间的整数。`); return value; }
const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createApp({ dataDir = resolve('./data'), setupToken: suppliedSetupToken, logger = console, stripeFactory, workFactory = createWorkService } = {}) {
  const app = express();
  const store = createStore(dataDir);
  const work = workFactory({ store, dataDir });
  const streamModel = options => options.mode === 'work' || options.provider.runtime === 'claude-code' ? work.stream(options) : streamReply(options);
  const router = createRouter({ store, stream: streamModel });
  const active = new Map();
  const syncing = new Set();
  const testing = new Map();
  const secureCookies = process.env.COOKIE_SECURE === 'true';
  const setupToken = store.get('SELECT id FROM users LIMIT 1') ? null : (suppliedSetupToken || process.env.SETUP_TOKEN || randomBytes(24).toString('base64url'));
  const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : null;
  const billing = createBilling({ store, publicOrigin, stripeFactory });
  const catalog = createModelCatalog({ store, ensureProviderIdle });
  const modelAccess = createUserModelAccess({ store });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5, fields: 0, parts: 5 } });
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Cross-Origin-Resource-Policy': 'same-origin' });
    if (process.env.NODE_ENV === 'production') res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.get('origin');
      const expected = publicOrigin || `${req.protocol}://${req.get('host')}`;
      if ((origin && origin !== expected) || req.get('sec-fetch-site') === 'cross-site') return next(fail(403, '请求来源不受信任。'));
    }
    next();
  });
  billing.mountWebhook(app);
  app.use(['/api/admin/providers/parse', '/api/admin/providers/import'], express.json({ limit: '8mb' }));
  // Authenticate before buffering long prompts. Other endpoints retain their
  // smaller JSON limit, including public sign-in and setup requests.
  const longPromptPath = /^\/api\/chats\/[^/]+\/(?:messages|edit)\/?$/;
  const standardJSON = express.json({ limit: '1mb' });
  app.use((req, res, next) => req.method === 'POST' && longPromptPath.test(req.path) ? next() : standardJSON(req, res, next));
  app.use((req, _res, next) => { if (req.body === undefined) req.body = {}; next(); });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, message: { error: '请求过于频繁，请稍后再试。' } }));
  app.use('/api', (req, _res, next) => {
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('apirouter_session='))?.slice(18);
    if (token && /^[a-zA-Z0-9_-]{43}$/.test(token)) {
      const session = store.get('SELECT sessions.*, users.disabled FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires_at>?', digest(token), now());
      if (session && !session.disabled) { req.session = session; req.user = store.get('SELECT * FROM users WHERE id=?', session.user_id); }
    }
    next();
  });
  const auth = (req, _res, next) => req.user ? next() : next(fail(401, '请先登录。'));
  const csrf = (req, _res, next) => ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || safeEqual(req.get('x-csrf-token'), req.session?.csrf) ? next() : next(fail(403, '登录状态已更新，请刷新页面后重试。', 'CSRF_INVALID'));
  const admin = (req, _res, next) => req.user?.role === 'admin' ? next() : next(fail(403, '此操作仅限管理员。'));
  billing.registerRoutes(app, { auth, admin, csrf });
  work.registerRoutes(app, { auth, admin, csrf });
  createProviderTools({ store, providerJSON, ensureProviderIdle }).registerRoutes(app, { auth, admin, csrf });
  catalog.registerRoutes(app, { auth, admin, csrf });
  modelAccess.registerRoutes(app, { auth, admin, csrf });
  createChatExport({ store }).registerRoutes(app, { auth, admin, csrf });
  const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: { error: '登录尝试过多，请 15 分钟后重试。' } });
  function userJSON(row) { return { id: row.id, name: row.name, email: row.email, role: row.role, disabled: !!row.disabled, dailyLimit: row.daily_limit, createdAt: row.created_at }; }
  function createSession(res, user) {
    store.run('DELETE FROM sessions WHERE expires_at<=?', now());
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
    store.run('INSERT INTO sessions(token,user_id,csrf,expires_at) VALUES (?,?,?,?)', digest(token), user.id, csrfToken, expiresAt);
    res.cookie('apirouter_session', token, { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/', maxAge: 7 * 86400_000 });
    return { user: userJSON(user), csrfToken, needsSetup: false };
  }
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/auth/session', (req, res) => res.json({ user: req.user ? userJSON(req.user) : null, needsSetup: !store.get('SELECT id FROM users LIMIT 1'), ...(req.session ? { csrfToken: req.session.csrf } : {}) }));
  app.post('/api/auth/setup', authLimiter, async (req, res) => {
    if (store.get('SELECT id FROM users LIMIT 1')) throw fail(409, '管理员已创建，请登录。');
    if (!setupToken || !safeEqual(req.body.setupToken, setupToken)) throw fail(403, '管理员设置码错误，请查看服务器启动日志。');
    const name = requiredText(req.body.name, '姓名', 60), email = validEmail(req.body.email);
    const password = await hashPassword(validPassword(req.body.password));
    const userId = id();
    store.transaction(() => {
      if (store.get('SELECT id FROM users LIMIT 1')) throw fail(409, '管理员已创建，请登录。');
      store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', userId, name, email, password, 'admin', now());
    });
    res.status(201).json(createSession(res, store.get('SELECT * FROM users WHERE id=?', userId)));
  });
  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const email = validEmail(req.body.email);
    const password = typeof req.body.password === 'string' && req.body.password.length <= 256 ? req.body.password : '';
    const user = store.get('SELECT * FROM users WHERE email=?', email);
    const valid = await verifyPassword(password, user?.password || `${'00'.repeat(16)}:${'00'.repeat(64)}`);
    if (!user || !valid || user.disabled) throw fail(401, '邮箱或密码错误，或账号已停用。');
    res.json(createSession(res, user));
  });
  app.get('/api/auth/invite', authLimiter, (req, res) => {
    const token = cleanText(req.query.token, 200);
    const invite = store.get('SELECT * FROM invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?', digest(token), now());
    if (!invite) throw fail(404, '邀请已失效、已使用或不存在。');
    res.json({ email: invite.email, expiresAt: invite.expires_at });
  });
  app.post('/api/auth/invite/accept', authLimiter, async (req, res) => {
    const token = requiredText(req.body.token, '邀请链接', 200), name = requiredText(req.body.name, '姓名', 60);
    const invite = store.get('SELECT * FROM invites WHERE token_hash=? AND used_at IS NULL AND expires_at>?', digest(token), now());
    if (!invite) throw fail(400, '邀请已失效、已使用或不存在。');
    const email = validEmail(req.body.email || invite.email);
    if (invite.email && invite.email !== email) throw fail(400, '此邀请仅供指定邮箱使用。');
    if (store.get('SELECT id FROM users WHERE email=?', email)) throw fail(409, '该邮箱已存在，请登录。');
    const password = await hashPassword(validPassword(req.body.password)), userId = id();
    store.transaction(() => {
      const current = store.get('SELECT * FROM invites WHERE id=? AND used_at IS NULL AND expires_at>?', invite.id, now());
      if (!current) throw fail(409, '邀请已失效或已使用。');
      store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', userId, name, email, password, 'user', now());
      store.run('UPDATE invites SET used_at=? WHERE id=?', now(), invite.id);
    });
    res.status(201).json(createSession(res, store.get('SELECT * FROM users WHERE id=?', userId)));
  });
  app.use('/api', auth, csrf);
  app.use(longPromptPath, express.json({ limit: '32mb' }));
  app.post('/api/auth/logout', (req, res) => { store.run('DELETE FROM sessions WHERE token=?', req.session.token); res.clearCookie('apirouter_session', { path: '/', httpOnly: true, sameSite: 'strict', secure: secureCookies }); res.json({ ok: true }); });
  app.post('/api/auth/password', authLimiter, async (req, res) => {
    const current = typeof req.body.currentPassword === 'string' && req.body.currentPassword.length <= 256 ? req.body.currentPassword : '';
    if (!(await verifyPassword(current, req.user.password))) throw fail(400, '当前密码错误。');
    const password = await hashPassword(validPassword(req.body.newPassword));
    store.transaction(() => { store.run('UPDATE users SET password=? WHERE id=?', password, req.user.id); store.run('DELETE FROM sessions WHERE user_id=? AND token<>?', req.user.id, req.session.token); });
    res.json({ ok: true });
  });
  function providerJSON(row) { return { id: row.id, name: row.name, baseUrl: row.base_url, protocol: row.protocol, runtime: row.runtime || 'api', responsesProfile: row.responses_profile || 'auto', enabled: !!row.enabled, hasKey: !!row.encrypted_key, keyHint: row.key_hint, lastSyncedAt: row.last_synced_at, lastSyncError: row.last_sync_error, createdAt: row.created_at, priority: row.priority, failureProtectionEnabled: row.failure_protection_enabled !== 0, failureThreshold: row.failure_threshold, cooldownSeconds: row.cooldown_seconds, authMode: row.auth_mode }; }
  function providerForModel(row) { const provider = store.get('SELECT * FROM providers WHERE id=?', row.provider_id); if (!provider?.enabled) throw fail(400, '该模型的接口已停用。'); return { ...providerJSON(provider), apiKey: store.decrypt(provider.encrypted_key) }; }
  function providerBusy(providerId) { return syncing.has(providerId) || [...testing.values()].includes(providerId) || [...active.values()].some(job => job.providerIds?.includes(providerId)); }
  function ensureProviderIdle(providerId) { if (providerBusy(providerId)) throw fail(409, '该接口正在处理请求，请等待请求完成或停止回复后修改。'); }
  function modelJSON(row) { return { id: row.id, providerId: row.provider_id, modelId: row.model_id, name: row.name, routeKey: row.route_key, variantName: row.variant_name || '', contextWindow: row.context_window ?? null, maxOutputTokens: row.max_output_tokens ?? null, reasoningEfforts: JSON.parse(row.reasoning_efforts || '[]'), failureProtectionEnabled: row.failure_protection_enabled == null ? null : !!row.failure_protection_enabled, failureThreshold: row.failure_threshold_override ?? null, cooldownSeconds: row.cooldown_seconds_override ?? null, failureCount: row.failure_count, cooldownUntil: row.cooldown_until, enabled: !!row.enabled, vision: !!row.vision, available: !!row.available, providerName: row.provider_name || store.get('SELECT name FROM providers WHERE id=?', row.provider_id)?.name, status: row.status, lastCheckedAt: row.last_checked_at, error: row.error }; }
  const routeId = modelRouteId;
  function routeGroups() {
    const groups = new Map();
    for (const model of store.all('SELECT m.*,p.name AS provider_name,p.protocol,p.runtime FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.enabled=1 AND m.available=1 AND p.enabled=1 ORDER BY p.priority DESC,p.created_at,m.id')) { const key = routeId(model.route_key, model.variant_name); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(model); }
    return groups;
  }
  function usableModel(modelId, user) {
    const legacy = store.get('SELECT route_key,variant_name FROM models WHERE id=?', modelId);
    const groups = routeGroups();
    const key = legacy ? routeId(legacy.route_key, legacy.variant_name) : modelId;
    const rows = groups.get(key);
    if (!rows) throw fail(400, '模型或版本不可用，请选择其他模型或联系管理员。', 'MODEL_UNAVAILABLE');
    if (user && user.role !== 'admin') {
      const entitlement = billing.effectiveEntitlement(user.id);
      if (entitlement.allowedRoutes.length && !entitlement.allowedRoutes.includes(rows[0].route_key)) throw fail(403, '当前套餐不包含此模型，请升级套餐或选择其他模型。', 'PLAN_MODEL_RESTRICTED');
    }
    return { ...rows[0], id: key, name: rows[0].route_key, model_id: rows[0].route_key, vision: rows.some(row => row.vision) ? 1 : 0, channels: rows };
  }
  function publicModels() { return [...routeGroups()].map(([key, rows]) => ({ id: key, name: rows[0].route_key, modelId: rows[0].route_key, routeKey: rows[0].route_key, variantName: rows[0].variant_name, vision: rows.some(row => row.vision), enabled: true,
    modes: ['chat', ...(work.isConfigured() ? ['work'] : [])],
    contextWindow: rows.some(row => row.context_window) ? Math.max(...rows.map(row => row.context_window || 0)) : null,
    reasoningEfforts: ['auto', ...new Set(rows.flatMap(row => JSON.parse(row.reasoning_efforts || '[]')))],
    status: rows.some(row => row.status === 'ok') ? 'ok' : rows.every(row => row.status === 'error') ? 'error' : 'untested' })); }
  app.get('/api/models', (req, res) => { const allowed = billing.effectiveEntitlement(req.user.id).allowedRoutes; const models = publicModels().filter(model => req.user.role === 'admin' || !allowed.length || allowed.includes(model.routeKey)), configured = store.settings().defaultModelId; const legacy = configured ? store.get('SELECT route_key,variant_name FROM models WHERE id=?', configured) : null; const wanted = legacy ? routeId(legacy.route_key, legacy.variant_name) : configured; res.json({ models, defaultModelId: models.some(m => m.id === wanted) ? wanted : (models[0]?.id || null) }); });
  app.get('/api/settings', (req, res) => { const settings = store.settings(); if (req.user.role !== 'admin') delete settings.systemPrompt; res.json({ settings }); });
  function attachmentJSON(row) { return { id: row.id, name: row.name, mime: row.mime, size: row.size, kind: row.kind, url: `/api/files/${row.id}/download` }; }
  function chatJSON(row) { return { id: row.id, title: row.title, modelId: row.model_id, generating: active.has(row.id), mode: row.mode || 'chat', effort: row.effort || 'auto', skillIds: JSON.parse(row.skill_ids || '[]'), webSearch: !!row.web_search, pinned: !!row.pinned, archived: !!row.archived, createdAt: row.created_at, updatedAt: row.updated_at }; }
  function messageJSON(row) {
    const chunks = store.all('SELECT content,kind FROM message_chunks WHERE message_id=? ORDER BY seq', row.id);
    return { id: row.id, role: row.role, content: row.content + chunks.filter(chunk => chunk.kind === 'content').map(chunk => chunk.content).join(''), reasoning: (row.reasoning || '') + chunks.filter(chunk => chunk.kind === 'reasoning').map(chunk => chunk.content).join(''), modelId: row.model_id, status: row.status, canContinue: row.role === 'assistant' && ['error','stopped'].includes(row.status), error: row.error, createdAt: row.created_at, attachments: JSON.parse(row.attachment_ids).map(fileId => store.get('SELECT * FROM files WHERE id=?', fileId)).filter(Boolean).map(attachmentJSON) };
  }
  function executionOptions(body, row = {}) {
    const mode = body.mode ?? row.mode ?? 'chat', effort = body.effort ?? row.effort ?? 'auto';
    if (!['chat','work'].includes(mode)) throw fail(400, '请选择 Chat 或 Work 模式。');
    if (!['auto','low','medium','high','xhigh','max'].includes(effort)) throw fail(400, '思考强度无效。');
    const skillIds = body.skillIds ?? JSON.parse(row.skill_ids || '[]');
    if (!Array.isArray(skillIds) || skillIds.length > 10 || skillIds.some(value => typeof value !== 'string' || value.length > 100)) throw fail(400, '最多选择 10 个技能。');
    const webSearch = body.webSearch === undefined ? !!row.web_search : !!bool(body.webSearch, '网络搜索');
    return { mode, effort, skillIds: mode === 'work' ? [...new Set(skillIds)] : [], webSearch: mode === 'work' && webSearch };
  }
  function saveExecution(chatId, options) { store.run('UPDATE chats SET mode=?,effort=?,skill_ids=?,web_search=? WHERE id=?', options.mode, options.effort, JSON.stringify(options.skillIds), options.webSearch ? 1 : 0, chatId); }
  function ownedChat(req) { const chat = store.get('SELECT * FROM chats WHERE id=? AND user_id=?', req.params.id, req.user.id); if (!chat) throw fail(404, '对话不存在。'); return chat; }
  function ensureInactive(chatId) { if (active.has(chatId)) throw fail(409, '请先停止当前回复，再执行此操作。'); }
  app.get('/api/chats', (req, res) => res.json({ chats: store.all('SELECT * FROM chats WHERE user_id=? ORDER BY pinned DESC,updated_at DESC', req.user.id).map(chatJSON) }));
  app.post('/api/chats', (req, res) => { const execution = executionOptions(req.body); const chatId = id(), timestamp = now(), modelId = req.body.modelId || null; if (modelId) usableModel(modelId, req.user); store.run('INSERT INTO chats(id,user_id,title,model_id,created_at,updated_at) VALUES (?,?,?,?,?,?)', chatId, req.user.id, cleanText(req.body.title, 120) || '新对话', modelId, timestamp, timestamp); saveExecution(chatId, execution); res.status(201).json({ chat: chatJSON(store.get('SELECT * FROM chats WHERE id=?', chatId)) }); });
  app.get('/api/chats/:id', (req, res) => { const chat = ownedChat(req); res.json({ chat: chatJSON(chat), generating: active.has(chat.id), messages: store.all('SELECT * FROM messages WHERE chat_id=? ORDER BY rowid', chat.id).map(messageJSON) }); });
  app.patch('/api/chats/:id', (req, res) => { const chat = ownedChat(req); ensureInactive(chat.id); const execution = executionOptions(req.body, chat); const title = req.body.title === undefined ? chat.title : requiredText(req.body.title, '对话标题', 120); const pinned = req.body.pinned === undefined ? chat.pinned : bool(req.body.pinned, '置顶'); const archived = req.body.archived === undefined ? chat.archived : bool(req.body.archived, '归档'); const modelId = req.body.modelId === undefined ? chat.model_id : usableModel(req.body.modelId, req.user).id; store.run('UPDATE chats SET title=?,pinned=?,archived=?,model_id=?,updated_at=? WHERE id=?', title, pinned, archived, modelId, now(), chat.id); saveExecution(chat.id, execution); res.json({ chat: chatJSON(store.get('SELECT * FROM chats WHERE id=?', chat.id)) }); });
  function removeOrphanedAttachments(candidates, userId) {
    const referenced = new Set(store.all('SELECT attachment_ids FROM messages m JOIN chats c ON c.id=m.chat_id WHERE c.user_id=?', userId).flatMap(row => JSON.parse(row.attachment_ids)));
    for (const fileId of new Set(candidates)) if (!referenced.has(fileId)) { store.run('DELETE FROM files WHERE id=? AND user_id=?', fileId, userId); try { unlinkSync(join(dataDir, 'files', fileId)); } catch {} }
  }
  function cleanAbandonedUploads() {
    const expired = new Date(Date.now() - 86400_000).toISOString();
    const grouped = new Map();
    for (const file of store.all('SELECT id,user_id FROM files WHERE created_at<?', expired)) { if (!grouped.has(file.user_id)) grouped.set(file.user_id, []); grouped.get(file.user_id).push(file.id); }
    for (const [userId, files] of grouped) if (![...active.values()].some(job => job.userId === userId)) removeOrphanedAttachments(files, userId);
  }
  app.delete('/api/chats/:id', (req, res) => { const chat = ownedChat(req); ensureInactive(chat.id); const files = store.all('SELECT attachment_ids FROM messages WHERE chat_id=?', chat.id).flatMap(row => JSON.parse(row.attachment_ids)); store.run('DELETE FROM chats WHERE id=?', chat.id); removeOrphanedAttachments(files, req.user.id); res.json({ ok: true }); });
  app.post('/api/files', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: '上传过于频繁，请稍后重试。' } }), upload.array('files', 5), async (req, res) => {
    if (!req.files?.length) throw fail(400, '请选择要上传的文件。');
    const used = store.get('SELECT COALESCE(SUM(size),0) AS size, COUNT(*) AS count FROM files WHERE user_id=?', req.user.id);
    const limit = Number(process.env.USER_STORAGE_MB || 200) * 1024 * 1024;
    if (used.size + req.files.reduce((n, f) => n + f.size, 0) > limit || used.count + req.files.length > 500) throw fail(413, '文件存储额度不足，请先删除不需要的附件。');
    const parsed = [];
    for (const file of req.files) parsed.push(await extractUpload(file));
    const currentUser = store.get('SELECT disabled FROM users WHERE id=?', req.user.id);
    if (!currentUser || currentUser.disabled) throw fail(403, '账号已停用。');
    const currentUsage = store.get('SELECT COALESCE(SUM(size),0) AS size,COUNT(*) AS count FROM files WHERE user_id=?', req.user.id);
    if (currentUsage.size + parsed.reduce((n, file) => n + file.size, 0) > limit || currentUsage.count + parsed.length > 500) throw fail(413, '文件存储额度不足，请先删除不需要的附件。');
    const saved = [];
    try {
      for (const file of parsed) { const fileId = id(); writeFileSync(join(dataDir, 'files', fileId), file.buffer, { mode: 0o600, flag: 'wx' }); saved.push(fileId); store.run('INSERT INTO files(id,user_id,name,mime,size,kind,text_content,created_at) VALUES (?,?,?,?,?,?,?,?)', fileId, req.user.id, file.name, file.mime, file.size, file.kind, file.text || null, now()); }
    } catch (error) { for (const fileId of saved) { store.run('DELETE FROM files WHERE id=?', fileId); try { unlinkSync(join(dataDir, 'files', fileId)); } catch {} } throw error; }
    res.status(201).json({ files: saved.map(fileId => attachmentJSON(store.get('SELECT * FROM files WHERE id=?', fileId))) });
  });
  app.get('/api/files/:id/download', (req, res) => { const file = store.get('SELECT * FROM files WHERE id=? AND user_id=?', req.params.id, req.user.id); if (!file) throw fail(404, '文件不存在。'); const path = join(dataDir, 'files', file.id); if (!existsSync(path)) throw fail(404, '文件不存在。'); res.type(file.kind === 'image' ? file.mime : 'application/octet-stream'); res.set('Content-Disposition', `${file.kind === 'image' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`); res.sendFile(resolve(path)); });
  app.delete('/api/files/:id', (req, res) => { const file = store.get('SELECT * FROM files WHERE id=? AND user_id=?', req.params.id, req.user.id); if (!file) throw fail(404, '文件不存在。'); for (const value of active.values()) if (value.userId === req.user.id) throw fail(409, '请先停止当前回复再删除附件。'); store.run('DELETE FROM files WHERE id=?', file.id); try { unlinkSync(join(dataDir, 'files', file.id)); } catch {} res.json({ ok: true }); });
  function attachmentIds(value, userId) { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 5 || value.some(v => typeof v !== 'string')) throw fail(400, '每条消息最多添加 5 个附件。'); const ids = [...new Set(value)]; for (const fileId of ids) if (!store.get('SELECT id FROM files WHERE id=? AND user_id=?', fileId, userId)) throw fail(404, '附件不存在或不属于当前账号。'); return ids; }
  function validateContent(content, fileIds) { if (typeof content !== 'string' || Buffer.byteLength(content) > messageLimit || (!content.trim() && !fileIds.length)) throw fail(400, '请输入消息或添加附件；单条消息正文不能超过 32 MB。'); return content.trim(); }
  function modelMessages(rows, userId, model) { let total = 0; const messages = rows.map(row => ({ role: row.role, content: row.content, attachments: JSON.parse(row.attachment_ids).map(fileId => {
    const file = store.get('SELECT * FROM files WHERE id=? AND user_id=?', fileId, userId); if (!file) throw fail(400, '对话中的附件已删除，请编辑原消息移除附件后重试。');
    if (file.kind === 'image' && !model.vision) throw fail(400, '该模型未启用图片输入，请选择支持图片的模型或联系管理员。');
    total += file.kind === 'image' ? Math.ceil(file.size / 3) * 4 : Buffer.byteLength(file.text_content || '');
    return { ...attachmentJSON(file), text: file.text_content || undefined, ...(file.kind === 'image' ? { dataUrl: `data:${file.mime};base64,${readFileSync(join(dataDir, 'files', file.id)).toString('base64')}` } : {}) };
  }) })); total += messages.reduce((n, m) => n + Buffer.byteLength(m.content), 0); if (total > 32 * 1024 * 1024) throw fail(413, '完整对话及附件超过 32 MB 传输上限，请减少附件或新建对话；历史未被自动截断。'); return messages; }
  async function generate(req, res, action) {
    const chat = ownedChat(req); ensureInactive(chat.id);
    const modelRow = usableModel(requiredText(req.body.modelId || chat.model_id || store.settings().defaultModelId, '模型', 100), req.user);
    const model = modelJSON(modelRow);
    const execution = executionOptions(req.body, chat);
    const compatible = modelRow.channels.filter(row => execution.effort === 'auto' || JSON.parse(row.reasoning_efforts || '[]').includes(execution.effort));
    if (!compatible.length) throw fail(400, '当前模型不支持所选模式或思考强度，请选择自动强度或其他模型。');
    if ((execution.mode === 'work' || compatible.every(row => row.runtime === 'claude-code')) && !work.isConfigured()) throw fail(503, '工作沙箱尚未配置，请先完成 Work 部署或选择直接 API 的 Chat 模式。');
    const settings = store.settings();
    const dailyLimit = billing.effectiveEntitlement(req.user.id).dailyLimit;
    const count = store.get('SELECT COUNT(*) AS count FROM requests WHERE user_id=? AND created_at>=?', req.user.id, `${now().slice(0, 10)}T00:00:00.000Z`).count;
    if (count >= dailyLimit) throw fail(429, '今日请求额度已用完，请明天再试或联系管理员。');
    const userConcurrency = Math.min(32, Math.max(1, Number(process.env.MAX_CONCURRENT_PER_USER) || 4));
    if ([...active.values()].filter(v => v.userId === req.user.id).length >= userConcurrency || active.size >= Number(process.env.MAX_CONCURRENT_CHATS || 10)) throw fail(429, `当前并行任务已达到上限（每人 ${userConcurrency} 个），请等待已有任务完成。`);
    const existing = store.all('SELECT rowid AS sort_index,* FROM messages WHERE chat_id=? ORDER BY rowid', chat.id);
    const tail = existing.at(-1);
    if (action === 'message' && tail?.role === 'assistant' && tail.status !== 'streaming' && !req.body.attachmentIds?.length && isContinuationRequest(req.body.content)) action = 'continue';
    const continuing = action === 'continue';
    if (continuing && (!tail || tail.role !== 'assistant' || tail.status === 'streaming' || (req.body.messageId && req.body.messageId !== tail.id))) throw fail(409, '只能继续当前对话最后一条回答，请刷新后重试。');
    // Interrupted assistant text remains conversation context for follow-ups.
    let selected = existing.filter(m => m.role === 'user' || m.content || m.status === 'complete'), userMessage;
    const timestamp = now();
    if (action === 'message' || action === 'edit') {
      const files = attachmentIds(req.body.attachmentIds, req.user.id), content = validateContent(req.body.content, files);
      const edited = action === 'edit' ? existing.find(m => m.id === req.body.messageId && m.role === 'user') : null;
      if (action === 'edit' && !edited) throw fail(404, '找不到要编辑的消息。');
      if (action === 'edit') selected = selected.filter(m => m.sort_index < edited.sort_index);
      userMessage = { id: edited?.id || id(), chat_id: chat.id, role: 'user', content, model_id: model.id, status: 'complete', attachment_ids: JSON.stringify(files), error: null, created_at: edited?.created_at || timestamp };
      selected.push(userMessage);
    } else if (!continuing) {
      const userIndex = selected.findLastIndex(m => m.role === 'user');
      if (userIndex === -1) throw fail(400, '请先发送一条消息。');
      selected = selected.slice(0, userIndex + 1);
    }
    const input = modelMessages(selected, req.user.id, model);
    if (continuing) input.push({ role: 'user', content: continuationInstruction, attachments: [] });
    const resumeCandidates = continuing && work.continuationCandidates ? work.continuationCandidates({ userId: req.user.id, chatId: chat.id, assistantId: tail.id }, compatible) : compatible;
    if (!resumeCandidates.length) throw fail(409, '原工作记录对应的模型或协议当前不可用，请恢复原模型渠道后继续；已保存的内容和文件会保留。', 'WORK_CHECKPOINT_INCOMPATIBLE');
    const capacity = checkContext(input, settings.systemPrompt, resumeCandidates, settings.maxOutputTokens);
    // Unknown metadata must not impose a guessed context ceiling. Prefer a
    // declared fitting channel; the upstream enforces the actual token count.
    const candidateIds = capacity.compatible.length ? capacity.compatible.map(row => row.id) : resumeCandidates.map(row => row.id);
    const assistantId = continuing ? tail.id : id(), requestId = id();
    const priorContent = continuing ? tail.content : '';
    store.transaction(() => {
      modelAccess.assertCanGenerate(req.user.id, modelRow.route_key, modelRow.variant_name, { at: timestamp });
      if (action === 'edit') { const edited = existing.find(m => m.id === req.body.messageId); store.run('DELETE FROM messages WHERE chat_id=? AND rowid>=?', chat.id, edited.sort_index); }
      if (action === 'regenerate') { const lastUser = selected.at(-1); store.run('DELETE FROM messages WHERE chat_id=? AND rowid>?', chat.id, lastUser.sort_index); }
      if (userMessage) store.run('INSERT INTO messages(id,chat_id,role,content,model_id,status,attachment_ids,created_at) VALUES (?,?,?,?,?,?,?,?)', userMessage.id, chat.id, 'user', userMessage.content, model.id, 'complete', userMessage.attachment_ids, userMessage.created_at);
      if (continuing) store.run("UPDATE messages SET status='streaming',error=NULL,model_id=? WHERE id=?", model.id, assistantId);
      else store.run('INSERT INTO messages(id,chat_id,role,content,model_id,status,created_at) VALUES (?,?,?,?,?,?,?)', assistantId, chat.id, 'assistant', '', model.id, 'streaming', timestamp);
      store.run('INSERT INTO requests(id,user_id,model_id,route_key,variant_name,status,created_at) VALUES (?,?,?,?,?,?,?)', requestId, req.user.id, model.id, modelRow.route_key, modelRow.variant_name, 'running', timestamp);
      const first = selected.find(m => m.role === 'user');
      const title = chat.title === '新对话' ? (first?.content.slice(0, 40) || '文件分析') : chat.title;
      store.run('UPDATE chats SET title=?,model_id=?,updated_at=?,archived=0 WHERE id=?', title, model.id, timestamp, chat.id);
      saveExecution(chat.id, execution);
    });
    const controller = new AbortController();
    active.set(chat.id, { controller, userId: req.user.id, providerIds: modelRow.channels.map(row => row.provider_id) });
    if (action === 'edit') removeOrphanedAttachments(existing.flatMap(row => JSON.parse(row.attachment_ids)), req.user.id);
    const abort = () => controller.abort();
    res.on('close', abort);
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (event, data) => { if (!res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15_000);
    const usesRunner = execution.mode === 'work' || compatible.some(row => row.runtime === 'claude-code');
    const taskSeconds = usesRunner ? Math.min(1800, Math.max(30, Number(settings.workSettings?.timeoutSeconds) || 600)) + 60 : Math.min(21600, Math.max(60, Number(process.env.CHAT_TIMEOUT_SECONDS) || 3600));
    const timeout = setTimeout(() => controller.abort(), taskSeconds * 1000);
    send('meta', { ...(userMessage ? { userMessage: messageJSON(userMessage) } : {}), assistantMessage: messageJSON(store.get('SELECT * FROM messages WHERE id=?', assistantId)), chat: chatJSON(store.get('SELECT * FROM chats WHERE id=?', chat.id)) });
    let content = priorContent, reasoning = continuing ? tail.reasoning || '' : '';
    let contentBytes = Buffer.byteLength(content) + Buffer.byteLength(reasoning);
    const appender = continuationAppender(priorContent);
    const splitter = reasoningSplitter();
    let reasoningStarted = false;
    function append(text, kind = 'content') {
      if (!text) return;
      if (kind === 'reasoning' && !reasoningStarted && reasoning) text = `\n\n${text}`;
      const deltaBytes = Buffer.byteLength(text);
      if (contentBytes + deltaBytes > 32 * 1024 * 1024) throw fail(413, '已保存的回答与思考过程达到 32 MB 安全上限。');
      // Append-only chunks make every displayed byte durable without rewriting
      // a growing multi-megabyte answer on every token.
      store.run('INSERT INTO message_chunks(message_id,content,kind) VALUES (?,?,?)', assistantId, text, kind);
      if (kind === 'reasoning') { reasoning += text; reasoningStarted = true; }
      else content += text;
      contentBytes += deltaBytes;
      send(kind === 'reasoning' ? 'reasoning' : 'delta', { text });
    }
    function separate(events) { for (const event of events) append(event.type === 'reasoning' ? event.text : appender.push(event.text), event.type === 'reasoning' ? 'reasoning' : 'content'); }
    function finishMessage(status, error = null) { store.transaction(() => { store.run('UPDATE messages SET content=?,reasoning=?,status=?,error=? WHERE id=?', content, reasoning, status, error, assistantId); store.run('DELETE FROM message_chunks WHERE message_id=?', assistantId); }); }
    try {
      for await (const event of router.run({ routeKey: modelRow.route_key, variantName: modelRow.variant_name, candidateIds, messages: input, maxOutputTokens: settings.maxOutputTokens, systemPrompt: settings.systemPrompt, signal: controller.signal, maxAttempts: settings.routingMaxAttempts, retriesPerChannel: settings.retriesPerChannel, requestId, ...execution, context: { userId: req.user.id, chatId: chat.id, assistantId, continuation: continuing, resumeText: priorContent } })) {
        if (event.type === 'routing') send('routing', { message: '正在重新连接，请稍候…' });
        if (event.type === 'activity') send('activity', { label: event.label });
        if (event.type === 'artifact') send('artifact', { artifact: event.artifact });
        if (event.type === 'selected') store.run('UPDATE messages SET source_provider=?,source_model=? WHERE id=?', event.providerName, event.upstreamModelId, assistantId);
        if (event.type === 'delta') separate(splitter.push(event.text));
        if (event.type === 'reasoning') append(event.text, 'reasoning');
        if (event.type === 'usage') store.run('UPDATE requests SET input_tokens=?,output_tokens=? WHERE id=?', event.inputTokens || 0, event.outputTokens || 0, requestId);
      }
      separate(splitter.finish()); append(appender.finish());
      if (!content.trim() || content === priorContent) throw fail(502, '上游没有返回新的可显示文字，已保留原内容，可以继续生成。');
      finishMessage('complete');
      store.run("UPDATE requests SET status='complete' WHERE id=?", requestId);
      send('done', { message: messageJSON(store.get('SELECT * FROM messages WHERE id=?', assistantId)) });
    } catch (error) {
      try { separate(splitter.finish()); append(appender.finish()); } catch { /* Preserve committed text when the safety ceiling was reached. */ }
      const stopped = controller.signal.aborted || error.name === 'AbortError';
      const errorText = stopped ? null : req.user.role === 'admin' ? sanitizeUpstreamError(error) : '本次回答未完成，请稍后重试或联系管理员。';
      finishMessage(stopped ? 'stopped' : 'error', errorText);
      store.run('UPDATE requests SET status=? WHERE id=?', stopped ? 'stopped' : 'error', requestId);
      const message = messageJSON(store.get('SELECT * FROM messages WHERE id=?', assistantId));
      if (stopped) send('done', { message }); else send('error', { error: errorText, message });
    } finally { clearInterval(heartbeat); clearTimeout(timeout); res.off('close', abort); active.delete(chat.id); store.run('UPDATE chats SET updated_at=? WHERE id=?', now(), chat.id); if (!res.writableEnded) res.end(); }
  }
  app.post('/api/chats/:id/messages', (req, res) => generate(req, res, 'message'));
  app.post('/api/chats/:id/regenerate', (req, res) => generate(req, res, 'regenerate'));
  app.post('/api/chats/:id/continue', (req, res) => generate(req, res, 'continue'));
  app.post('/api/chats/:id/edit', (req, res) => generate(req, res, 'edit'));
  app.post('/api/chats/:id/stop', (req, res) => { const chat = ownedChat(req); active.get(chat.id)?.controller.abort(); res.json({ ok: true }); });

  app.use('/api/admin', admin);
  app.get('/api/admin/providers', (_req, res) => res.json({ providers: store.all('SELECT * FROM providers ORDER BY priority DESC,created_at').map(providerJSON) }));
  function routingConfig(body, row = {}) {
    const authMode = body.authMode ?? row.auth_mode ?? 'auto';
    const runtime = body.runtime ?? row.runtime ?? 'api';
    const responsesProfile = body.responsesProfile ?? row.responses_profile ?? 'auto';
    if (!responseProfiles.includes(responsesProfile)) throw fail(400, '请选择有效的 Responses 请求格式。');
    if (!['api','claude-code'].includes(runtime)) throw fail(400, '请选择有效的执行方式。');
    if (runtime === 'claude-code' && (body.protocol || row.protocol) !== 'anthropic') throw fail(400, 'Claude Code 执行方式需要 Anthropic Messages 协议。');
    if (!['auto', 'bearer', 'x-api-key'].includes(authMode)) throw fail(400, '请选择有效的认证方式。');
    return { authMode, runtime, responsesProfile, failureProtectionEnabled: body.failureProtectionEnabled === undefined ? row.failure_protection_enabled ?? 1 : bool(body.failureProtectionEnabled, '失败冷却'), priority: number(body.priority ?? row.priority ?? 0, 0, 1000, '渠道优先级'), failureThreshold: number(body.failureThreshold ?? row.failure_threshold ?? 3, 1, 1000, '连续失败阈值'), cooldownSeconds: number(body.cooldownSeconds ?? row.cooldown_seconds ?? 60, 1, 2592000, '冷却秒数') };
  }
  app.post('/api/admin/providers', async (req, res) => {
    const name = requiredText(req.body.name, '接口名称', 80), baseUrl = await validateBaseUrl(requiredText(req.body.baseUrl, '接口地址', 1000)), apiKey = requiredText(req.body.apiKey, 'API Key', 4000);
    if (!protocols.has(req.body.protocol)) throw fail(400, '请选择有效的接口协议。');
    const routing = routingConfig(req.body);
    const providerId = id();
    store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,enabled,created_at,priority,failure_threshold,cooldown_seconds,auth_mode,runtime,responses_profile,failure_protection_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', providerId, name, baseUrl, req.body.protocol, store.encrypt(apiKey), `••••${apiKey.slice(-4)}`, req.body.enabled === undefined ? 1 : bool(req.body.enabled, '启用'), now(), routing.priority, routing.failureThreshold, routing.cooldownSeconds, routing.authMode, routing.runtime, routing.responsesProfile, routing.failureProtectionEnabled);
    res.status(201).json({ provider: providerJSON(store.get('SELECT * FROM providers WHERE id=?', providerId)) });
  });
  function getProvider(providerId) { const row = store.get('SELECT * FROM providers WHERE id=?', providerId); if (!row) throw fail(404, '接口不存在。'); return row; }
  function auditAdminFailure(error, providerId, modelId, source) {
    if (!error.rawDiagnostic) return;
    const auditId = id();
    store.run('INSERT INTO route_attempts(id,request_id,provider_id,model_id,outcome,error,created_at,encrypted_detail) VALUES (?,?,?,?,?,?,?,?)', auditId, `${source}-${auditId}`, providerId, modelId, 'error', sanitizeUpstreamError(error), now(), store.encrypt(JSON.stringify(error.rawDiagnostic)));
    store.run("DELETE FROM route_attempts WHERE outcome<>'running' AND rowid NOT IN (SELECT rowid FROM route_attempts ORDER BY rowid DESC LIMIT 200)");
  }
  app.patch('/api/admin/providers/:id', async (req, res) => {
    const row = getProvider(req.params.id), name = req.body.name === undefined ? row.name : requiredText(req.body.name, '接口名称', 80);
    ensureProviderIdle(row.id);
    const baseUrl = req.body.baseUrl === undefined ? row.base_url : await validateBaseUrl(requiredText(req.body.baseUrl, '接口地址', 1000));
    const protocol = req.body.protocol || row.protocol; if (!protocols.has(protocol)) throw fail(400, '请选择有效的接口协议。');
    const apiKey = req.body.apiKey ? requiredText(req.body.apiKey, 'API Key', 4000) : null;
    const routing = routingConfig(req.body, row);
    ensureProviderIdle(row.id);
    store.run('UPDATE providers SET name=?,base_url=?,protocol=?,encrypted_key=?,key_hint=?,enabled=?,priority=?,failure_threshold=?,cooldown_seconds=?,auth_mode=?,runtime=?,responses_profile=?,failure_protection_enabled=? WHERE id=?', name, baseUrl, protocol, apiKey ? store.encrypt(apiKey) : row.encrypted_key, apiKey ? `••••${apiKey.slice(-4)}` : row.key_hint, req.body.enabled === undefined ? row.enabled : bool(req.body.enabled, '启用'), routing.priority, routing.failureThreshold, routing.cooldownSeconds, routing.authMode, routing.runtime, routing.responsesProfile, routing.failureProtectionEnabled, row.id);
    if (routing.failureProtectionEnabled !== row.failure_protection_enabled || routing.failureThreshold !== row.failure_threshold || routing.cooldownSeconds !== row.cooldown_seconds) store.run('UPDATE models SET failure_count=0,cooldown_until=NULL,failure_epoch=failure_epoch+1 WHERE provider_id=?', row.id);
    if (baseUrl !== row.base_url || protocol !== row.protocol || apiKey || routing.authMode !== row.auth_mode || routing.runtime !== row.runtime || routing.responsesProfile !== row.responses_profile) store.run("UPDATE models SET status='untested',last_checked_at=NULL,error=NULL,failure_count=0,cooldown_until=NULL,failure_epoch=failure_epoch+1 WHERE provider_id=?", row.id);
    res.json({ provider: providerJSON(getProvider(row.id)) });
  });
  app.delete('/api/admin/providers/:id', (req, res) => { getProvider(req.params.id); ensureProviderIdle(req.params.id); store.run('DELETE FROM providers WHERE id=?', req.params.id); res.json({ ok: true }); });
  app.post('/api/admin/providers/:id/sync', async (req, res) => {
    const row = getProvider(req.params.id); if (syncing.has(row.id)) throw fail(409, '接口正在同步。'); syncing.add(row.id);
    try {
      const models = await listModels({ ...providerJSON(row), apiKey: store.decrypt(row.encrypted_key) });
      if (!Array.isArray(models) || models.length > 5000) throw fail(502, '上游模型列表格式或数量异常。');
      store.transaction(() => {
        store.run('UPDATE models SET available=0 WHERE provider_id=? AND manual=0', row.id);
        for (const model of models) { const modelId = requiredText(model.modelId, '模型 ID', 300); store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,reasoning_efforts,context_window,max_output_tokens,enabled,available) VALUES (?,?,?,?,?,?,?,?,0,1) ON CONFLICT(provider_id,model_id) DO UPDATE SET available=1,context_window=COALESCE(models.context_window,excluded.context_window),max_output_tokens=COALESCE(models.max_output_tokens,excluded.max_output_tokens)', id(), row.id, modelId, cleanText(model.name, 300) || modelId, modelId, JSON.stringify(initialEfforts(modelId)), model.contextWindow ?? null, model.maxOutputTokens ?? null); }
        store.run('UPDATE providers SET last_synced_at=?,last_sync_error=NULL WHERE id=?', now(), row.id);
      });
      res.json({ models: store.all('SELECT * FROM models WHERE provider_id=? ORDER BY name', row.id).map(modelJSON), count: models.length });
    } catch (error) { const message = sanitizeUpstreamError(error); store.run('UPDATE providers SET last_sync_error=? WHERE id=?', message, row.id); auditAdminFailure(error, row.id, '[模型同步]', 'sync'); throw fail(error.status || 502, message); } finally { syncing.delete(row.id); }
  });
  app.get('/api/admin/models', (_req, res) => res.json({ models: store.all('SELECT m.*,p.name AS provider_name FROM models m JOIN providers p ON p.id=m.provider_id ORDER BY p.name,m.name').map(modelJSON), defaultModelId: store.settings().defaultModelId }));
  function modelProtection(body, row = {}) {
    return {
      enabled: body.failureProtectionEnabled === undefined ? row.failure_protection_enabled ?? null : body.failureProtectionEnabled === null ? null : bool(body.failureProtectionEnabled, '失败冷却'),
      threshold: body.failureThreshold === undefined ? row.failure_threshold_override ?? null : body.failureThreshold === null ? null : number(body.failureThreshold, 1, 1000, '连续失败阈值'),
      seconds: body.cooldownSeconds === undefined ? row.cooldown_seconds_override ?? null : body.cooldownSeconds === null ? null : number(body.cooldownSeconds, 1, 2592000, '冷却秒数'),
    };
  }
  app.post('/api/admin/models', (req, res) => {
    const provider = getProvider(req.body.providerId), modelId = requiredText(req.body.modelId, '模型 ID', 300);
    if (store.get('SELECT id FROM models WHERE provider_id=? AND model_id=?', provider.id, modelId)) throw fail(409, '该模型已存在。');
    const modelInternalId = id(), routeKey = req.body.routeKey ? requiredText(req.body.routeKey, '统一模型名', 300) : modelId, protection = modelProtection(req.body);
    store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,vision,reasoning_efforts,context_window,max_output_tokens,manual,variant_name,catalog_assigned,failure_protection_enabled,failure_threshold_override,cooldown_seconds_override) VALUES (?,?,?,?,?,?,?,?,?,1,?,1,?,?,?)', modelInternalId, provider.id, modelId, cleanText(req.body.name, 300) || modelId, routeKey, req.body.vision === undefined ? 0 : bool(req.body.vision, '图片输入'), JSON.stringify(req.body.reasoningEfforts === undefined ? initialEfforts(modelId) : reasoningEfforts(req.body.reasoningEfforts)), req.body.contextWindow === undefined ? null : capacityValue(req.body.contextWindow, '上下文容量', 1024, 10_000_000), req.body.maxOutputTokens === undefined ? null : capacityValue(req.body.maxOutputTokens, '模型最大输出', 128, 1_000_000), variantName(req.body.variantName), protection.enabled, protection.threshold, protection.seconds);
    res.status(201).json({ model: modelJSON(store.get('SELECT * FROM models WHERE id=?', modelInternalId)) });
  });
  app.patch('/api/admin/models/:id', (req, res) => {
    const row = store.get('SELECT * FROM models WHERE id=?', req.params.id); if (!row) throw fail(404, '模型不存在。'); ensureProviderIdle(row.provider_id);
    const enabled = req.body.enabled === undefined ? row.enabled : bool(req.body.enabled, '启用');
    const routeKey = req.body.routeKey === undefined ? row.route_key : requiredText(req.body.routeKey, '统一模型名', 300);
    const version = req.body.variantName === undefined ? row.variant_name : variantName(req.body.variantName), protection = modelProtection(req.body, row);
    if (req.body.isDefault === true && !enabled) throw fail(400, '请先启用该模型再设为默认。');
    store.transaction(() => {
      store.run('UPDATE models SET name=?,enabled=?,vision=?,route_key=?,reasoning_efforts=?,context_window=?,max_output_tokens=? WHERE id=?', req.body.name === undefined ? row.name : requiredText(req.body.name, '显示名称', 300), enabled, req.body.vision === undefined ? row.vision : bool(req.body.vision, '图片输入'), routeKey, req.body.reasoningEfforts === undefined ? row.reasoning_efforts : JSON.stringify(reasoningEfforts(req.body.reasoningEfforts)), req.body.contextWindow === undefined ? row.context_window : capacityValue(req.body.contextWindow, '上下文容量', 1024, 10_000_000), req.body.maxOutputTokens === undefined ? row.max_output_tokens : capacityValue(req.body.maxOutputTokens, '模型最大输出', 128, 1_000_000), row.id);
      store.run('UPDATE models SET variant_name=?,catalog_assigned=1,failure_protection_enabled=?,failure_threshold_override=?,cooldown_seconds_override=? WHERE id=?', version, protection.enabled, protection.threshold, protection.seconds, row.id);
      if (protection.enabled !== row.failure_protection_enabled || protection.threshold !== row.failure_threshold_override || protection.seconds !== row.cooldown_seconds_override) store.run('UPDATE models SET failure_count=0,cooldown_until=NULL,failure_epoch=failure_epoch+1 WHERE id=?', row.id);
      if (req.body.isDefault === true) { usableModel(row.id); store.setSetting('defaultModelId', row.id); }
      if (!enabled && store.settings().defaultModelId === row.id) store.setSetting('defaultModelId', null);
    });
    res.json({ model: modelJSON(store.get('SELECT * FROM models WHERE id=?', row.id)) });
  });
  app.delete('/api/admin/models/:id', (req, res) => { const model = store.get('SELECT * FROM models WHERE id=?', req.params.id); if (model) ensureProviderIdle(model.provider_id); store.run('DELETE FROM models WHERE id=?', req.params.id); if (store.settings().defaultModelId === req.params.id) store.setSetting('defaultModelId', null); res.json({ ok: true }); });
  app.post('/api/admin/models/:id/reset-health', (req, res) => { const model = store.get('SELECT * FROM models WHERE id=?', req.params.id); if (!model) throw fail(404, '模型不存在。'); ensureProviderIdle(model.provider_id); store.run("UPDATE models SET failure_count=0,cooldown_until=NULL,failure_epoch=failure_epoch+1,status='untested',error=NULL WHERE id=?", model.id); res.json({ model: modelJSON(store.get('SELECT * FROM models WHERE id=?', model.id)) }); });
  app.get('/api/admin/routing-logs', (_req, res) => res.json({ attempts: store.all('SELECT a.*,p.name AS provider_name,m.model_id AS upstream_model_id FROM route_attempts a LEFT JOIN providers p ON p.id=a.provider_id LEFT JOIN models m ON m.id=a.model_id ORDER BY a.rowid DESC LIMIT 200').map(row => ({ id: row.id, requestId: row.request_id, providerName: row.provider_name || '已删除渠道', modelId: row.upstream_model_id || row.model_id, outcome: row.outcome, error: row.error, createdAt: row.created_at, hasDetail: !!row.encrypted_detail })) }));
  app.get('/api/admin/routing-logs/:id/detail', (req, res) => { const row = store.get('SELECT encrypted_detail FROM route_attempts WHERE id=?', req.params.id); if (!row?.encrypted_detail) throw fail(404, '原始报错不存在或已清理。'); res.set('Cache-Control','no-store').json({ detail: JSON.parse(store.decrypt(row.encrypted_detail)) }); });
  app.post('/api/admin/models/:id/test', async (req, res) => {
    const row = store.get('SELECT * FROM models WHERE id=?', req.params.id); if (!row) throw fail(404, '模型不存在。'); if (testing.has(row.id) || testing.size >= 2) throw fail(429, '模型测试正在进行，请稍后重试。'); testing.set(row.id, row.provider_id);
    const start = Date.now();
    try { let text = ''; for await (const event of streamModel({ provider: providerForModel(row), model: modelJSON(row), messages: [{ role: 'user', content: 'Reply with OK.', attachments: [] }], maxOutputTokens: 256, systemPrompt: '', mode: 'chat', effort: 'auto', diagnostics: true, signal: AbortSignal.timeout(45_000) })) if (event.type === 'delta') text += event.text; if (!text.trim()) throw fail(502, '上游没有返回文字。'); store.run("UPDATE models SET status='ok',last_checked_at=?,error=NULL,failure_count=0,cooldown_until=NULL,failure_epoch=failure_epoch+1 WHERE id=?", now(), row.id); res.json({ ok: true, latencyMs: Date.now() - start }); }
    catch (error) {
      const message = sanitizeUpstreamError(error);
      store.run("UPDATE models SET status='error',last_checked_at=?,error=? WHERE id=?", now(), message, row.id);
      // Diagnostics stay in admin-only responses and encrypted audit storage.
      const provider = providerJSON(getProvider(row.provider_id));
      const diagnostic = error.adminDiagnostic ? { ...error.adminDiagnostic, ...(error.rawDiagnostic ? { raw: error.rawDiagnostic } : {}) }
        : error.rawDiagnostic ? { version: 2, protocol: provider.protocol, authMode: provider.authMode,
          method: error.rawDiagnostic.method || 'POST', path: '/v1/messages', modelId: row.model_id,
          upstreamStatus: error.rawDiagnostic.status, responseFormat: provider.runtime === 'claude-code' ? 'claude-code' : 'upstream',
          note: '请展开原始报错信息查看执行器或上游返回的内容。', raw: error.rawDiagnostic } : undefined;
      auditAdminFailure(error, row.provider_id, row.id, 'test');
      const explanation = error.adminDetail ? `上游说明（已脱敏）：${error.adminDetail}` : diagnostic?.note;
      res.json({ ok: false, error: explanation ? `${message} ${explanation}` : message,
        ...(diagnostic ? { diagnostic } : {}), latencyMs: Date.now() - start });
    }
    finally { testing.delete(row.id); }
  });
  app.get('/api/admin/users', (_req, res) => res.json({ users: store.all('SELECT * FROM users ORDER BY created_at').map(userJSON) }));
  app.patch('/api/admin/users/:id', (req, res) => { const user = store.get('SELECT * FROM users WHERE id=?', req.params.id); if (!user) throw fail(404, '用户不存在。'); if (user.role === 'admin' && req.body.disabled === true) throw fail(400, '不能停用管理员账号。'); const disabled = req.body.disabled === undefined ? user.disabled : bool(req.body.disabled, '停用'); const dailyLimit = req.body.dailyLimit === undefined ? user.daily_limit : req.body.dailyLimit === null ? null : number(req.body.dailyLimit, 0, 100_000, '每日请求额度'); store.run('UPDATE users SET disabled=?,daily_limit=? WHERE id=?', disabled, dailyLimit, user.id); if (disabled) { store.run('DELETE FROM sessions WHERE user_id=?', user.id); for (const job of active.values()) if (job.userId === user.id) job.controller.abort(); } res.json({ user: userJSON(store.get('SELECT * FROM users WHERE id=?', user.id)) }); });
  app.get('/api/admin/invites', (_req, res) => res.json({ invites: store.all('SELECT * FROM invites ORDER BY created_at DESC').map(row => ({ id: row.id, email: row.email, expiresAt: row.expires_at, usedAt: row.used_at, createdAt: row.created_at })) }));
  app.post('/api/admin/invites', (req, res) => { const email = req.body.email ? validEmail(req.body.email) : null, days = req.body.days === undefined ? 7 : number(req.body.days, 1, 30, '有效天数'); const token = randomBytes(32).toString('base64url'), inviteId = id(), expiresAt = new Date(Date.now() + days * 86400_000).toISOString(); store.run('INSERT INTO invites(id,token_hash,email,expires_at,created_at) VALUES (?,?,?,?,?)', inviteId, digest(token), email, expiresAt, now()); res.status(201).json({ invite: { id: inviteId, token, expiresAt } }); });
  app.delete('/api/admin/invites/:id', (req, res) => { store.run('DELETE FROM invites WHERE id=?', req.params.id); res.json({ ok: true }); });
  app.get('/api/admin/stats', (_req, res) => res.json({ users: store.get('SELECT COUNT(*) AS n FROM users').n, chats: store.get('SELECT COUNT(*) AS n FROM chats').n, messages: store.get('SELECT COUNT(*) AS n FROM messages').n, requestsToday: store.get('SELECT COUNT(*) AS n FROM requests WHERE created_at>=?', `${now().slice(0, 10)}T00:00:00.000Z`).n }));
  app.patch('/api/admin/settings', (req, res) => {
    const values = {};
    if (req.body.siteName !== undefined) values.siteName = requiredText(req.body.siteName, '站点名称', 40);
    if (req.body.systemPrompt !== undefined) { if (typeof req.body.systemPrompt !== 'string' || req.body.systemPrompt.length > 20_000) throw fail(400, '系统提示词最多 20000 字符。'); values.systemPrompt = req.body.systemPrompt; }
    if (req.body.dailyLimit !== undefined) values.dailyLimit = number(req.body.dailyLimit, 0, 100_000, '每日请求额度');
    if (req.body.maxOutputTokens !== undefined) values.maxOutputTokens = number(req.body.maxOutputTokens, 128, 32768, '最大输出 Token');
    if (req.body.routingMaxAttempts !== undefined) values.routingMaxAttempts = number(req.body.routingMaxAttempts, 1, 10, '每次请求最多尝试次数');
    if (req.body.retriesPerChannel !== undefined) values.retriesPerChannel = number(req.body.retriesPerChannel, 0, 3, '同渠道重试次数');
    if (req.body.defaultModelId !== undefined) values.defaultModelId = req.body.defaultModelId === null ? null : usableModel(req.body.defaultModelId).id;
    store.transaction(() => { for (const [key, value] of Object.entries(values)) store.setSetting(key, value); });
    res.json({ settings: store.settings() });
  });
  app.use('/api', (_req, _res, next) => next(fail(404, '接口不存在。')));
  const distPath = resolve('dist');
  if (existsSync(distPath)) { app.use(express.static(distPath, { index: false })); app.get('/{*path}', (_req, res) => res.sendFile(join(distPath, 'index.html'))); }
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.end();
    if (error instanceof multer.MulterError) return res.status(413).json({ error: '每次最多上传 5 个文件，每个文件不超过 10 MB。' });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    if (status === 500) logger.error('APIRouter request failed:', error.code || error.name || 'UnknownError');
    res.status(status).json({ error: status === 500 ? '服务暂时出现问题，请稍后重试。' : error.message, ...(error.code ? { code: error.code } : {}) });
  });
  cleanAbandonedUploads();
  const cleanupTimer = setInterval(cleanAbandonedUploads, 3600_000);
  cleanupTimer.unref();
  return { app, store, setupToken, abortAll: () => { for (const job of active.values()) job.controller.abort(); }, close: () => { clearInterval(cleanupTimer); work.close(); store.close(); } };
}
