import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/app.mjs';
import { digest } from '../server/store.mjs';

test('application enforces independent version quotas across messages, continue and regenerate before mutating history; admin export remains protected', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-model-limit-app-')), calls = [];
  const instance = createApp({ dataDir: directory, setupToken: 'local-test-only', logger: { error() {} }, workFactory: () => ({
    registerRoutes() {}, isConfigured: () => true, close() {},
    async *stream(options) { calls.push(options.model.modelId); yield { type: 'delta', text: `测试正文${calls.length}。` }; yield { type: 'usage', inputTokens: 2, outputTokens: 3 }; }
  }) });
  const server = createServer(instance.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, sessions = {}, timestamp = new Date().toISOString();
  t.after(async () => {
    instance.abortAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); instance.close();
    const resolved = realpathSync(directory); assert.ok(resolved.startsWith(realpathSync(tmpdir()) + sep) && resolved.includes('apirouter-model-limit-app-')); rmSync(resolved, { recursive: true, force: true });
  });
  for (const user of ['admin', 'member']) {
    const token = randomBytes(32).toString('base64url'); sessions[user] = token;
    instance.store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', user, user, `${user}@example.com`, 'test', user === 'admin' ? 'admin' : 'user', timestamp);
    instance.store.run('INSERT INTO sessions(token,user_id,csrf,expires_at) VALUES(?,?,?,?)', digest(token), user, 'test-csrf', new Date(Date.now() + 3_600_000).toISOString());
  }
  instance.store.run('INSERT INTO providers(id,name,base_url,protocol,runtime,encrypted_key,key_hint,created_at) VALUES(?,?,?,?,?,?,?,?)', 'provider', 'Private provider', 'https://provider.invalid', 'anthropic', 'claude-code', instance.store.encrypt('secret'), 'hint', timestamp);
  for (const variant of ['高智商版', '普通版']) instance.store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,variant_name) VALUES(?,?,?,?,?,?)', variant, 'provider', `upstream-${variant}`, variant, 'ChatGPT 6 Astra', variant);
  const request = async (path, { user = 'member', method = 'GET', body } = {}) => fetch(base + path, { method, headers: { ...(sessions[user] ? { Cookie: `apirouter_session=${sessions[user]}`, 'X-CSRF-Token': 'test-csrf' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const limitPath = '/api/admin/users/member/model-limits';
  assert.equal((await request(limitPath)).status, 403);
  const saved = await request(limitPath, { user: 'admin', method: 'PUT', body: { limits: [
    { routeKey: 'ChatGPT 6 Astra', variantName: '高智商版', dailyLimit: 3, monthlyLimit: 3 },
    { routeKey: 'ChatGPT 6 Astra', variantName: '普通版', dailyLimit: 1, monthlyLimit: 1 }
  ] } });
  assert.equal(saved.status, 200, await saved.text());
  const { models } = await (await request('/api/models')).json();
  const high = models.find(model => model.variantName === '高智商版'), standard = models.find(model => model.variantName === '普通版');
  assert.ok(high && standard); assert.notEqual(high.id, standard.id);
  const chat = (await (await request('/api/chats', { method: 'POST', body: { modelId: high.id } })).json()).chat;
  for (const [action, body] of [['messages', { content: 'hello' }], ['continue', {}], ['regenerate', {}]]) {
    const response = await request(`/api/chats/${chat.id}/${action}`, { method: 'POST', body });
    const result = await response.text(); assert.equal(response.status, 200, result); assert.match(result, /event: done/);
  }
  assert.equal(calls.length, 3);
  const before = await (await request(`/api/chats/${chat.id}`)).json();
  const denied = await request(`/api/chats/${chat.id}/regenerate`, { method: 'POST', body: {} });
  assert.equal(denied.status, 429); assert.equal((await denied.json()).code, 'USER_MODEL_DAILY_LIMIT');
  assert.deepEqual((await (await request(`/api/chats/${chat.id}`)).json()).messages, before.messages);
  const ordinary = await request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { modelId: standard.id, content: 'ordinary version still has its quota' } });
  assert.equal(ordinary.status, 200); assert.match(await ordinary.text(), /event: done/);
  assert.equal(calls.length, 4);
  const limits = (await (await request(limitPath, { user: 'admin' })).json()).limits;
  assert.equal(limits.find(value => value.variantName === '高智商版').usedToday, 3);
  assert.equal(limits.find(value => value.variantName === '普通版').usedToday, 1);
  const snapshots = instance.store.all('SELECT route_key,variant_name FROM requests ORDER BY rowid');
  assert.ok(snapshots.every(row => row.route_key === 'ChatGPT 6 Astra')); assert.deepEqual(snapshots.map(row => row.variant_name), ['高智商版', '高智商版', '高智商版', '普通版']);
  assert.equal((await request('/api/admin/chats/export', { user: '' })).status, 401);
  assert.equal((await request('/api/admin/chats/export')).status, 403);
  const exported = await request('/api/admin/chats/export', { user: 'admin' });
  assert.equal(exported.status, 200); assert.equal(exported.headers.get('content-type'), 'application/zip'); assert.ok((await exported.arrayBuffer()).byteLength > 100);
});
