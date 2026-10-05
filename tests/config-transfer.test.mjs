import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { digest, hashPassword } from '../server/store.mjs';
import { modelRouteId } from '../server/model-catalog.mjs';
import { createConfigTransfer, encryptConfigExport, decryptConfigExport } from '../server/config-transfer.mjs';

const stamp = '2026-10-01T00:00:00.000Z';
const route = 'Transfer family', version = 'Smart';
const exportPassword = 'configuration-transfer-passphrase';
const accountPassword = label => `${label}-current-account-password`;
const secrets = { upstream: 'sk-fixture-source-upstream-only', stripe: 'sk_test_fixtureSourceOnly123', webhook: 'whsec_fixtureSourceOnly123' };
const clone = value => structuredClone(value);

async function fixture(t, label) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-config-transfer-'));
  // Each fixture represents a separate server with its own generated master key.
  const configuredMaster = process.env.MASTER_KEY; delete process.env.MASTER_KEY;
  let instance;
  try { instance = createApp({ dataDir: directory, logger: { error() {} } }); }
  finally { if (configuredMaster !== undefined) process.env.MASTER_KEY = configuredMaster; }
  const { store } = instance;
  const sessions = {};
  for (const [suffix, role] of [['admin', 'admin'], ['member', 'user']]) {
    const userId = `${label}-${suffix}`, token = randomBytes(32).toString('base64url');
    store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', userId, `${label} ${suffix}`, `${suffix}@example.com`, await hashPassword(accountPassword(label)), role, stamp);
    store.run('INSERT INTO sessions(token,user_id,csrf,expires_at,persistent) VALUES(?,?,?,?,?)', digest(token), userId, `${label}-csrf`, '2099-01-01T00:00:00.000Z', 1);
    sessions[suffix] = token;
  }
  const server = createServer(instance.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const request = (path, { method = 'GET', body, user = 'admin', csrf = true } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: {
    ...(sessions[user] ? { Cookie: `apirouter_session=${sessions[user]}` } : {}), ...(csrf ? { 'X-CSRF-Token': `${label}-csrf` } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  t.after(async () => {
    instance.abortAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); instance.close();
    const safePath = realpathSync(directory); assert.ok(safePath.startsWith(realpathSync(tmpdir()) + sep) && safePath.includes('apirouter-config-transfer-'));
    rmSync(safePath, { recursive: true, force: true });
  });
  return { label, directory, instance, store, request };
}

function seedConfiguration(f) {
  const { store, label } = f, providerId = `${label}-provider`, modelIds = [`${label}-basic`, `${label}-smart`];
  store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,created_at,priority,failure_threshold,cooldown_seconds,auth_mode,runtime,responses_profile,failure_protection_enabled) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)', providerId, 'Source channel', 'https://api.example.com/v1', 'openai-responses', store.encrypt(secrets.upstream), 'hint', stamp, 8, 7, 240, 'bearer', 'api', 'codex', 1);
  store.run('INSERT INTO provider_tools(provider_id,balance_adapter,balance_data,balance_fingerprint) VALUES(?,?,?,?)', providerId, 'openai-compatible', JSON.stringify({ secretMarker: 'BALANCE_CACHE_NOT_CONFIG' }), 'cache-fingerprint');
  store.run('INSERT INTO model_catalog(name,created_at) VALUES(?,?)', route, stamp);
  for (const [index, variant] of ['', version].entries()) {
    store.run('INSERT INTO model_versions(route_key,name,position) VALUES(?,?,?)', route, variant, index);
    store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,variant_name,catalog_assigned,vision,context_window,max_output_tokens,reasoning_efforts,failure_protection_enabled,failure_threshold_override,cooldown_seconds_override,retries_override) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', modelIds[index], providerId, `upstream-${index}`, 'Display model', route, variant, 1, 1, 250000, 16000, '["low","high"]', 1, 4, 90, index);
  }
  store.run('INSERT INTO model_route_aliases(id,route_key,variant_name) VALUES(?,?,?)', modelRouteId('Previous family', version), route, version);
  store.setSetting('siteName', 'Migrated workspace'); store.setSetting('systemPrompt', 'Configuration fixture prompt');
  store.setSetting('dailyLimit', 47); store.setSetting('maxOutputTokens', 8192); store.setSetting('routingMaxAttempts', 9); store.setSetting('retriesPerChannel', 2);
  store.setSetting('defaultModelId', modelRouteId(route, version));
  store.setSetting('workSettings', { enabled: true, maxConcurrentJobs: 3, maxTurns: 25, artifactMaxFiles: 0, artifactTotalMb: 0, userStorageMb: 0 });
  store.setSetting('workSearch', { enabled: true, baseUrl: 'http://work-search:8080' });
  store.run('INSERT INTO work_skills(id,name,description,content,created_at,updated_at) VALUES(?,?,?,?,?,?)', `${label}-skill`, 'transfer-skill', 'Fixture skill', '# Transfer\nCreate the requested output file.', stamp, stamp);
  const plan = { id: `${label}-plan`, name: 'Transfer Plus', description: 'Fixture plan', priceCents: 1200, currency: 'USD', interval: 'month', dailyLimit: 900, allowedRoutes: [route], active: true, allowStripe: true, allowManual: true, sortOrder: 1 };
  store.run('UPDATE billing_config SET enabled=1,encrypted_secret=?,secret_hint=?,encrypted_webhook=?,webhook_hint=?,free_routes=? WHERE id=1', store.encrypt(secrets.stripe), 'only', store.encrypt(secrets.webhook), 'only', JSON.stringify([route]));
  const { id: planId, ...planData } = plan;
  store.run('INSERT INTO billing_plans(id,data,created_at,updated_at) VALUES(?,?,?,?)', planId, JSON.stringify(planData), stamp, stamp);
  for (const [index, variant] of ['', version].entries()) store.run('INSERT INTO user_model_limits(user_id,route_key,scope_key,variant_name,daily_limit,monthly_limit,updated_at) VALUES(?,?,?,?,?,?,?)', `${label}-member`, route, JSON.stringify(variant), variant, index + 2, index + 20, stamp);
  const backups = [{ targetRouteKey: route, targetVariantName: version, effort: 'low' }];
  store.run('INSERT INTO user_model_routing(user_id,source_route_key,source_variant_name,target_route_key,target_variant_name,enabled,effort,updated_at,fallbacks_json) VALUES(?,?,?,?,?,?,?,?,?)', `${label}-member`, route, version, route, '', 1, 'high', stamp, JSON.stringify(backups));
  store.run('INSERT INTO billing_entitlement_overrides(user_id,plan_id,plan_snapshot,active_until,reason,admin_id,updated_at) VALUES(?,?,?,?,?,?,?)', `${label}-member`, plan.id, JSON.stringify(plan), null, 'Configured membership', `${label}-admin`, stamp);
  const exportedKey = `ar_sk_${'k'.repeat(43)}`;
  store.run('INSERT INTO api_export_keys(id,name,token_hash,key_hint,enabled,model_ids,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', `${label}-api-key`, 'Configured API', digest(exportedKey), 'ar_sk_kkkk…kkkk', 1, JSON.stringify(modelIds), `${label}-admin`, stamp);
  store.run('INSERT INTO announcements(id,title,body,status,revision,author_id,updated_by,created_at,updated_at,published_at) VALUES(?,?,?,?,?,?,?,?,?,?)', `${label}-announcement`, 'Configured announcement', 'Formula: $a^2+b^2=c^2$', 'published', 2, `${label}-admin`, `${label}-admin`, stamp, stamp, stamp);
  return { providerId, modelIds, plan, exportedKey, backups };
}

