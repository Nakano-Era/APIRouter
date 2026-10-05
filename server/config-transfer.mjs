import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes, createCipheriv, createDecipheriv, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { id, now, digest, verifyPassword } from './store.mjs';
import { validateBaseUrl } from './net.mjs';
import { validateLimits, validateSkill } from '../runner/protocol.mjs';
import { modelRouteId } from './model-catalog.mjs';

const derive = promisify(scrypt), TYPE = 'apirouter_configuration_export', CONTENT = 'apirouter_configuration';
const AAD = Buffer.from('APIRouter complete configuration v1'), MAX = 32 * 1024 * 1024;
const CONFIRM = '合并导入配置', TTL = 10 * 60_000;
const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 };
const fail = (message, status = 400, code = 'INVALID_CONFIG_TRANSFER') => Object.assign(new Error(message), { status, code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const settingNames = ['siteName', 'systemPrompt', 'defaultModelId', 'dailyLimit', 'maxOutputTokens', 'routingMaxAttempts', 'retriesPerChannel', 'workSettings', 'workSearch'];
const fields = {
  settings: ['key', 'value'],
  users: ['id', 'name', 'email', 'password', 'role', 'disabled', 'daily_limit', 'created_at'],
  providers: ['id', 'name', 'base_url', 'protocol', 'api_key', 'enabled', 'priority', 'failure_threshold', 'cooldown_seconds', 'failure_protection_enabled', 'auth_mode', 'runtime', 'responses_profile', 'created_at'],
  models: ['id', 'provider_id', 'model_id', 'name', 'route_key', 'variant_name', 'catalog_assigned', 'enabled', 'vision', 'available', 'manual', 'reasoning_efforts', 'context_window', 'max_output_tokens', 'failure_protection_enabled', 'failure_threshold_override', 'cooldown_seconds_override', 'retries_override'],
  provider_tools: ['provider_id', 'balance_adapter'],
  model_catalog: ['name', 'created_at'], model_versions: ['route_key', 'name', 'position'], model_route_aliases: ['id', 'route_key', 'variant_name'],
  work_skills: ['id', 'name', 'description', 'content', 'created_at', 'updated_at'],
  billing_config: ['id', 'enabled', 'secret_key', 'webhook_secret', 'free_routes'],
  billing_plans: ['id', 'data', 'created_at', 'updated_at'],
  billing_entitlement_overrides: ['user_id', 'plan_id', 'plan_snapshot', 'active_until', 'reason', 'admin_id', 'updated_at'],
  user_model_limits: ['user_id', 'route_key', 'scope_key', 'variant_name', 'daily_limit', 'monthly_limit', 'updated_at'],
  user_model_routing: ['user_id', 'source_route_key', 'source_variant_name', 'target_route_key', 'target_variant_name', 'enabled', 'effort', 'fallbacks_json', 'updated_at'],
  announcements: ['id', 'title', 'body', 'status', 'revision', 'author_id', 'updated_by', 'created_at', 'updated_at', 'published_at'],
  api_export_keys: ['id', 'name', 'token_hash', 'key_hint', 'enabled', 'model_ids', 'created_by', 'created_at'],
  invite_groups: ['id', 'name', 'enabled', 'plan_id', 'duration', 'active_until', 'rules_json', 'created_at', 'updated_at'],
};
const memberFields = ['user_id', 'plan_id', 'plan_snapshot', 'active_until', 'updated_at'];
function knownModelIds(tables) {
  const publicIds = new Set([...tables.models.map(row => modelRouteId(row.route_key, row.variant_name)), ...tables.model_versions.map(row => modelRouteId(row.route_key, row.name)), ...tables.model_catalog.map(row => modelRouteId(row.name))]);
  for (const row of tables.model_route_aliases) if (publicIds.has(modelRouteId(row.route_key, row.variant_name))) publicIds.add(row.id);
  return new Set([...publicIds, ...tables.models.map(row => row.id)]);
}
const labels = { settings: '站点与 Work 设置', users: '用户账号', providers: 'API 渠道', models: '渠道模型', provider_tools: '余额查询设置', model_catalog: '模型目录', model_versions: '模型版本', model_route_aliases: '模型旧名关联', work_skills: '技能', billing_config: '支付设置', billing_plans: '会员套餐', billing_entitlement_overrides: '用户套餐权益', user_model_limits: '用户模型额度', user_model_routing: '用户专属路由', announcements: '公告', api_export_keys: '对外 API 密钥' };
labels.invite_groups = '特殊邀请分组';
function shape(value, keys, label) { if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) throw fail(`${label}字段不完整或不受支持。`); }
function text(value, label, max = 300, empty = false) { if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value)) throw fail(`${label}格式无效。`); return value; }
function content(value, label, max) { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw fail(`${label}格式无效。`); return value; }
function integer(value, min, max, label, nullable = false) { if (!(nullable && value === null) && (!Number.isSafeInteger(value) || value < min || value > max)) throw fail(`${label}超出范围。`); }
function choice(value, values, label) { if (!values.includes(value)) throw fail(`${label}无效。`); }
function flag(value, label, nullable = false) { integer(value, 0, 1, label, nullable); }
function date(value, label, nullable = false) { if (!(nullable && value === null) && (typeof value !== 'string' || value.length > 35 || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) throw fail(`${label}不是有效时间。`); }
function json(value, label) { if (typeof value !== 'string') throw fail(`${label}必须为 JSON。`); try { return JSON.parse(value); } catch { throw fail(`${label}不是有效 JSON。`); } }
function reference(value) { text(value, '记录 ID', 200); }
function routes(value) { if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length) throw fail('套餐模型范围无效。'); value.forEach(route => text(route, '套餐模型名')); }
function password(value) { if (typeof value !== 'string' || value.length < 12 || value.length > 256) throw fail('备份密码需为 12–256 个字符。'); }
function decode(value, size) { if (typeof value !== 'string' || value.length > Math.ceil(MAX * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw fail('加密备份格式无效。'); const data = Buffer.from(value, 'base64'); if (data.toString('base64') !== value || size && data.length !== size) throw fail('加密备份格式无效。'); return data; }
export async function encryptConfigExport(document, passphrase) {
  password(passphrase); const plain = Buffer.from(JSON.stringify(document)); if (plain.length > MAX) throw fail('配置包超过 32 MiB。');
  const salt = randomBytes(16), iv = randomBytes(12), key = await derive(passphrase, salt, 32, { ...KDF, maxmem: 64 * 1024 * 1024 });
  try { const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD); const data = Buffer.concat([cipher.update(plain), cipher.final()]); return { _type: TYPE, version: 1, encrypted: true, kdf: { ...KDF, salt: salt.toString('base64') }, cipher: { name: 'AES-256-GCM', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') } }; }
  finally { key.fill(0); plain.fill(0); }
}
export async function decryptConfigExport(envelope, passphrase) {
  password(passphrase);
  shape(envelope, ['_type', 'version', 'encrypted', 'kdf', 'cipher'], '配置包');
  if (envelope._type !== TYPE || envelope.version !== 1 || envelope.encrypted !== true) throw fail('仅支持版本 1 的加密配置包。');
  shape(envelope.kdf, ['name', 'N', 'r', 'p', 'salt'], '密钥派生参数'); shape(envelope.cipher, ['name', 'iv', 'tag', 'data'], '加密参数');
  if (Object.entries(KDF).some(([key, value]) => envelope.kdf[key] !== value) || envelope.cipher.name !== 'AES-256-GCM') throw fail('配置包加密参数不受支持。');
  const salt = decode(envelope.kdf.salt, 16), iv = decode(envelope.cipher.iv, 12), tag = decode(envelope.cipher.tag, 16), data = decode(envelope.cipher.data);
  const key = await derive(passphrase, salt, 32, { ...KDF, maxmem: 64 * 1024 * 1024 });
  let plain;
  try { const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAAD(AAD); cipher.setAuthTag(tag); plain = Buffer.concat([cipher.update(data), cipher.final()]); return JSON.parse(plain.toString('utf8')); }
  catch { throw fail('备份密码错误，或配置包已损坏。'); }
  finally { key.fill(0); plain?.fill(0); }
}

function validatePlan(value, snapshot = false) {
  if (!object(value)) throw fail('会员套餐格式无效。');
  const permitted = ['name', 'description', 'priceCents', 'currency', 'interval', 'dailyLimit', 'allowedRoutes', 'active', 'allowStripe', 'allowManual', 'sortOrder', ...(snapshot ? ['id', 'createdAt', 'updatedAt'] : [])];
  if (Object.keys(value).some(key => !permitted.includes(key))) throw fail('会员套餐包含未知字段。');
  const free = snapshot && value.id === 'free';
  text(value.name, '套餐名称', 60); integer(value.dailyLimit, 0, 100000, '套餐每日次数'); routes(value.allowedRoutes); choice(value.interval, ['month', 'year'], '套餐周期');
  if (snapshot) reference(value.id);
  if (!free) { content(value.description, '套餐说明', 1000); integer(value.priceCents, 1, 99999999, '套餐价格'); choice(value.currency, ['USD', 'CNY', 'EUR', 'HKD'], '套餐币种'); integer(value.sortOrder, -10000, 10000, '套餐排序'); for (const key of ['active', 'allowStripe', 'allowManual']) if (typeof value[key] !== 'boolean') throw fail('套餐开关无效。'); }
  for (const key of ['createdAt', 'updatedAt']) if (value[key] !== undefined) date(value[key], '套餐时间');
}
function validateSettings(row) {
  choice(row.key, settingNames, '站点设置名'); const value = json(row.value, '站点设置');
  if (row.key === 'siteName') text(value, '站点名称', 40);
  else if (row.key === 'systemPrompt') content(value, '系统提示词', 20000);
  else if (row.key === 'defaultModelId') { if (value !== null) reference(value); }
  else if (row.key === 'dailyLimit') integer(value, 0, 100000, '每日次数');
  else if (row.key === 'maxOutputTokens') integer(value, 128, 32768, '输出上限');
  else if (row.key === 'routingMaxAttempts') integer(value, 1, 100, '尝试上限');
  else if (row.key === 'retriesPerChannel') integer(value, 0, 3, '重试次数');
  else if (row.key === 'workSettings') { if (!object(value)) throw fail('Work 设置无效。'); validateLimits(value); }
  else if (row.key === 'workSearch') { shape(value, ['enabled', 'baseUrl'], '搜索配置'); if (typeof value.enabled !== 'boolean') throw fail('搜索开关无效。'); if (value.baseUrl !== 'http://work-search:8080' && !validateBaseUrl(value.baseUrl).startsWith('https://')) throw fail('自定义搜索服务必须使用公网 HTTPS。'); }
}
function validateDocument(document) {
  shape(document, ['_type', 'version', 'sourceId', 'exportedAt', 'exportedBy', 'tables', 'memberships'], '配置内容');
  if (document._type !== CONTENT || document.version !== 1 || !/^[a-f0-9]{32}$/.test(document.sourceId)) throw fail('配置内容版本或来源标识无效。');
  date(document.exportedAt, '导出时间'); reference(document.exportedBy); shape(document.tables, Object.keys(fields), '配置清单');
  const t = document.tables;
  for (const [table, columns] of Object.entries(fields)) {
    if (!Array.isArray(t[table]) || t[table].length > 100000) throw fail(`${labels[table]}记录数无效。`);
    for (const row of t[table]) { shape(row, columns, labels[table]); if ('id' in row && table !== 'billing_config') reference(row.id); for (const field of ['created_at', 'updated_at']) if (field in row) date(row[field], field); }
  }
  if (t.billing_config.length !== 1) throw fail('支付配置必须有且仅有一条。');
  const primary = { settings: ['key'], users: ['id'], providers: ['id'], models: ['id'], provider_tools: ['provider_id'], model_catalog: ['name'], model_versions: ['route_key', 'name'], model_route_aliases: ['id'], work_skills: ['id'], billing_config: ['id'], billing_plans: ['id'], billing_entitlement_overrides: ['user_id'], user_model_limits: ['user_id', 'route_key', 'scope_key'], user_model_routing: ['user_id', 'source_route_key', 'source_variant_name'], announcements: ['id'], api_export_keys: ['id'], invite_groups: ['id'] };
  function unique(rows, keys, label) { const all = rows.map(row => JSON.stringify(keys.map(key => row[key]))); if (new Set(all).size !== all.length) throw fail(`${label}包含重复记录。`); }
  for (const [table, keys] of Object.entries(primary)) unique(t[table], keys, labels[table]);
  unique(t.users.map(row => ({ email: row.email?.toLowerCase() })), ['email'], '用户邮箱'); unique(t.models, ['provider_id', 'model_id'], '渠道模型'); unique(t.work_skills, ['name'], '技能'); unique(t.api_export_keys, ['token_hash'], 'API Key');
  const users = new Map(t.users.map(row => [row.id, row])), providerIds = new Set(t.providers.map(row => row.id)), modelIds = new Set(t.models.map(row => row.id));
  const catalog = new Set(t.model_catalog.map(row => row.name));
  const needsUser = userId => { reference(userId); if (!users.has(userId)) throw fail('配置引用了缺失的用户。'); };
  needsUser(document.exportedBy); if (users.get(document.exportedBy).role !== 'admin') throw fail('配置来源管理员无效。');
  for (const row of t.settings) validateSettings(row);
  for (const row of t.users) { text(row.name, '用户姓名', 60); text(row.email, '用户邮箱', 254); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email) || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(row.password)) throw fail('用户邮箱或密码哈希无效。'); choice(row.role, ['admin', 'user'], '用户角色'); flag(row.disabled, '用户停用状态'); integer(row.daily_limit, 0, 100000, '用户每日次数', true); }
  for (const row of t.providers) {
    text(row.name, '渠道名称', 80); validateBaseUrl(row.base_url); text(row.api_key, '上游密钥', 4000); if (/\s/.test(row.api_key)) throw fail('上游密钥不能包含空白字符。'); choice(row.protocol, ['openai-chat', 'openai-responses', 'anthropic'], '接口协议'); choice(row.runtime, ['api', 'claude-code'], '渠道运行方式'); choice(row.auth_mode, ['auto', 'bearer', 'x-api-key'], '认证方式'); choice(row.responses_profile, ['auto', 'standard', 'codex'], 'Responses 格式');
    if (row.runtime === 'claude-code' && row.protocol !== 'anthropic') throw fail('Claude Code 渠道需要 Anthropic 协议。');
    flag(row.enabled, '渠道开关'); flag(row.failure_protection_enabled, '失败保护'); integer(row.priority, 0, 1000, '渠道优先级'); integer(row.failure_threshold, 1, 1000, '失败阈值'); integer(row.cooldown_seconds, 1, 2592000, '冷却秒数');
  }
  for (const row of t.models) {
    if (!providerIds.has(row.provider_id)) throw fail('模型引用了缺失的渠道。');
    for (const key of ['model_id', 'name', 'route_key']) text(row[key], '模型名称'); text(row.variant_name, '模型版本', 100, true);
    for (const key of ['catalog_assigned', 'enabled', 'vision', 'available', 'manual']) flag(row[key], '模型开关'); flag(row.failure_protection_enabled, '模型失败保护', true);
    integer(row.context_window, 1024, 10000000, '模型上下文', true); integer(row.max_output_tokens, 128, 1000000, '模型输出上限', true); integer(row.failure_threshold_override, 1, 1000, '失败阈值', true); integer(row.cooldown_seconds_override, 1, 2592000, '冷却秒数', true); integer(row.retries_override, 0, 100, '模型重试次数', true);
    const efforts = json(row.reasoning_efforts, '思考强度'); if (!Array.isArray(efforts) || efforts.length > 5 || new Set(efforts).size !== efforts.length) throw fail('模型思考强度无效。'); efforts.forEach(value => choice(value, ['low', 'medium', 'high', 'xhigh', 'max'], '思考强度'));
  }
  for (const row of t.provider_tools) { if (!providerIds.has(row.provider_id)) throw fail('余额配置引用了缺失渠道。'); choice(row.balance_adapter, ['none', 'newapi', 'openai-compatible'], '余额适配器'); }
  for (const row of t.model_catalog) text(row.name, '模型目录名');
  for (const row of t.model_versions) { if (!catalog.has(row.route_key)) throw fail('模型版本引用了缺失的目录。'); text(row.name, '模型版本', 100, true); integer(row.position, 0, 1000000, '版本排序'); }
  for (const row of t.model_route_aliases) { if (!/^[rv]_[a-f0-9]{32}$/.test(row.id)) throw fail('模型旧标识无效。'); text(row.route_key, '模型别名'); text(row.variant_name, '模型版本', 100, true); }
  for (const row of t.work_skills) { const checked = validateSkill(row); row.content = checked.content; }
  for (const row of t.billing_config) { if (row.id !== 1) throw fail('支付配置标识无效。'); flag(row.enabled, '支付开关'); for (const field of ['secret_key', 'webhook_secret']) if (row[field] !== null) text(row[field], '支付密钥', 1000); if (row.secret_key !== null && !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9]+$/.test(row.secret_key)) throw fail('Stripe 密钥格式无效。'); if (row.webhook_secret !== null && !/^whsec_[A-Za-z0-9]+$/.test(row.webhook_secret)) throw fail('Stripe Webhook 密钥格式无效。'); if (row.enabled && (!row.secret_key || !row.webhook_secret)) throw fail('启用支付需要完整密钥。'); routes(json(row.free_routes, '免费模型范围')); }
  for (const row of t.billing_plans) validatePlan(json(row.data, '套餐内容'));
  for (const row of t.billing_entitlement_overrides) { needsUser(row.user_id); needsUser(row.admin_id); reference(row.plan_id); const plan = json(row.plan_snapshot, '套餐快照'); validatePlan(plan, true); if (plan.id !== row.plan_id) throw fail('套餐快照引用不一致。'); date(row.active_until, '套餐到期时间', true); content(row.reason, '套餐备注', 1000); }
  for (const row of t.user_model_limits) { needsUser(row.user_id); text(row.route_key, '额度模型'); text(row.variant_name, '额度版本', 100, true); if (row.scope_key !== JSON.stringify(row.variant_name)) throw fail('模型版本额度标识不一致。'); integer(row.daily_limit, 0, 1000000000, '每日额度', true); integer(row.monthly_limit, 0, 1000000000, '每月额度', true); }
  for (const row of t.user_model_routing) {
    needsUser(row.user_id); text(row.source_route_key, '路由来源'); text(row.source_variant_name, '来源版本', 100, true); flag(row.enabled, '专属路由开关');
    const fallbacks = json(row.fallbacks_json, '备用路由'); if (!Array.isArray(fallbacks)) throw fail('备用路由不是列表。');
    for (const step of [{ targetRouteKey: row.target_route_key, targetVariantName: row.target_variant_name, effort: row.effort }, ...fallbacks]) { shape(step, ['targetRouteKey', 'targetVariantName', 'effort'], '执行目标'); text(step.targetRouteKey, '执行模型'); text(step.targetVariantName, '执行版本', 100, true); choice(step.effort, ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], '执行强度'); }
    if (row.source_route_key === row.target_route_key && row.source_variant_name === row.target_variant_name) throw fail('专属路由的主执行目标不能与来源相同。');
    const targets = [{ targetRouteKey: row.target_route_key, targetVariantName: row.target_variant_name, effort: row.effort }, ...fallbacks];
    unique(targets, ['targetRouteKey', 'targetVariantName', 'effort'], '专属执行目标');
  }
  for (const row of t.announcements) { needsUser(row.author_id); needsUser(row.updated_by); text(row.title, '公告标题', 120); content(row.body, '公告内容', 20000); choice(row.status, ['draft', 'published'], '公告状态'); integer(row.revision, 1, 1000000000, '公告版本'); date(row.published_at, '公告发布时间', true); }
  for (const row of t.api_export_keys) { needsUser(row.created_by); text(row.name, 'API Key 名称', 80); text(row.key_hint, 'API Key 提示', 100); if (!/^[a-f0-9]{64}$/.test(row.token_hash)) throw fail('API Key 哈希无效。'); flag(row.enabled, 'API Key 开关'); const ids = json(row.model_ids, 'API Key 授权范围'); if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.some(value => !modelIds.has(value))) throw fail('API Key 引用了缺失的模型。'); }
  unique(t.invite_groups, ['name'], '邀请分组');
  for (const row of t.invite_groups) {
    text(row.name, '邀请分组名', 80); flag(row.enabled, '邀请分组开关'); if (row.plan_id !== null) reference(row.plan_id); choice(row.duration, ['period', 'permanent', 'until'], '邀请套餐期限'); date(row.active_until, '邀请套餐到期时间', true);
    if (row.duration === 'until' && !row.active_until) throw fail('邀请套餐需要到期时间。');
    if (row.plan_id === null && row.duration !== 'period' || row.duration !== 'until' && row.active_until !== null) throw fail('邀请套餐期限配置不一致。');
    const rules = json(row.rules_json, '邀请模型路由'); if (!Array.isArray(rules) || rules.length > 100) throw fail('邀请模型路由最多 100 条。');
    unique(rules, ['sourceRouteKey', 'sourceVariantName'], '邀请路由');
    for (const rule of rules) { shape(rule, ['sourceRouteKey', 'sourceVariantName', 'targetRouteKey', 'targetVariantName', 'enabled', 'effort', 'fallbacks'], '邀请路由规则'); text(rule.sourceRouteKey, '来源模型'); text(rule.sourceVariantName, '来源版本', 100, true); if (typeof rule.enabled !== 'boolean' || !Array.isArray(rule.fallbacks)) throw fail('邀请路由开关或备选无效。'); if (rule.sourceRouteKey === rule.targetRouteKey && rule.sourceVariantName === rule.targetVariantName) throw fail('邀请主执行目标不能与来源相同。'); const targets = [{ targetRouteKey: rule.targetRouteKey, targetVariantName: rule.targetVariantName, effort: rule.effort }, ...rule.fallbacks]; for (const step of targets) { shape(step, ['targetRouteKey', 'targetVariantName', 'effort'], '邀请执行目标'); text(step.targetRouteKey, '执行模型'); text(step.targetVariantName, '执行版本', 100, true); choice(step.effort, ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], '执行强度'); } unique(targets, ['targetRouteKey', 'targetVariantName', 'effort'], '邀请执行目标'); }
  }
  if (!Array.isArray(document.memberships) || document.memberships.length > 100000) throw fail('用户权益记录无效。'); unique(document.memberships, ['user_id'], '用户权益');
  for (const row of document.memberships) { shape(row, memberFields, '用户现有权益'); needsUser(row.user_id); reference(row.plan_id); validatePlan(json(row.plan_snapshot, '会员权益快照'), true); if (json(row.plan_snapshot).id !== row.plan_id) throw fail('会员权益快照引用不一致。'); date(row.active_until, '权益到期时间'); date(row.updated_at, '权益更新时间'); }
  return document;
}

