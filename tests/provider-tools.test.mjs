import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import express from 'express';
import { createStore, hashPassword } from '../server/store.mjs';
import { parseProviderInput, normalizeProvider, encryptProviderExport, decryptProviderExport, createProviderTools, queryProviderBalance } from '../server/provider-tools.mjs';

const sample = () => ({ name: 'Example', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-private-example-value', protocol: 'openai-chat', runtime: 'api', authMode: 'bearer', models: [{ modelId: 'wire-model', name: 'Visible model', routeKey: 'shared-route', vision: true, enabled: true, reasoningEfforts: ['low', 'high'] }] });
const passphrase = 'private-backup-passphrase-2026';
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-provider-tools-'));
  const store = createStore(directory);
  t.after(() => { store.close(); const resolved = realpathSync(directory); assert.ok(resolved.startsWith(realpathSync(tmpdir()) + sep) && resolved.includes('apirouter-provider-tools-')); rmSync(resolved, { recursive: true, force: true }); });
  const providerJSON = row => ({ id: row.id, baseUrl: row.base_url, protocol: row.protocol, authMode: row.auth_mode, runtime: row.runtime });
  return { store, tools: createProviderTools({ store, providerJSON }) };
}
async function mock(t, handler) {
  const old = process.env.ALLOW_PRIVATE_UPSTREAM; process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  const server = createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (old === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = old; });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, protocol: 'anthropic', authMode: 'x-api-key', apiKey: 'sk-balance-private-test-value' };
}