function seedRuntime(f) {
  const { store, label } = f, userId = `${label}-member`;
  store.run('INSERT INTO chats(id,user_id,title,created_at,updated_at) VALUES(?,?,?,?,?)', `${label}-chat`, userId, 'CHAT_MUST_NOT_TRANSFER', stamp, stamp);
  store.run('INSERT INTO messages(id,chat_id,role,content,status,created_at) VALUES(?,?,?,?,?,?)', `${label}-message`, `${label}-chat`, 'assistant', 'MESSAGE_MUST_NOT_TRANSFER', 'complete', stamp);
  store.run('INSERT INTO files(id,user_id,name,mime,size,kind,text_content,created_at) VALUES(?,?,?,?,?,?,?,?)', `${label}-file`, userId, 'SECRET_FILE.txt', 'text/plain', 10, 'text', 'FILE_MUST_NOT_TRANSFER', stamp);
  store.run('INSERT INTO requests(id,user_id,status,created_at) VALUES(?,?,?,?)', `${label}-request`, userId, 'complete', stamp);
  store.run('INSERT INTO invites(id,token_hash,email,expires_at,created_at) VALUES(?,?,?,?,?)', `${label}-invite`, 'INVITE_MUST_NOT_TRANSFER', 'invite@example.com', '2099-01-01', stamp);
  store.run('INSERT INTO work_checkpoints(assistant_id,user_id,chat_id,model,protocol,encrypted_state,updated_at) VALUES(?,?,?,?,?,?,?)', `${label}-message`, userId, `${label}-chat`, 'native', 'openai-responses', store.encrypt('CHECKPOINT_MUST_NOT_TRANSFER'), stamp);
}

