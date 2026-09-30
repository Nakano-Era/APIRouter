import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import rateLimit from 'express-rate-limit';
import { id, now, digest, verifyPassword } from './store.mjs';
import { validateBaseUrl, openUpstream, readJson, sanitizeUpstreamError } from './net.mjs';

const derive = promisify(scrypt);
const fail = (status, message) => Object.assign(new Error(message), { status });
const protocols = ['openai-chat', 'openai-responses', 'anthropic'];
const adapters = ['none', 'newapi', 'openai-compatible'];
const envelopeType = 'apirouter_provider_export';
const maxText = 2 * 1024 * 1024;
const kdf = { name: 'scrypt', N: 32768, r: 8, p: 1 };
const aad = Buffer.from('APIRouter provider export v1');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function text(value, label, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw fail(400, `${label}格式无效。`);
  return value.trim();
}
function choice(value, allowed, label) { if (!allowed.includes(value)) throw fail(400, `${label}无效。`); return value; }
function integer(value, min, max, label) { if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `${label}超出范围。`); return value; }
function bool(value, label) { if (typeof value !== 'boolean') throw fail(400, `${label}必须为布尔值。`); return value; }
function unique(values, label) {
  const present = [...new Set(values.filter(value => value !== undefined && value !== null && value !== '').map(value => text(value, label, 4000)))];
  if (present.length > 1) throw fail(400, `检测到多个不同的${label}，请拆分为独立连接后再导入。`);
  return present[0];
}
function modelDefinition(value) {
  if (!object(value)) throw fail(400, '模型映射格式无效。');
  const modelId = text(value.modelId ?? value.model_id, '上游模型 ID');
  const reasoningEfforts = value.reasoningEfforts ?? [];
  if (!Array.isArray(reasoningEfforts) || reasoningEfforts.length > 5 || new Set(reasoningEfforts).size !== reasoningEfforts.length || reasoningEfforts.some(effort => !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort))) throw fail(400, '模型思考强度配置无效。');
  return { modelId, name: text(value.name ?? modelId, '模型名称'), routeKey: text(value.routeKey ?? value.route_key ?? modelId, '统一模型名'), reasoningEfforts,
    enabled: bool(value.enabled ?? false, '模型启用状态'), vision: bool(value.vision ?? false, '图片输入'), manual: bool(value.manual ?? true, '手动模型'), available: bool(value.available ?? true, '可用状态') };
}
export function normalizeProvider(value, warnings = []) {
  if (!object(value)) throw fail(400, '每个 API 连接必须是一个对象。');
  const env = object(value.env) ? value.env : value;
  const baseUrl = validateBaseUrl(unique([value.baseUrl, value.base_url, value.url, env.ANTHROPIC_BASE_URL, env.OPENAI_BASE_URL, env.OPENAI_API_BASE], 'API 地址') ?? '');
  const apiKey = text(unique([value.apiKey, value.api_key, value.key, env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY, env.OPENAI_API_KEY], 'API Key'), 'API Key', 4000);
  if (/\s/.test(apiKey)) throw fail(400, 'API Key 不能包含空白字符。');
  const anyrouter = /(^|\.)anyrouter\.top$/i.test(new URL(baseUrl).hostname);
  const anthropic = anyrouter || !!(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY);
  const protocol = choice(value.protocol ?? (anthropic ? 'anthropic' : 'openai-chat'), protocols, '接口协议');
  const runtime = choice(value.runtime ?? (anyrouter && protocol === 'anthropic' ? 'claude-code' : 'api'), ['api', 'claude-code'], '运行方式');
  if (runtime === 'claude-code' && protocol !== 'anthropic') throw fail(400, 'Claude Code 连接需要选择 Anthropic Messages 协议。');
  if (!value.protocol) warnings.push('接口协议由配置格式推断，请核对后保存；识别成功不代表服务商已通过连接测试。');
  if (anyrouter && !value.runtime) warnings.push('AnyRouter 已预选 Claude Code 接入，请确认服务器已配置对应运行环境。');
  const modelValues = value.models ?? [];
  if (!Array.isArray(modelValues) || modelValues.length > 5000) throw fail(400, '每个连接最多导入 5000 个模型映射。');
  const models = modelValues.map(modelDefinition);
  if (new Set(models.map(model => model.modelId)).size !== models.length) throw fail(400, '同一连接存在重复的上游模型 ID。');
  return { name: text(value.name ?? new URL(baseUrl).hostname, '连接名称', 80), baseUrl, apiKey, protocol, runtime,
    authMode: choice(value.authMode ?? value.auth_mode ?? (env.ANTHROPIC_AUTH_TOKEN || anyrouter ? 'bearer' : 'auto'), ['auto', 'bearer', 'x-api-key'], '认证方式'),
    enabled: bool(value.enabled ?? true, '连接启用状态'), priority: integer(value.priority ?? 0, 0, 1000, '优先级'),
    failureThreshold: integer(value.failureThreshold ?? value.failure_threshold ?? 3, 1, 10, '失败阈值'), cooldownSeconds: integer(value.cooldownSeconds ?? value.cooldown_seconds ?? 60, 5, 86400, '冷却时间'),
    balanceAdapter: choice(value.balanceAdapter ?? 'none', adapters, '余额查询接口'), models };
}
function normalizeBatch(values, warnings = []) {
  if (!Array.isArray(values) || !values.length || values.length > 100) throw fail(400, '一次请导入 1–100 个 API 连接。');
  const providers = values.map(value => normalizeProvider(value, warnings));
  if (providers.reduce((sum, provider) => sum + provider.models.length, 0) > 10_000) throw fail(400, '一次最多导入 10000 个模型映射。');
  return providers;
}
function passphrase(value) { if (typeof value !== 'string' || value.length < 12 || value.length > 1024) throw fail(400, '备份密码需要 12–1024 个字符。'); return value; }
export async function encryptProviderExport(document, password) {
  passphrase(password);
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = await derive(password, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad);
  try {
    const data = Buffer.concat([cipher.update(JSON.stringify(document), 'utf8'), cipher.final()]);
    return { _type: envelopeType, version: 1, encrypted: true, kdf: { ...kdf, salt: salt.toString('base64') }, cipher: { name: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') } };
  } finally { key.fill(0); }
}
function decode(value, length) {
  if (typeof value !== 'string' || !value || value.length > maxText * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw fail(400, '加密备份格式无效。');
  const bytes = Buffer.from(value, 'base64');
  if ((length && bytes.length !== length) || bytes.toString('base64') !== value) throw fail(400, '加密备份格式无效。');
  return bytes;
}
export async function decryptProviderExport(envelope, password) {
  passphrase(password);
  if (!object(envelope) || envelope._type !== envelopeType || envelope.version !== 1 || envelope.encrypted !== true || !object(envelope.kdf) || !object(envelope.cipher) || envelope.kdf.name !== kdf.name || envelope.kdf.N !== kdf.N || envelope.kdf.r !== kdf.r || envelope.kdf.p !== kdf.p || envelope.cipher.name !== 'AES-256-GCM') throw fail(400, '加密备份版本或加密参数不受支持。');
  const salt = decode(envelope.kdf.salt, 16), iv = decode(envelope.cipher.iv, 12), tag = decode(envelope.cipher.tag, 16), data = decode(envelope.cipher.data);
  const key = await derive(password, salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 64 * 1024 * 1024 });
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad); cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'));
  } catch { throw fail(400, '备份密码错误，或文件已损坏。'); }
  finally { key.fill(0); }
}
export async function parseProviderInput(input, password) {
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > maxText) throw fail(400, '请粘贴配置，文件大小不能超过 2 MB。');
  const raw = input.trim().replace(/^```(?:json|bash|sh|env)?\s*\n([\s\S]*?)\n```$/, '$1');
  let parsed;
  if (/^[\[{]/.test(raw)) {
    try { parsed = JSON.parse(raw); } catch { throw fail(400, 'JSON 格式不正确，请粘贴完整内容。'); }
    if (object(parsed) && parsed.encrypted === true) parsed = await decryptProviderExport(parsed, password);
    if (object(parsed) && parsed._type === envelopeType && parsed.version !== 1) throw fail(400, '备份文件版本不受支持。');
  } else {
    const env = {};
    for (const match of raw.matchAll(/(?:^|\n)\s*(?:export\s+|\$env:)?(ANTHROPIC_BASE_URL|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_BASE_URL|OPENAI_API_BASE|OPENAI_API_KEY)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#;]+))/g)) {
      const value = match[2] ?? match[3] ?? match[4];
      if (env[match[1]] && env[match[1]] !== value) throw fail(400, '环境变量中存在冲突的地址或密钥，请先拆分连接。');
      env[match[1]] = value;
    }
    if (Object.keys(env).length) parsed = { env };
    else {
      const urlPattern = /https?:\/\/[^\s<>"'`，,;]+/g;
      const urls = [...new Set(raw.match(urlPattern) ?? [])];
      const keys = [...new Set(raw.replace(urlPattern, ' ').match(/\bsk-[A-Za-z0-9_.-]+/g) ?? [])];
      if (urls.length !== 1 || keys.length !== 1) throw fail(400, '未能唯一识别一个 API 地址和 Key。请使用连接 JSON、环境变量，或分别填写。');
      parsed = { baseUrl: urls[0], apiKey: keys[0] };
    }
  }
  const warnings = [];
  const providers = normalizeBatch(Array.isArray(parsed) ? parsed : object(parsed) && Array.isArray(parsed.providers) ? parsed.providers : [parsed], warnings);
  return { providers, warnings: [...new Set(warnings)] };
}

// These fixed relative paths resolve under the configured service prefix, on the same origin.
// New API quota semantics: https://doc.newapi.pro/en/api/token-usage/
async function balanceJson(provider, endpoint, query) {
  const connection = await openUpstream({ ...provider, protocol: 'openai-chat', authMode: 'bearer' }, endpoint, { query, timeoutMs: 15_000 });
  try { return await readJson(connection.response, 256 * 1024); } finally { await connection.cleanup(); }
}
const amount = value => typeof value === 'number' && Number.isFinite(value);
export async function queryProviderBalance(provider, adapter, clock = Date.now) {
  choice(adapter, adapters, '余额查询接口');
  const checkedAt = new Date(clock()).toISOString();
  if (adapter === 'none') return { available: false, adapter, checkedAt, message: '尚未选择余额接口；未向上游发送查询。' };
  try {
    if (adapter === 'newapi') {
      const response = await balanceJson(provider, '../api/usage/token/');
      const data = response?.data;
      if (response.success === false || response.code === false || !object(data) || typeof data.unlimited_quota !== 'boolean' || !amount(data.total_available) || !amount(data.total_used) || !amount(data.total_granted)) return { available: false, adapter, checkedAt, message: '上游未返回可识别的 New API 令牌额度，请到服务商控制台核对。' };
      return { available: true, adapter, checkedAt, unit: 'quota', remaining: data.unlimited_quota ? null : data.total_available, used: data.total_used, granted: data.total_granted, unlimited: data.unlimited_quota, expiresAt: typeof data.expires_at === 'number' && data.expires_at > 0 && data.expires_at < 253402300800 ? new Date(data.expires_at * 1000).toISOString() : null, modelLimits: data.model_limits_enabled && object(data.model_limits) ? Object.entries(data.model_limits).filter(([, enabled]) => enabled === true).map(([name]) => name.slice(0, 300)).slice(0, 500) : [], message: '显示此 Key 的原始令牌额度，不等同于账户余额或美元金额。' };
    }
    const date = new Date(clock()), start = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-01`, end = new Date(date.getTime() + 86400_000).toISOString().slice(0, 10);
    const subscription = await balanceJson(provider, '../dashboard/billing/subscription');
    const usage = await balanceJson(provider, '../dashboard/billing/usage', { start_date: start, end_date: end });
    if (!amount(subscription.hard_limit_usd) || !amount(usage.total_usage) || subscription.hard_limit_usd < 0 || usage.total_usage < 0) return { available: false, adapter, checkedAt, message: '上游不支持所选的旧版账单接口，或返回格式不完整。' };
    return { available: true, adapter, checkedAt, unit: 'provider-units', remaining: subscription.hard_limit_usd - usage.total_usage / 100, used: usage.total_usage / 100, granted: subscription.hard_limit_usd, unlimited: false, periodStart: start, message: '旧版兼容接口额度值：计价单位和统计周期由服务商决定，不能仅凭字段名认定为美元或账户现金余额。' };
  } catch (error) {
    return { available: false, adapter, checkedAt, message: sanitizeUpstreamError(error), ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}) };
  }
}

export function createProviderTools({ store, providerJSON, ensureProviderIdle = () => {} }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS provider_tools (provider_id TEXT PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE, balance_adapter TEXT NOT NULL DEFAULT 'none', balance_data TEXT, balance_fingerprint TEXT);`);
  const balanceBusy = new Set();
  const fingerprint = row => digest(`${row.base_url}\0${row.encrypted_key}`);
  const getProvider = providerId => { const row = store.get('SELECT * FROM providers WHERE id=?', providerId); if (!row) throw fail(404, '连接不存在。'); return row; };
  function balanceState(providerId) {
    const provider = getProvider(providerId), row = store.get('SELECT * FROM provider_tools WHERE provider_id=?', providerId);
    return { adapter: row?.balance_adapter ?? 'none', balance: row?.balance_data && row.balance_fingerprint === fingerprint(provider) ? JSON.parse(row.balance_data) : null };
  }
  function importProviders(values) {
    const providers = normalizeBatch(values);
    let added = 0, skipped = 0, modelsAdded = 0;
    store.transaction(() => {
      const existing = new Set(store.all('SELECT * FROM providers').map(row => digest(`${row.base_url}\0${store.decrypt(row.encrypted_key)}\0${row.protocol}`)));
      for (const provider of providers) {
        const signature = digest(`${provider.baseUrl}\0${provider.apiKey}\0${provider.protocol}`);
        if (existing.has(signature)) { skipped++; continue; }
        existing.add(signature);
        const providerId = id();
        store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,enabled,created_at,priority,failure_threshold,cooldown_seconds,auth_mode,runtime) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', providerId, provider.name, provider.baseUrl, provider.protocol, store.encrypt(provider.apiKey), `••••${provider.apiKey.slice(-4)}`, Number(provider.enabled), now(), provider.priority, provider.failureThreshold, provider.cooldownSeconds, provider.authMode, provider.runtime);
        store.run('INSERT INTO provider_tools(provider_id,balance_adapter) VALUES (?,?)', providerId, provider.balanceAdapter);
        for (const model of provider.models) {
          store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,enabled,vision,manual,available,reasoning_efforts) VALUES (?,?,?,?,?,?,?,?,?,?)', id(), providerId, model.modelId, model.name, model.routeKey, Number(model.enabled), Number(model.vision), Number(model.manual), Number(model.available), JSON.stringify(model.reasoningEfforts)); modelsAdded++;
        }
        added++;
      }
    });
    return { added, skipped, modelsAdded };
  }
  function exportDocument() {
    return { _type: envelopeType, version: 1, encrypted: false, exportedAt: now(), providers: store.all('SELECT * FROM providers ORDER BY created_at,id').map(row => ({ name: row.name, baseUrl: row.base_url, apiKey: store.decrypt(row.encrypted_key), protocol: row.protocol, runtime: row.runtime ?? 'api', authMode: row.auth_mode, enabled: !!row.enabled, priority: row.priority, failureThreshold: row.failure_threshold, cooldownSeconds: row.cooldown_seconds, balanceAdapter: store.get('SELECT balance_adapter FROM provider_tools WHERE provider_id=?', row.id)?.balance_adapter ?? 'none', models: store.all('SELECT * FROM models WHERE provider_id=? ORDER BY model_id', row.id).map(model => ({ modelId: model.model_id, name: model.name, routeKey: model.route_key, enabled: !!model.enabled, vision: !!model.vision, manual: !!model.manual, available: !!model.available, reasoningEfforts: JSON.parse(model.reasoning_efforts ?? '[]') })) })) };
  }
  function registerRoutes(app, { auth, admin, csrf }) {
    const router = express.Router();
    const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: '连接管理操作过于频繁，请稍后重试。' } });
    const exportLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, message: { error: '导出验证过于频繁，请稍后重试。' } });
    router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    router.post('/parse', limiter, async (req, res) => res.json(await parseProviderInput(req.body.text, req.body.password)));
    router.post('/import', limiter, (req, res) => res.json(importProviders(req.body.providers)));
    router.post('/export', exportLimiter, async (req, res) => {
      choice(req.body.format, ['plain', 'encrypted'], '导出格式');
      const password = req.body.currentPassword;
      if (typeof password !== 'string' || !password || password.length > 1024 || !(await verifyPassword(password, req.user.password))) throw fail(403, '当前账户密码错误，无法导出 API Key。');
      // Verify the session owner still has administrator access after password derivation.
      const current = store.get('SELECT * FROM users WHERE id=?', req.user.id);
      if (!current || current.disabled || current.role !== 'admin' || current.password !== req.user.password) throw fail(403, '管理员身份已变更，请重新登录。');
      const document = exportDocument();
      const output = req.body.format === 'encrypted' ? await encryptProviderExport(document, req.body.password) : document;
      res.set('Content-Disposition', `attachment; filename="apirouter-apis-${now().slice(0, 10)}${req.body.format === 'encrypted' ? '.encrypted' : ''}.json"`);
      res.json(output);
    });
    router.get('/:id/balance', (req, res) => res.json(balanceState(req.params.id)));
    router.post('/:id/balance', limiter, async (req, res) => {
      const provider = getProvider(req.params.id), adapter = choice(req.body.adapter, adapters, '余额查询接口');
      if (balanceBusy.has(provider.id)) throw fail(409, '此连接正在查询余额，请稍后再试。');
      ensureProviderIdle(provider.id);
      store.run('INSERT INTO provider_tools(provider_id,balance_adapter) VALUES (?,?) ON CONFLICT(provider_id) DO UPDATE SET balance_adapter=excluded.balance_adapter,balance_data=CASE WHEN provider_tools.balance_adapter=excluded.balance_adapter THEN provider_tools.balance_data ELSE NULL END', provider.id, adapter);
      if (req.body.refresh !== true) return res.json(balanceState(provider.id));
      balanceBusy.add(provider.id);
      try {
        const balance = await queryProviderBalance({ ...providerJSON(provider), apiKey: store.decrypt(provider.encrypted_key) }, adapter);
        const current = store.get('SELECT * FROM providers WHERE id=?', provider.id);
        if (!current || fingerprint(current) !== fingerprint(provider)) throw fail(409, '连接配置已改变，请重新查询余额。');
        store.run('UPDATE provider_tools SET balance_data=?,balance_fingerprint=? WHERE provider_id=?', JSON.stringify(balance), fingerprint(provider), provider.id);
        res.json({ adapter, balance });
      } finally { balanceBusy.delete(provider.id); }
    });
    app.use('/api/admin/providers', auth, admin, csrf, router);
  }
  return { registerRoutes, importProviders, exportDocument, balanceState };
}