test('paste recognizes exact New API share JSON, arrays, Claude env and OpenAI env without a network call', async () => {
  const exact = await parseProviderInput('{"_type":"newapi_channel_conn","key":"sk-XXX","url":"https://xxx.com"}');
  assert.equal(exact.providers[0].apiKey, 'sk-XXX'); assert.equal(exact.providers[0].baseUrl, 'https://xxx.com'); assert.equal(exact.providers[0].protocol, 'openai-chat');
  const claude = await parseProviderInput(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://anyrouter.top', ANTHROPIC_AUTH_TOKEN: 'sk-anyrouter-test' } }));
  assert.equal(claude.providers[0].runtime, 'claude-code'); assert.equal(claude.providers[0].protocol, 'anthropic'); assert.equal(claude.providers[0].authMode, 'bearer'); assert.ok(claude.warnings.length);
  const env = await parseProviderInput('export OPENAI_BASE_URL="https://api.example.com/v1"\nexport OPENAI_API_KEY="sk-example-env"');
  assert.equal(env.providers[0].apiKey, 'sk-example-env');
  const powershell = await parseProviderInput('$env:ANTHROPIC_BASE_URL = "https://claude.example.com"\n$env:ANTHROPIC_API_KEY="sk-test"');
  assert.equal(powershell.providers[0].protocol, 'anthropic');
  const array = await parseProviderInput(JSON.stringify([sample(), { ...sample(), baseUrl: 'https://other.example.com' }])); assert.equal(array.providers.length, 2);
  const plain = await parseProviderInput('地址 https://api.example.com/v1\nKey sk-example-plain'); assert.equal(plain.providers[0].apiKey, 'sk-example-plain');
});

test('ambiguous or malformed pasted input is rejected without echoing credentials', async () => {
  for (const input of ['{bad json sk-private}', 'https://one.example.com https://two.example.com sk-first sk-second', 'https://api.example.com/sk-secret-within-path', 'OPENAI_BASE_URL=https://example.com\nOPENAI_API_KEY=sk-first\nOPENAI_API_KEY=sk-second', JSON.stringify({ ...sample(), key: 'sk-different-secret' }), JSON.stringify({ ...sample(), baseUrl: 'https://169.254.169.254' })]) {
    await assert.rejects(parseProviderInput(input), error => error.status === 400 && !error.message.includes('sk-'));
  }
  assert.throws(() => normalizeProvider({ ...sample(), runtime: 'claude-code' }), /Anthropic/);
  assert.throws(() => normalizeProvider({ ...sample(), models: [{ modelId: 'a', reasoningEfforts: ['anything'] }] }), /思考强度/);
  await assert.rejects(parseProviderInput('x'.repeat(2 * 1024 * 1024 + 1)), /2 MB/);
});

test('encrypted export authenticates ciphertext, rejects wrong password and bounded KDF attacks', async () => {
  const document = { _type: 'apirouter_provider_export', version: 1, encrypted: false, providers: [sample()] };
  const envelope = await encryptProviderExport(document, passphrase);
  assert.equal(JSON.stringify(envelope).includes(sample().apiKey), false);
  assert.deepEqual(await decryptProviderExport(envelope, passphrase), document);
  assert.equal((await parseProviderInput(JSON.stringify(envelope), passphrase)).providers[0].models[0].routeKey, 'shared-route');
  await assert.rejects(decryptProviderExport(envelope, 'wrong-long-enough-password'), /密码错误/);
  const tampered = structuredClone(envelope); const bytes = Buffer.from(tampered.cipher.data, 'base64'); bytes[0] ^= 1; tampered.cipher.data = bytes.toString('base64');
  await assert.rejects(decryptProviderExport(tampered, passphrase), /损坏/);
  await assert.rejects(decryptProviderExport({ ...envelope, kdf: { ...envelope.kdf, N: 2 ** 30 } }, passphrase), /参数/);
  await assert.rejects(encryptProviderExport(document, 'short'), /12/);
});

test('import validates atomically, deduplicates canonical URL/key/protocol, and preserves model maps and reasoning', t => {
  const { store, tools } = fixture(t);
  assert.throws(() => tools.importProviders([sample(), { ...sample(), baseUrl: 'https://127.0.0.1' }]), /公网/);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM providers').n, 0);
  assert.deepEqual(tools.importProviders([sample(), { ...sample(), baseUrl: sample().baseUrl + '/' }]), { added: 1, skipped: 1, modelsAdded: 1 });
  assert.deepEqual(tools.importProviders([sample()]), { added: 0, skipped: 1, modelsAdded: 0 });
  const row = store.get('SELECT * FROM providers'); assert.equal(row.encrypted_key.includes(sample().apiKey), false); assert.equal(store.decrypt(row.encrypted_key), sample().apiKey);
  const exported = tools.exportDocument(); assert.equal(exported.providers[0].apiKey, sample().apiKey); assert.equal(exported.providers[0].models[0].routeKey, 'shared-route'); assert.deepEqual(exported.providers[0].models[0].reasoningEfforts, ['low', 'high']);
  assert.deepEqual(tools.importProviders([{ ...exported.providers[0], baseUrl: 'https://restored.example.com' }]), { added: 1, skipped: 0, modelsAdded: 1 });
  assert.equal(store.get('SELECT COUNT(*) AS n FROM models WHERE route_key=?', 'shared-route').n, 2);
});

test('import transaction rolls back every connection when a later insertion fails', t => {
  const { store, tools } = fixture(t); const run = store.run;
  store.run = (sql, ...params) => { if (sql.startsWith('INSERT INTO models') && params.includes('fail-wire')) throw new Error('injected store failure'); return run(sql, ...params); };
  assert.throws(() => tools.importProviders([sample(), { ...sample(), baseUrl: 'https://second.example.com', models: [{ modelId: 'fail-wire' }] }]), /injected/);
  assert.equal(store.get('SELECT COUNT(*) AS n FROM providers').n, 0); assert.equal(store.get('SELECT COUNT(*) AS n FROM models').n, 0);
});

test('provider backups preserve Responses format and model context capacities', t => {
  const { store, tools } = fixture(t);
  tools.importProviders([{ ...sample(), protocol: 'openai-responses', responsesProfile: 'codex', models: [{ ...sample().models[0], contextWindow: 10_000_000, maxOutputTokens: 1_000_000 }] }]);
  const saved = tools.exportDocument().providers[0];
  assert.equal(saved.responsesProfile, 'codex'); assert.equal(saved.models[0].contextWindow, 10_000_000);
  tools.importProviders([{ ...saved, baseUrl: 'https://restored.example.com' }]);
  const restored = store.get('SELECT * FROM providers WHERE base_url=?', 'https://restored.example.com');
  assert.equal(restored.responses_profile, 'codex');
  assert.equal(store.get('SELECT * FROM models WHERE provider_id=?', restored.id).max_output_tokens, 1_000_000);
  assert.throws(() => normalizeProvider({ ...sample(), responsesProfile: 'invalid' }), /请求格式/);
});

test('AnyRouter OpenAI environment imports select Responses rather than Claude Code', async () => {
  const result = await parseProviderInput('OPENAI_BASE_URL=https://anyrouter.top/v1\nOPENAI_API_KEY=sk-import-test');
  assert.equal(result.providers[0].protocol, 'openai-responses');
  assert.equal(result.providers[0].runtime, 'api');
  assert.equal(result.providers[0].responsesProfile, 'auto');
});

test('New API balance uses same service prefix and bearer header, returns raw quota with no credentials', async t => {
  let seen = 0;
  const provider = await mock(t, (req, res) => { seen++; assert.equal(req.url, '/prefix/api/usage/token/'); assert.equal(req.headers.authorization, 'Bearer sk-balance-private-test-value'); assert.equal(req.headers['x-api-key'], undefined); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ code: true, data: { total_granted: 100, total_used: 25, total_available: 75, unlimited_quota: false, expires_at: 0, model_limits_enabled: true, model_limits: { 'model-one': true, 'model-two': false } } })); });
  const balance = await queryProviderBalance({ ...provider, baseUrl: provider.baseUrl + '/prefix/v1' }, 'newapi');
  assert.equal(seen, 1); assert.equal(balance.available, true); assert.equal(balance.remaining, 75); assert.equal(balance.unit, 'quota'); assert.deepEqual(balance.modelLimits, ['model-one']); assert.equal(JSON.stringify(balance).includes(provider.apiKey), false);
});