function databaseSnapshot(store) {
  return Object.fromEntries(store.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(({ name }) => [name, store.all(`SELECT * FROM ${name} ORDER BY rowid`)]));
}

const actor = f => `${f.label}-admin`;
const credentials = f => ({ currentPassword: accountPassword(f.label), password: exportPassword });
async function exported(f, service = createConfigTransfer({ store: f.store })) {
  const envelope = await service.exportConfig(credentials(f), actor(f));
  return { envelope, document: await decryptConfigExport(envelope, exportPassword) };
}
async function importDocument(f, envelope, service = createConfigTransfer({ store: f.store })) {
  const preview = await service.previewConfig({ ...credentials(f), document: envelope }, actor(f));
  assert.equal(typeof preview.fingerprint, 'string'); assert.ok(preview.fingerprint.length >= 32);
  const result = await service.importConfig({ currentPassword: accountPassword(f.label), fingerprint: preview.fingerprint, confirmation: '合并导入配置' }, actor(f));
  assert.equal(result.ok, true);
  return { preview, result };
}

test('configuration export is authenticated encryption and excludes sessions, conversations and runtime records outside its scope', async t => {
  const source = await fixture(t, 'scope'); seedConfiguration(source); seedRuntime(source);
  source.store.run("UPDATE models SET failure_count=7,cooldown_until='2099-01-01',error='TRANSIENT_FAILURE_NOT_CONFIG',status='error'");
  const passwordHashes = source.store.all('SELECT password FROM users').map(row => row.password);
  const { envelope, document } = await exported(source);
  assert.equal(envelope._type, 'apirouter_configuration_export'); assert.equal(envelope.version, 1); assert.equal(envelope.encrypted, true);
  assert.equal(envelope.cipher.name, 'AES-256-GCM'); assert.equal(envelope.kdf.name, 'scrypt');
  const encoded = JSON.stringify(envelope), plain = JSON.stringify(document);
  for (const secret of [...Object.values(secrets), ...passwordHashes]) assert.ok(!encoded.includes(secret));
  for (const marker of [accountPassword(source.label), `${source.label}-csrf`, 'CHAT_MUST_NOT_TRANSFER', 'MESSAGE_MUST_NOT_TRANSFER', 'FILE_MUST_NOT_TRANSFER', 'CHECKPOINT_MUST_NOT_TRANSFER', 'INVITE_MUST_NOT_TRANSFER', 'BALANCE_CACHE_NOT_CONFIG', 'TRANSIENT_FAILURE_NOT_CONFIG']) assert.ok(!plain.includes(marker), `scope leaked ${marker.slice(0, 30)}`);
  assert.deepEqual(Object.keys(document.tables).sort(), ['settings', 'users', 'providers', 'models', 'provider_tools', 'model_catalog', 'model_versions', 'model_route_aliases', 'work_skills', 'billing_config', 'billing_plans', 'billing_entitlement_overrides', 'user_model_limits', 'user_model_routing', 'announcements', 'api_export_keys', 'invite_groups'].sort());
  assert.equal(document.tables.providers[0].api_key, secrets.upstream);
  assert.equal(document.tables.billing_config[0].secret_key, secrets.stripe);
  assert.equal(document.tables.billing_config[0].webhook_secret, secrets.webhook);
  assert.deepEqual(new Set(document.tables.users.map(row => row.password)), new Set(passwordHashes));
  await assert.rejects(decryptConfigExport(envelope, 'incorrect-transfer-password'));
  const tampered = clone(envelope), bytes = Buffer.from(tampered.cipher.data, 'base64'); bytes[Math.floor(bytes.length / 2)] ^= 1; tampered.cipher.data = bytes.toString('base64');
  await assert.rejects(decryptConfigExport(tampered, exportPassword));
  await assert.rejects(decryptConfigExport({ ...envelope, version: 99 }, exportPassword));
  await assert.rejects(decryptConfigExport({ ...envelope, kdf: { ...envelope.kdf, N: 1073741824 } }, exportPassword));
});