export function createConfigTransfer({ store, ensureIdle = () => {} } = {}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS configuration_transfer_meta (id INTEGER PRIMARY KEY CHECK(id=1),source_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS configuration_import_links (source_id TEXT NOT NULL,kind TEXT NOT NULL,source_record_id TEXT NOT NULL,target_record_id TEXT NOT NULL,PRIMARY KEY(source_id,kind,source_record_id));`);
  store.run('INSERT OR IGNORE INTO configuration_transfer_meta(id,source_id) VALUES(1,?)', id());
  const sourceId = store.get('SELECT source_id FROM configuration_transfer_meta WHERE id=1').source_id;
  const previews = new Map(); let closed = false;
  const exists = table => !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);
  const all = table => exists(table) ? store.all(`SELECT * FROM ${table} ORDER BY rowid`) : [];
  const pick = (row, columns) => Object.fromEntries(columns.map(key => [key, row[key]]));
  function collect() {
    const tables = {};
    for (const [table, columns] of Object.entries(fields)) {
      if (table === 'providers') tables[table] = all(table).map(row => pick({ ...row, api_key: store.decrypt(row.encrypted_key) }, columns));
      else if (table === 'billing_config') tables[table] = all(table).map(row => pick({ ...row, secret_key: row.encrypted_secret ? store.decrypt(row.encrypted_secret) : null, webhook_secret: row.encrypted_webhook ? store.decrypt(row.encrypted_webhook) : null }, columns));
      else tables[table] = all(table).map(row => pick(row, columns));
    }
    tables.settings = tables.settings.filter(row => settingNames.includes(row.key));
    const knownDefaults = knownModelIds(tables);
    tables.settings = tables.settings.map(row => row.key === 'defaultModelId' && json(row.value, '默认模型') !== null && !knownDefaults.has(json(row.value, '默认模型')) ? { ...row, value: 'null' } : row);
    const models = new Set(tables.models.map(row => row.id));
    // Deleted channel rows cannot become permissions on the destination.
    tables.api_export_keys = tables.api_export_keys.map(row => ({ ...row, model_ids: JSON.stringify(json(row.model_ids, 'API Key 授权').filter(modelId => models.has(modelId))) }));
    const memberships = all('billing_memberships').filter(row => row.active_until > now()).map(row => pick(row, memberFields));
    return { tables, memberships };
  }
  function targetFingerprint() {
    const paymentAssets = ['billing_checkouts', 'billing_subscriptions', 'billing_customers', 'billing_events'].map(table => [table, exists(table) ? store.get(`SELECT COUNT(*) n FROM ${table}`).n : 0]);
    return digest(JSON.stringify({ ...collect(), links: all('configuration_import_links'), paymentAssets }));
  }
  function currentActor(actorId, expectedHash) {
    if (closed) throw fail('配置迁移服务已关闭。', 503);
    const actor = store.get('SELECT * FROM users WHERE id=?', actorId);
    if (!actor || actor.disabled || actor.role !== 'admin' || expectedHash && actor.password !== expectedHash) throw fail('管理员身份已变更，请重新登录。', 403);
    return actor;
  }
  async function authenticate(actorId, currentPassword) {
    const actor = currentActor(actorId);
    if (typeof currentPassword !== 'string' || currentPassword.length > 256 || !await verifyPassword(currentPassword, actor.password)) throw fail('当前管理员密码不正确。', 403);
    return currentActor(actorId, actor.password);
  }
  function buildPlan(document, actorId) {
    const source = document.tables, target = collect().tables;
    const operations = [], links = [], conflicts = [], warnings = [
      '采用合并导入：同一配置使用文件中的值更新，目标服务器独有配置保留。已有同邮箱账号保留原 ID、密码、角色和停用状态；新增账号可使用源服务器原密码登录。',
      '聊天、附件、任务、会话、邀请链接、公告已读、调用日志和已使用额度不迁移。新服务器的额度使用次数重新开始，已有目标服务器计数保留。',
      '域名、HTTPS、环境变量、工作执行器连接凭据和服务器 master.key 保留目标部署设置；迁移不会安装或启动 Docker。',
    ];
    const counts = new Map(Object.keys(fields).map(table => [table, { section: labels[table], create: 0, update: 0, preserve: 0 }]));
    const touched = new Map(), claims = new Map();
    const maps = { users: new Map(), providers: new Map(), models: new Map(), billing_plans: new Map() };
    function uniqueMatch(rows, label) { if (rows.length > 1) throw fail(`${label}在目标存在多个匹配项，请先消除同名歧义再导入。`, 409, 'CONFIG_CONFLICT'); return rows[0]; }
    function identity(table, row, matches, label) {
      const prior = store.get('SELECT target_record_id FROM configuration_import_links WHERE source_id=? AND kind=? AND source_record_id=?', document.sourceId, table, row.id);
      const priorRow = prior && target[table].find(item => item.id === prior.target_record_id);
      if (priorRow && matches.some(item => item.id !== priorRow.id)) throw fail(`${label}的来源关联与目标同名配置冲突，请先消除歧义。`, 409, 'CONFIG_CONFLICT');
      const old = priorRow || uniqueMatch(matches, label);
      const targetId = old?.id || id(), claim = `${table}:${targetId}`;
      if (claims.has(claim) && claims.get(claim) !== row.id) throw fail(`${label}与配置包中其他记录映射到了同一目标，请先处理重复配置。`, 409, 'CONFIG_CONFLICT');
      claims.set(claim, row.id);
      links.push({ source_id: document.sourceId, kind: table, source_record_id: row.id, target_record_id: targetId });
      return { old, targetId };
    }
    function put(table, row, keys, old, label, action = '使用文件中的配置更新') {
      operations.push({ table, row, keys });
      counts.get(table)[old ? 'update' : 'create']++;
      if (old) { const key = JSON.stringify(keys.map(column => old[column])); if (!touched.has(table)) touched.set(table, new Set()); touched.get(table).add(key); conflicts.push({ section: labels[table], label, action }); }
    }
    for (const row of source.users) {
      const old = uniqueMatch(target.users.filter(item => item.email.toLowerCase() === row.email.toLowerCase()), row.email), targetId = old?.id || id();
      maps.users.set(row.id, targetId);
      put('users', old ? { ...row, id: targetId, email: old.email, password: old.password, role: old.role, disabled: old.disabled, created_at: old.created_at } : { ...row, id: targetId }, ['id'], old, row.email, '更新姓名与每日次数，保留目标密码、角色、停用状态及已有会话');
    }
    for (const row of source.providers) {
      const { old, targetId } = identity('providers', row, target.providers.filter(item => item.name === row.name && item.base_url === row.base_url && item.protocol === row.protocol && item.runtime === row.runtime), row.name);
      maps.providers.set(row.id, targetId); put('providers', { ...row, id: targetId }, ['id'], old, row.name, '更新渠道配置和上游密钥；重置余额缓存');
    }
    for (const row of source.models) {
      const providerId = maps.providers.get(row.provider_id);
      const old = uniqueMatch(target.models.filter(item => item.provider_id === providerId && item.model_id === row.model_id), row.model_id), targetId = old?.id || id(); maps.models.set(row.id, targetId);
      links.push({ source_id: document.sourceId, kind: 'models', source_record_id: row.id, target_record_id: targetId });
      put('models', { ...row, id: targetId, provider_id: providerId }, ['id'], old, `${row.model_id} · ${source.providers.find(item => item.id === row.provider_id)?.name}`, '更新模型绑定、能力和失败策略；清空临时故障与冷却状态');
    }
    for (const row of source.provider_tools) { const providerId = maps.providers.get(row.provider_id); put('provider_tools', { ...row, provider_id: providerId }, ['provider_id'], target.provider_tools.find(item => item.provider_id === providerId), source.providers.find(item => item.id === row.provider_id)?.name || '渠道余额查询'); }
    for (const row of source.model_catalog) put('model_catalog', row, ['name'], target.model_catalog.find(item => item.name === row.name), row.name);
    for (const row of source.model_versions) put('model_versions', row, ['route_key', 'name'], target.model_versions.find(item => item.route_key === row.route_key && item.name === row.name), `${row.route_key} · ${row.name || '默认'}`);
    for (const row of source.model_route_aliases) put('model_route_aliases', row, ['id'], target.model_route_aliases.find(item => item.id === row.id), row.id);
    for (const row of source.work_skills) { const { old, targetId } = identity('work_skills', row, target.work_skills.filter(item => item.name === row.name), row.name); put('work_skills', { ...row, id: targetId }, ['id'], old, row.name); }
    for (const row of source.billing_plans) {
      const data = json(row.data, '套餐'); const { old, targetId } = identity('billing_plans', row, target.billing_plans.filter(item => json(item.data, '套餐').name === data.name), data.name); maps.billing_plans.set(row.id, targetId);
      put('billing_plans', { ...row, id: targetId }, ['id'], old, data.name, '更新套餐配置，保留目标已有订单和订阅快照');
    }
    function planId(original) {
      if (original === null || original === 'free') return original;
      if (!maps.billing_plans.has(original)) {
        const prior = store.get('SELECT target_record_id FROM configuration_import_links WHERE source_id=? AND kind=? AND source_record_id=?', document.sourceId, 'billing_snapshot_plan', original);
        const targetId = prior?.target_record_id || id(); maps.billing_plans.set(original, targetId);
        links.push({ source_id: document.sourceId, kind: 'billing_snapshot_plan', source_record_id: original, target_record_id: targetId });
      }
      return maps.billing_plans.get(original);
    }
    function snapshot(row) { const data = json(row.plan_snapshot, '权益快照'); return JSON.stringify({ ...data, id: planId(row.plan_id) }); }
    const entitlementRows = new Map(source.billing_entitlement_overrides.map(row => [row.user_id, { ...row }]));
    let converted = 0;
    for (const row of document.memberships) {
      const override = entitlementRows.get(row.user_id);
      if (row.active_until <= now() || override && (!override.active_until || override.active_until > now())) continue;
      entitlementRows.set(row.user_id, { ...row, admin_id: document.exportedBy, reason: '从源服务器迁入的当前会员权益；未迁移 Stripe 自动续费关联。' }); converted++;
    }
    if (converted) warnings.push(`${converted} 名用户的当前会员权益将转为本地管理员套餐覆盖，保留原到期时间。Stripe 自动续费、账单与取消操作关联不迁移，源服务器订阅也不会自动取消。`);
    for (const row of entitlementRows.values()) {
      const userId = maps.users.get(row.user_id), mapped = { ...row, user_id: userId, admin_id: maps.users.get(row.admin_id) || actorId, plan_id: planId(row.plan_id), plan_snapshot: snapshot(row) };
      put('billing_entitlement_overrides', mapped, ['user_id'], target.billing_entitlement_overrides.find(item => item.user_id === userId), source.users.find(item => item.id === row.user_id)?.email || '用户套餐');
    }
    const assets = ['billing_checkouts', 'billing_subscriptions', 'billing_customers', 'billing_events'].some(table => exists(table) && store.get(`SELECT 1 FROM ${table} LIMIT 1`));
    const sourcePayment = source.billing_config[0], targetPayment = target.billing_config[0];
    const preservePayment = assets && targetPayment && ['enabled', 'secret_key', 'webhook_secret'].some(key => sourcePayment[key] !== targetPayment[key]);
    put('billing_config', preservePayment ? { ...sourcePayment, enabled: targetPayment.enabled, secret_key: targetPayment.secret_key, webhook_secret: targetPayment.webhook_secret } : sourcePayment, ['id'], targetPayment, 'Stripe 与免费模型范围', preservePayment ? '目标已有 Stripe 资产，保留目标支付开关和两项密钥，仅更新免费模型范围' : '更新支付开关、密钥和免费模型范围');
    if (preservePayment) warnings.push('目标已有 Stripe 交易或订阅关联，支付密钥及开关将保留目标值，避免切换支付账号或破坏现有账单。');
    if (!preservePayment && sourcePayment.enabled) warnings.push('Stripe 配置已包含在导入中。新域名的 Webhook 地址仍需在 Stripe 后台配置；配置迁移不会迁移支付交易或自动续费关联。');
    for (const row of source.user_model_limits) { const userId = maps.users.get(row.user_id); put('user_model_limits', { ...row, user_id: userId }, ['user_id', 'route_key', 'scope_key'], target.user_model_limits.find(item => item.user_id === userId && item.route_key === row.route_key && item.scope_key === row.scope_key), `${source.users.find(item => item.id === row.user_id)?.email} · ${row.route_key} · ${row.variant_name || '默认'}`); }
    for (const row of source.user_model_routing) { const userId = maps.users.get(row.user_id); put('user_model_routing', { ...row, user_id: userId }, ['user_id', 'source_route_key', 'source_variant_name'], target.user_model_routing.find(item => item.user_id === userId && item.source_route_key === row.source_route_key && item.source_variant_name === row.source_variant_name), `${source.users.find(item => item.id === row.user_id)?.email} · ${row.source_route_key} · ${row.source_variant_name || '默认'}`); }
    for (const row of source.announcements) {
      const { old, targetId } = identity('announcements', row, target.announcements.filter(item => item.title === row.title), row.title);
      // Do not let a changed source revision reuse a target's already-read
      // revision, and never copy read receipts from the source server.
      const changed = old && ['title', 'body', 'status'].some(key => old[key] !== row[key]);
      put('announcements', { ...row, id: targetId, revision: old ? changed ? Math.max(old.revision + 1, row.revision) : old.revision : row.revision, author_id: maps.users.get(row.author_id), updated_by: maps.users.get(row.updated_by) }, ['id'], old, row.title);
    }
    for (const row of source.api_export_keys) {
      const old = target.api_export_keys.find(item => item.token_hash === row.token_hash), targetId = old?.id || id();
      links.push({ source_id: document.sourceId, kind: 'api_export_keys', source_record_id: row.id, target_record_id: targetId });
      const ownerId = maps.users.get(row.created_by), importedOwner = operations.find(operation => operation.table === 'users' && operation.row.id === ownerId)?.row;
      if (row.enabled && (importedOwner?.disabled || importedOwner?.role !== 'admin')) warnings.push(`“${row.name}”的来源管理员在目标服务器不可用或不是管理员，此对外 API Key 导入后仍无法调用。`);
      put('api_export_keys', { ...row, id: targetId, created_by: ownerId, model_ids: JSON.stringify(json(row.model_ids, 'API 授权').map(modelId => maps.models.get(modelId))) }, ['id'], old, row.name, '保留原密钥哈希，更新模型授权与开关；原明文密钥仍可使用');
    }
    for (const row of source.invite_groups) {
      if (row.plan_id && row.plan_id !== 'free' && !source.billing_plans.some(plan => plan.id === row.plan_id)) throw fail('邀请分组引用了缺失的套餐。');
      const { old, targetId } = identity('invite_groups', row, target.invite_groups.filter(item => item.name === row.name), row.name);
      put('invite_groups', { ...row, id: targetId, plan_id: planId(row.plan_id) }, ['id'], old, row.name, '更新邀请分组配置；已有邀请链接及快照保留目标值');
    }
    const knownDefaults = knownModelIds(source);
    for (const row of source.settings) {
      let value = row.value;
      if (row.key === 'defaultModelId') {
        const original = json(value);
        if (original !== null && !knownDefaults.has(original)) { value = 'null'; warnings.push('源配置中的默认模型已不存在，导入时将清空默认选择；其他配置正常迁移。'); }
        else value = JSON.stringify(maps.models.get(original) || original);
      }
      put('settings', { ...row, value }, ['key'], target.settings.find(item => item.key === row.key), row.key);
    }
    for (const [table, count] of counts) count.preserve = Math.max(0, target[table].length - (touched.get(table)?.size || 0));
    if (conflicts.length > 2000) warnings.push(`共有 ${conflicts.length} 项匹配配置；预览列出前 2000 项，其余将采用相同合并规则。`);
    return { operations, links, summary: [...counts.values()], conflicts: conflicts.slice(0, 2000), warnings };
  }
  function apply(plan) {
    for (const operation of plan.operations) {
      const { table, keys } = operation; let row = { ...operation.row };
      if (table === 'providers') { const apiKey = row.api_key; delete row.api_key; row.encrypted_key = store.encrypt(apiKey); row.key_hint = `••••${apiKey.slice(-4)}`; row.last_synced_at = null; row.last_sync_error = null; }
      if (table === 'models') Object.assign(row, { failure_count: 0, cooldown_until: null, failure_epoch: (store.get('SELECT failure_epoch FROM models WHERE id=?', row.id)?.failure_epoch || 0) + 1, status: 'untested', last_checked_at: null, error: null });
      if (table === 'provider_tools') Object.assign(row, { balance_data: null, balance_fingerprint: null });
      if (table === 'billing_config') { const secret = row.secret_key, webhook = row.webhook_secret; delete row.secret_key; delete row.webhook_secret; Object.assign(row, { encrypted_secret: secret ? store.encrypt(secret) : null, secret_hint: secret ? secret.slice(-4) : null, encrypted_webhook: webhook ? store.encrypt(webhook) : null, webhook_hint: webhook ? webhook.slice(-4) : null }); }
      // Table/column identifiers come exclusively from the fixed manifest and
      // transformations above, never from the imported document's own keys.
      const columns = Object.keys(row), changed = columns.filter(column => !keys.includes(column));
      store.run(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')}) ON CONFLICT(${keys.join(',')}) DO UPDATE SET ${changed.map(column => `${column}=excluded.${column}`).join(',')}`, ...columns.map(column => row[column]));
    }
    for (const row of plan.links) store.run('INSERT INTO configuration_import_links(source_id,kind,source_record_id,target_record_id) VALUES(?,?,?,?) ON CONFLICT(source_id,kind,source_record_id) DO UPDATE SET target_record_id=excluded.target_record_id', row.source_id, row.kind, row.source_record_id, row.target_record_id);
    // A provider key/URL may have changed even when it had no explicit source
    // balance adapter; invalidate all touched providers' cached amounts.
    for (const operation of plan.operations) if (operation.table === 'providers') store.run('UPDATE provider_tools SET balance_data=NULL,balance_fingerprint=NULL WHERE provider_id=?', operation.row.id);
  }
  async function exportConfig(input, actorId) {
    shape(input, ['currentPassword', 'password'], '导出请求');
    const actor = await authenticate(actorId, input.currentPassword); ensureIdle();
    const document = validateDocument({ _type: CONTENT, version: 1, sourceId, exportedAt: now(), exportedBy: actorId, ...collect() });
    const result = await encryptConfigExport(document, input.password); currentActor(actorId, actor.password); return result;
  }
  async function previewConfig(input, actorId) {
    shape(input, ['currentPassword', 'password', 'document'], '预览请求');
    const actor = await authenticate(actorId, input.currentPassword);
    const document = validateDocument(await decryptConfigExport(input.document, input.password)); currentActor(actorId, actor.password); ensureIdle();
    const target = targetFingerprint(), plan = buildPlan(document, actorId), expires = Date.now() + TTL;
    const fingerprint = digest(randomBytes(32).toString('hex') + target + JSON.stringify(document));
    for (const [key, value] of previews) if (value.actorId === actorId || value.expires <= Date.now()) previews.delete(key);
    while (previews.size >= 4) previews.delete(previews.keys().next().value);
    previews.set(fingerprint, { actorId, actorPassword: actor.password, target, plan, expires });
    return { fingerprint, confirmation: CONFIRM, expiresAt: new Date(expires).toISOString(), summary: plan.summary, conflicts: plan.conflicts, warnings: plan.warnings };
  }
  async function importConfig(input, actorId) {
    shape(input, ['currentPassword', 'fingerprint', 'confirmation'], '导入请求');
    const actor = await authenticate(actorId, input.currentPassword);
    if (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint) || input.confirmation !== CONFIRM) throw fail('请输入预览中的完整确认文字。');
    const preview = previews.get(input.fingerprint);
    if (!preview || preview.actorId !== actorId || preview.expires <= Date.now() || preview.actorPassword !== actor.password) throw fail('导入预览已失效，请重新预览。', 409, 'CONFIG_PREVIEW_EXPIRED');
    store.transaction(() => {
      currentActor(actorId, actor.password); ensureIdle();
      if (targetFingerprint() !== preview.target) throw fail('目标配置已变化，请重新预览后导入。', 409, 'CONFIG_TARGET_CHANGED');
      apply(preview.plan);
      const current = currentActor(actorId, actor.password); if (current.disabled) throw fail('不能覆盖当前管理员。', 409);
    });
    previews.delete(input.fingerprint);
    return { ok: true, summary: preview.plan.summary };
  }
  const cleanup = setInterval(() => { for (const [key, value] of previews) if (value.expires <= Date.now()) previews.delete(key); }, 60_000); cleanup.unref?.();
  function registerRoutes(app, { auth, admin, csrf }) {
    const limiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: '配置迁移操作过于频繁，请稍后重试。' } });
    const guards = [auth, admin, csrf, limiter, express.json({ limit: '48mb' })];
    app.post('/api/admin/config/export', ...guards, async (req, res) => res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="apirouter-configuration-${now().slice(0, 10)}.encrypted.json"` }).json(await exportConfig(req.body, req.user.id)));
    app.post('/api/admin/config/preview', ...guards, async (req, res) => res.set('Cache-Control', 'no-store').json(await previewConfig(req.body, req.user.id)));
    app.post('/api/admin/config/import', ...guards, async (req, res) => res.set('Cache-Control', 'no-store').json(await importConfig(req.body, req.user.id)));
  }
  return { exportConfig, previewConfig, importConfig, registerRoutes, close() { closed = true; clearInterval(cleanup); previews.clear(); } };
}