test('balance never sends key through redirects or to prohibited private targets', async t => {
  let redirectHits = 0;
  const provider = await mock(t, (req, res) => { if (req.url === '/stolen') redirectHits++; res.writeHead(302, { location: '/stolen' }); res.end(); });
  const redirect = await queryProviderBalance(provider, 'newapi'); assert.equal(redirect.available, false); assert.match(redirect.message, /重定向/); assert.equal(redirectHits, 0);
  const blocked = await queryProviderBalance({ ...provider, baseUrl: 'https://169.254.169.254' }, 'newapi'); assert.equal(blocked.available, false); assert.match(blocked.message, /公网|内网/);
  const loopbackOld = process.env.ALLOW_PRIVATE_UPSTREAM; process.env.ALLOW_PRIVATE_UPSTREAM = 'false';
  try { const loopback = await queryProviderBalance(provider, 'newapi'); assert.equal(loopback.available, false); assert.match(loopback.message, /公网|内网/); } finally { process.env.ALLOW_PRIVATE_UPSTREAM = loopbackOld; }
});

test('unsupported or missing balance is unavailable rather than zero; none makes no request', async t => {
  let seen = 0; const provider = await mock(t, (_req, res) => { seen++; res.setHeader('content-type', 'application/json'); res.end('{"success":false,"message":"sk-balance-private-test-value"}'); });
  const none = await queryProviderBalance(provider, 'none'); assert.equal(none.available, false); assert.equal(seen, 0);
  const invalid = await queryProviderBalance(provider, 'newapi'); assert.equal(invalid.available, false); assert.equal('remaining' in invalid, false); assert.equal(JSON.stringify(invalid).includes(provider.apiKey), false);
});