test('cross-server merge reencrypts provider and Stripe keys, maps every identity, preserves administrator login and separates version quotas', async t => {
  const source = await fixture(t, 'source'), target = await fixture(t, 'target');
  const original = seedConfiguration(source), targetOriginal = seedConfiguration(target); seedRuntime(source); seedRuntime(target);
  target.store.run('UPDATE providers SET priority=-5,encrypted_key=?', target.store.encrypt('target-original-provider-key'));
  target.store.run('UPDATE users SET disabled=1,daily_limit=17 WHERE id=?', `${target.label}-member`);
  const targetAdmin = target.store.get('SELECT * FROM users WHERE id=?', actor(target));
  const targetSessions = target.store.all('SELECT * FROM sessions ORDER BY token');
  const targetRuntime = Object.fromEntries(['chats', 'messages', 'files', 'requests', 'invites', 'work_checkpoints'].map(table => [table, target.store.all(`SELECT * FROM ${table}`)]));
  assert.notDeepEqual(readFileSync(join(source.directory, 'master.key')), readFileSync(join(target.directory, 'master.key')));
  const { envelope } = await exported(source), service = createConfigTransfer({ store: target.store });
  const { preview } = await importDocument(target, envelope, service);
  assert.ok(Array.isArray(preview.summary)); assert.ok(Array.isArray(preview.conflicts));
  const provider = target.store.get('SELECT * FROM providers WHERE name=?', 'Source channel');
  assert.ok(provider); assert.equal(provider.id, targetOriginal.providerId); assert.equal(target.store.decrypt(provider.encrypted_key), secrets.upstream);
  assert.notEqual(provider.encrypted_key, source.store.get('SELECT encrypted_key FROM providers').encrypted_key);
  assert.deepEqual([provider.priority, provider.failure_threshold, provider.cooldown_seconds, provider.responses_profile], [8, 7, 240, 'codex']);
  const tool = target.store.get('SELECT * FROM provider_tools WHERE provider_id=?', provider.id); assert.equal(tool.balance_adapter, 'openai-compatible'); assert.equal(tool.balance_data, null);
  const models = target.store.all('SELECT * FROM models ORDER BY model_id'); assert.equal(models.length, 2); assert.ok(models.every(row => row.provider_id === provider.id && row.route_key === route)); assert.deepEqual(models.map(row => row.id), targetOriginal.modelIds);
  assert.deepEqual(models.map(row => [row.variant_name, row.context_window, row.max_output_tokens, row.retries_override]), [['', 250000, 16000, 0], [version, 250000, 16000, 1]]);
  assert.deepEqual(target.store.all('SELECT name FROM model_versions ORDER BY position').map(row => row.name), ['', version]);
  assert.equal(target.store.get('SELECT route_key FROM model_route_aliases').route_key, route);
  assert.equal(target.store.settings().defaultModelId, modelRouteId(route, version)); assert.equal(target.store.settings().siteName, 'Migrated workspace');
  assert.equal(target.store.settings().workSettings.artifactMaxFiles, 0); assert.equal(target.store.settings().workSearch.baseUrl, 'http://work-search:8080');
  assert.match(target.store.get('SELECT content FROM work_skills').content, /Create the requested output file/);
  const billing = target.store.get('SELECT * FROM billing_config'); assert.equal(target.store.decrypt(billing.encrypted_secret), secrets.stripe); assert.equal(target.store.decrypt(billing.encrypted_webhook), secrets.webhook);
  assert.deepEqual(JSON.parse(billing.free_routes), [route]);
  const plan = target.store.get('SELECT * FROM billing_plans'); assert.equal(JSON.parse(plan.data).priceCents, 1200);
  const member = `${target.label}-member`, limits = target.store.all('SELECT * FROM user_model_limits ORDER BY daily_limit');
  assert.deepEqual(limits.map(row => [row.user_id, row.variant_name, row.daily_limit, row.monthly_limit]), [[member, '', 2, 20], [member, version, 3, 21]]);
  const routing = target.store.get('SELECT * FROM user_model_routing'); assert.equal(routing.user_id, member); assert.deepEqual(JSON.parse(routing.fallbacks_json), original.backups);
  const membership = target.store.get('SELECT * FROM billing_entitlement_overrides WHERE user_id=?', member); assert.equal(membership.admin_id, actor(target)); assert.equal(membership.plan_id, plan.id);
  assert.equal(target.store.get('SELECT disabled FROM users WHERE id=?', member).disabled, 1);
  const apiKey = target.store.get('SELECT * FROM api_export_keys'); assert.equal(apiKey.created_by, actor(target)); assert.equal(apiKey.token_hash, digest(original.exportedKey)); assert.deepEqual(new Set(JSON.parse(apiKey.model_ids)), new Set(models.map(row => row.id)));
  const published = target.store.get('SELECT * FROM announcements'); assert.equal(published.author_id, actor(target)); assert.equal(published.updated_by, actor(target));
  const afterAdmin = target.store.get('SELECT * FROM users WHERE id=?', actor(target));
  for (const key of ['id', 'email', 'password', 'role', 'disabled']) assert.equal(afterAdmin[key], targetAdmin[key], `changed target administrator ${key}`);
  assert.deepEqual(target.store.all('SELECT * FROM sessions ORDER BY token'), targetSessions);
  for (const [table, rows] of Object.entries(targetRuntime)) assert.deepEqual(target.store.all(`SELECT * FROM ${table}`), rows, `overwrote target ${table}`);
  const apiResponse = await target.request('/v1/models', { user: '', csrf: false }); assert.equal(apiResponse.status, 401);
  const beforeRepeat = Object.fromEntries(['users', 'providers', 'models', 'billing_plans', 'work_skills', 'api_export_keys', 'announcements'].map(table => [table, target.store.get(`SELECT COUNT(*) count FROM ${table}`).count]));
  await importDocument(target, envelope, service);
  for (const [table, count] of Object.entries(beforeRepeat)) assert.equal(target.store.get(`SELECT COUNT(*) count FROM ${table}`).count, count, `duplicate ${table} after repeated import`);
});

test('preview is read-only, bound to its administrator, and invalidated by changed target configuration', async t => {
  const source = await fixture(t, 'preview-source'), target = await fixture(t, 'preview-target'); seedConfiguration(source);
  const { envelope } = await exported(source), service = createConfigTransfer({ store: target.store });
  const before = databaseSnapshot(target.store), preview = await service.previewConfig({ ...credentials(target), document: envelope }, actor(target));
  assert.deepEqual(databaseSnapshot(target.store), before);
  const displayed = JSON.stringify(preview);
  for (const secret of [...Object.values(secrets), ...source.store.all('SELECT password FROM users').map(row => row.password)]) assert.ok(!displayed.includes(secret));
  await assert.rejects(service.importConfig({ currentPassword: accountPassword(target.label), fingerprint: preview.fingerprint, confirmation: '合并导入配置' }, `${target.label}-member`));
  assert.deepEqual(databaseSnapshot(target.store), before);
  await assert.rejects(service.importConfig({ currentPassword: accountPassword(target.label), fingerprint: preview.fingerprint, confirmation: 'wrong' }, actor(target)));
  assert.deepEqual(databaseSnapshot(target.store), before);
  const fresh = await service.previewConfig({ ...credentials(target), document: envelope }, actor(target));
  target.store.setSetting('siteName', 'An administrator changed this after preview');
  const changed = databaseSnapshot(target.store);
  await assert.rejects(service.importConfig({ currentPassword: accountPassword(target.label), fingerprint: fresh.fingerprint, confirmation: '合并导入配置' }, actor(target)), error => error.status === 409);
  assert.deepEqual(databaseSnapshot(target.store), changed);
});