test('legacy billing adapter requires both responses and does not mislabel site units as USD', async t => {
  const seen = [];
  const provider = await mock(t, (req, res) => { seen.push(req.url); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url.includes('subscription') ? { hard_limit_usd: 200 } : { total_usage: 3500 })); });
  const balance = await queryProviderBalance(provider, 'openai-compatible', () => Date.parse('2026-09-30T12:00:00Z'));
  assert.equal(balance.remaining, 165); assert.equal(balance.unit, 'provider-units'); assert.equal(seen.length, 2); assert.equal(seen[0], '/dashboard/billing/subscription'); assert.match(seen[1], /start_date=2026-09-01/);
});

test('admin endpoints enforce role, CSRF, password reauthentication and no-store; cache invalidates after credentials change', async t => {
  const { store, tools } = fixture(t); tools.importProviders([sample()]);
  const password = 'current-admin-password-2026', hash = await hashPassword(password);
  store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', 'admin', 'Admin', 'admin@example.com', hash, 'admin', new Date().toISOString());
  const app = express(); app.use(express.json({ limit: '3mb' }));
  const check = (condition, status) => (req, _res, next) => condition(req) ? next() : next(Object.assign(new Error('denied'), { status }));
  app.use((req, _res, next) => { if (req.headers['test-role']) req.user = { ...store.get('SELECT * FROM users WHERE id=?', 'admin'), role: req.headers['test-role'] }; next(); });
  tools.registerRoutes(app, { auth: check(req => !!req.user, 401), admin: check(req => req.user.role === 'admin', 403), csrf: check(req => req.method === 'GET' || req.headers['x-csrf-token'] === 'valid-token', 403) });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message }));
  const server = createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/api/admin/providers`;
  const request = (path, body, role = 'admin', csrf = true) => fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(role ? { 'test-role': role } : {}), ...(csrf ? { 'x-csrf-token': 'valid-token' } : {}), 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request('/export', { format: 'plain', currentPassword: password }, 'user')).status, 403);
  assert.equal((await request('/export', { format: 'plain', currentPassword: password }, null)).status, 401);
  assert.equal((await request('/export', { format: 'plain', currentPassword: password }, 'admin', false)).status, 403);
  const rejected = await request('/export', { format: 'plain', currentPassword: 'wrong-password' }); assert.equal(rejected.status, 403); assert.equal((await rejected.text()).includes(sample().apiKey), false);
  const plaintext = await request('/export', { format: 'plain', currentPassword: password }); assert.equal(plaintext.status, 200); assert.equal(plaintext.headers.get('cache-control'), 'no-store'); assert.match(plaintext.headers.get('content-disposition'), /attachment/); assert.equal((await plaintext.json()).providers[0].apiKey, sample().apiKey);
  const encrypted = await request('/export', { format: 'encrypted', currentPassword: password, password: passphrase }); const envelope = await encrypted.json(); assert.equal(encrypted.status, 200); assert.equal(JSON.stringify(envelope).includes(sample().apiKey), false); assert.equal((await decryptProviderExport(envelope, passphrase)).providers[0].apiKey, sample().apiKey);
  const row = store.get('SELECT * FROM providers');
  const saved = await request(`/${row.id}/balance`, { adapter: 'none', refresh: true }); assert.equal(saved.status, 200); assert.equal((await saved.json()).balance.available, false);
  assert.equal((await request(`/${row.id}/balance`, undefined, 'user')).status, 403);
  assert.ok(tools.balanceState(row.id).balance);
  store.run('UPDATE providers SET encrypted_key=? WHERE id=?', store.encrypt('sk-new-private-value'), row.id);
  assert.equal(tools.balanceState(row.id).balance, null);
  const state = await request(`/${row.id}/balance`); assert.equal(state.headers.get('cache-control'), 'no-store'); assert.equal((await state.text()).includes('sk-'), false);
});