test('busy servers and database failures roll back every configuration and identity mapping in the import', async t => {
  const source = await fixture(t, 'atomic-source'), target = await fixture(t, 'atomic-target'); seedConfiguration(source);
  const { envelope } = await exported(source);
  let busy = false;
  const service = createConfigTransfer({ store: target.store, ensureIdle() { if (busy) throw Object.assign(new Error('Running job'), { status: 409 }); } });
  const preview = await service.previewConfig({ ...credentials(target), document: envelope }, actor(target));
  busy = true; const beforeBusy = databaseSnapshot(target.store);
  await assert.rejects(service.importConfig({ currentPassword: accountPassword(target.label), fingerprint: preview.fingerprint, confirmation: '合并导入配置' }, actor(target)), error => error.status === 409);
  assert.deepEqual(databaseSnapshot(target.store), beforeBusy); busy = false;
  const retry = await service.previewConfig({ ...credentials(target), document: envelope }, actor(target));
  target.store.db.exec("CREATE TRIGGER reject_transfer_model BEFORE INSERT ON models BEGIN SELECT RAISE(ABORT, 'fixture database failure'); END;");
  const beforeFailure = databaseSnapshot(target.store);
  await assert.rejects(service.importConfig({ currentPassword: accountPassword(target.label), fingerprint: retry.fingerprint, confirmation: '合并导入配置' }, actor(target)));
  assert.deepEqual(databaseSnapshot(target.store), beforeFailure);
});

test('configuration routes require administrator, CSRF and current password before export or import', async t => {
  const f = await fixture(t, 'http'); seedConfiguration(f);
  for (const action of ['export', 'preview', 'import']) {
    const path = `/api/admin/config/${action}`;
    assert.equal((await f.request(path, { method: 'POST', user: '', body: {} })).status, 401);
    assert.equal((await f.request(path, { method: 'POST', user: 'member', body: {} })).status, 403);
    assert.equal((await f.request(path, { method: 'POST', csrf: false, body: {} })).status, 403);
  }
  const rejected = await f.request('/api/admin/config/export', { method: 'POST', body: { ...credentials(f), currentPassword: 'incorrect-current-password' } });
  assert.ok(rejected.status >= 400 && rejected.status < 500);
  const response = await f.request('/api/admin/config/export', { method: 'POST', body: credentials(f) });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  const envelope = await response.json(); assert.equal(envelope.encrypted, true);
  const preview = await f.request('/api/admin/config/preview', { method: 'POST', body: { ...credentials(f), document: envelope } });
  assert.equal(preview.status, 200, await preview.clone().text()); const value = await preview.json();
  const imported = await f.request('/api/admin/config/import', { method: 'POST', body: { currentPassword: accountPassword(f.label), fingerprint: value.fingerprint, confirmation: '合并导入配置' } });
  assert.equal(imported.status, 200, await imported.clone().text()); assert.equal((await imported.json()).ok, true);
});

test('invalid encrypted payloads, unsafe URLs and broken relationships never partially import configuration', async t => {
  const source = await fixture(t, 'invalid-source'), target = await fixture(t, 'invalid-target'); seedConfiguration(source);
  const { envelope, document } = await exported(source), service = createConfigTransfer({ store: target.store });
  const mutations = [
    value => { value.version = 999; },
    value => { value.tables.providers[0].base_url = 'http://127.0.0.1:1234'; },
    value => { value.tables.providers[0].base_url = 'https://127.0.0.1'; },
    value => { value.tables.models[0].provider_id = 'missing-provider'; },
    value => { value.tables.api_export_keys[0].model_ids = '["missing-model"]'; },
    value => { value.tables.user_model_limits[0].user_id = 'missing-user'; },
    value => { value.tables.billing_entitlement_overrides[0].plan_id = 'missing-plan'; },
    value => { value.tables.announcements[0].author_id = 'missing-user'; },
    value => { value.tables.users.push({ ...value.tables.users[0], id: 'duplicate-email', email: value.tables.users[0].email.toUpperCase() }); },
    value => { value.tables.sessions = [{ token: 'not-importable' }]; },
  ];
  for (const mutate of mutations) {
    const invalid = clone(document); mutate(invalid); const before = databaseSnapshot(target.store);
    await assert.rejects(async () => service.previewConfig({ ...credentials(target), document: await encryptConfigExport(invalid, exportPassword) }, actor(target)));
    assert.deepEqual(databaseSnapshot(target.store), before);
  }
  for (const args of [{ ...credentials(target), password: 'wrong-password', document: envelope }, { ...credentials(target), currentPassword: 'wrong-password', document: envelope }]) {
    const before = databaseSnapshot(target.store); await assert.rejects(service.previewConfig(args, actor(target))); assert.deepEqual(databaseSnapshot(target.store), before);
  }
});

test('new users retain their password hash and current membership without importing Stripe transactions or sessions', async t => {
  const source = await fixture(t, 'membership-source'), target = await fixture(t, 'membership-target');
  const configured = seedConfiguration(source), userId = 'source-new-paid-user';
  const userHash = await hashPassword('migrated-user-existing-password');
  source.store.run('INSERT INTO users(id,name,email,password,role,daily_limit,created_at) VALUES(?,?,?,?,?,?,?)', userId, 'Migrated paid user', 'new-paid@example.com', userHash, 'user', 125, stamp);
  source.store.run('INSERT INTO billing_memberships(user_id,plan_id,plan_snapshot,active_until,source,stripe_subscription_id,updated_at) VALUES(?,?,?,?,?,?,?)', userId, configured.plan.id, JSON.stringify(configured.plan), '2099-01-01T00:00:00.000Z', 'stripe', 'sub_MUST_NOT_TRANSFER', stamp);
  source.store.run('INSERT INTO billing_customers(user_id,customer_id) VALUES(?,?)', userId, 'cus_MUST_NOT_TRANSFER');
  source.store.run('INSERT INTO billing_events(id,type,processed_at) VALUES(?,?,?)', 'evt_MUST_NOT_TRANSFER', 'invoice.paid', stamp);
  const { envelope, document } = await exported(source);
  assert.equal(document.memberships.length, 1); assert.equal(document.memberships[0].user_id, userId);
  assert.ok(!JSON.stringify(document).includes('sub_MUST_NOT_TRANSFER')); assert.ok(!JSON.stringify(document).includes('cus_MUST_NOT_TRANSFER')); assert.ok(!JSON.stringify(document).includes('evt_MUST_NOT_TRANSFER'));
  await importDocument(target, envelope);
  const user = target.store.get('SELECT * FROM users WHERE email=?', 'new-paid@example.com'); assert.ok(user); assert.equal(user.password, userHash); assert.equal(user.daily_limit, 125);
  const benefit = target.store.get('SELECT * FROM billing_entitlement_overrides WHERE user_id=?', user.id); assert.ok(benefit); assert.equal(benefit.active_until, '2099-01-01T00:00:00.000Z');
  assert.equal(JSON.parse(benefit.plan_snapshot).name, configured.plan.name);
  for (const table of ['billing_memberships', 'billing_customers', 'billing_checkouts', 'billing_subscriptions', 'billing_events']) assert.equal(target.store.get(`SELECT COUNT(*) count FROM ${table}`).count, 0, `imported ${table}`);
  assert.equal(target.store.get('SELECT COUNT(*) count FROM sessions WHERE user_id=?', user.id).count, 0);
  const login = await target.request('/api/auth/login', { method: 'POST', user: '', csrf: false, body: { email: 'new-paid@example.com', password: 'migrated-user-existing-password' } });
  assert.equal(login.status, 200, await login.clone().text()); assert.equal((await login.json()).user.id, user.id);
});

test('invitation group configuration maps plans and ordered routing while target issued invitations keep their frozen snapshots', async t => {
  const source = await fixture(t, 'group-source'), target = await fixture(t, 'group-target');
  const sourceConfig = seedConfiguration(source), targetConfig = seedConfiguration(target);
  const rules = [{ sourceRouteKey: route, sourceVariantName: version, targetRouteKey: route, targetVariantName: '', enabled: true, effort: 'high', fallbacks: sourceConfig.backups }];
  for (const f of [source, target]) f.store.run('INSERT INTO invite_groups(id,name,enabled,plan_id,duration,active_until,rules_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', `${f.label}-group`, 'Guest Plus', 1, `${f.label}-plan`, 'permanent', null, JSON.stringify(f === source ? rules : []), stamp, stamp);
  target.store.run('INSERT INTO invites(id,token_hash,email,expires_at,created_at,group_id,group_snapshot) VALUES(?,?,?,?,?,?,?)', 'existing-target-link', 'target-link-token-hash', 'guest@example.com', '2099-01-01', stamp, `${target.label}-group`, JSON.stringify({ marker: 'FROZEN_TARGET_INVITE_MUST_SURVIVE' }));
  const targetInvite = target.store.get('SELECT * FROM invites WHERE id=?', 'existing-target-link');
  const { envelope, document } = await exported(source); assert.equal(document.tables.invite_groups.length, 1);
  await importDocument(target, envelope);
  const group = target.store.get('SELECT * FROM invite_groups'); assert.equal(group.id, `${target.label}-group`); assert.equal(group.plan_id, targetConfig.plan.id); assert.equal(group.duration, 'permanent'); assert.deepEqual(JSON.parse(group.rules_json), rules);
  assert.deepEqual(target.store.get('SELECT * FROM invites WHERE id=?', 'existing-target-link'), targetInvite);
  const broken = clone(document); broken.tables.invite_groups[0].plan_id = 'missing-plan'; const before = databaseSnapshot(target.store);
  const service = createConfigTransfer({ store: target.store });
  await assert.rejects(service.previewConfig({ ...credentials(target), document: await encryptConfigExport(broken, exportPassword) }, actor(target)));
  assert.deepEqual(databaseSnapshot(target.store), before);
});

test('existing target Stripe assets preserve its payment account and ambiguous natural matches reject the entire preview', async t => {
  const source = await fixture(t, 'conflict-source'), target = await fixture(t, 'conflict-target'); seedConfiguration(source); seedConfiguration(target);
  target.store.run('UPDATE billing_config SET encrypted_secret=?,encrypted_webhook=? WHERE id=1', target.store.encrypt('sk_test_targetExistingAccount'), target.store.encrypt('whsec_targetExistingHook'));
  target.store.run('INSERT INTO billing_customers(user_id,customer_id) VALUES(?,?)', `${target.label}-member`, 'cus_existing_target_customer');
  const { envelope } = await exported(source); const { preview } = await importDocument(target, envelope);
  const payment = target.store.get('SELECT * FROM billing_config'); assert.equal(target.store.decrypt(payment.encrypted_secret), 'sk_test_targetExistingAccount'); assert.equal(target.store.decrypt(payment.encrypted_webhook), 'whsec_targetExistingHook');
  assert.ok(preview.warnings.some(text => /Stripe/.test(text)));
  const fresh = await fixture(t, 'ambiguous-target'), row = source.store.get('SELECT * FROM providers');
  for (const targetId of ['ambiguous-1', 'ambiguous-2']) fresh.store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,created_at,runtime) VALUES(?,?,?,?,?,?,?,?)', targetId, row.name, row.base_url, row.protocol, fresh.store.encrypt('fixture'), 'hint', stamp, row.runtime);
  const service = createConfigTransfer({ store: fresh.store }), before = databaseSnapshot(fresh.store);
  await assert.rejects(service.previewConfig({ ...credentials(fresh), document: envelope }, actor(fresh)), error => error.status === 409);
  assert.deepEqual(databaseSnapshot(fresh.store), before);
});
