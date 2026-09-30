import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';

test('HTTP Chat and Work select the configured runtime, persist controls and hide channel identity', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-work-http-'));
  const calls = [];
  let configured = true;
  const instance = createApp({ dataDir: directory, setupToken: 'work-test-setup', workFactory: () => ({
    isConfigured: () => configured, registerRoutes() {}, close() {},
    async *stream(options) { calls.push(options); yield { type: 'activity', label: '正在写入文件', committed: options.mode === 'work' }; yield { type: 'delta', text: '任务已完成。' }; },
  }) });
  const server = createServer(instance.app);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    instance.abortAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); instance.close();
    const target = realpathSync(directory); assert.ok(target.startsWith(realpathSync(tmpdir()) + sep) && target.includes('apirouter-work-http-')); rmSync(target, { recursive: true, force: true });
  });
  let session;
  async function request(path, method = 'GET', body) {
    const response = await fetch(base + path, { method, headers: { ...(session ? { Cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { response, status: response.status, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
  }
  const setup = await request('/api/auth/setup', 'POST', { setupToken: 'work-test-setup', name: 'Work Admin', email: 'work@example.com', password: 'work-password-2026-safe' });
  assert.equal(setup.status, 201);
  session = { cookie: setup.response.headers.get('set-cookie').split(';')[0], csrfToken: setup.data.csrfToken };
  const provider = (await request('/api/admin/providers', 'POST', { name: 'Private source', baseUrl: 'https://example.com/v1', apiKey: 'sk-fixture-private', protocol: 'anthropic', runtime: 'claude-code' })).data.provider;
  const added = await request('/api/admin/models', 'POST', { providerId: provider.id, modelId: 'private-wire-model', routeKey: 'Public model', reasoningEfforts: ['high'] });
  assert.equal(added.status, 201);
  const models = (await request('/api/models')).data.models;
  assert.equal(models.length, 1);
  assert.deepEqual(models[0].modes, ['chat', 'work']);
  assert.deepEqual(models[0].reasoningEfforts, ['auto', 'high']);
  assert.ok(!JSON.stringify(models).includes('Private source') && !JSON.stringify(models).includes('private-wire-model'));
  const modelId = models[0].id;
  const chat = (await request('/api/chats', 'POST', { modelId, mode: 'work', effort: 'high', skillIds: ['skill-one'], webSearch: true })).data.chat;
  const sent = await request(`/api/chats/${chat.id}/messages`, 'POST', { content: '创建文件' });
  assert.equal(sent.status, 200); assert.match(sent.text, /event: done/); assert.match(sent.text, /event: activity/);
  assert.equal(calls.length, 1); assert.equal(calls[0].provider.runtime, 'claude-code'); assert.equal(calls[0].model.modelId, 'private-wire-model');
  assert.equal(calls[0].effort, 'high'); assert.equal(calls[0].mode, 'work'); assert.deepEqual(calls[0].skillIds, ['skill-one']); assert.equal(calls[0].webSearch, true);
  assert.equal(calls[0].context.userId, setup.data.user.id); assert.equal(calls[0].context.chatId, chat.id);
  assert.equal(calls[0].context.continuation, false); assert.ok(calls[0].context.assistantId);
  assert.ok(!sent.text.includes('Private source') && !sent.text.includes('private-wire-model') && !sent.text.includes('sk-fixture-private'));
  const saved = (await request(`/api/chats/${chat.id}`)).data;
  assert.equal(saved.chat.effort, 'high'); assert.equal(saved.chat.mode, 'work'); assert.equal(saved.messages.at(-1).sourceProvider, undefined);
  const rejected = await request(`/api/chats/${chat.id}/messages`, 'POST', { content: 'unsupported', effort: 'max' });
  assert.equal(rejected.status, 400); assert.equal(calls.length, 1);
  assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM requests').n, 1, 'invalid effort does not consume a generation');
  const chatReply = await request(`/api/chats/${chat.id}/messages`, 'POST', { content: '你好', mode: 'chat', effort: 'auto' });
  assert.equal(chatReply.status, 200); assert.match(chatReply.text, /event: done/);
  assert.equal(calls.at(-1).mode, 'chat'); assert.deepEqual(calls.at(-1).skillIds, []); assert.equal(calls.at(-1).webSearch, false);
  const probe = await request(`/api/admin/models/${added.data.model.id}/test`, 'POST', {});
  assert.equal(probe.data.ok, true); assert.equal(calls.at(-1).mode, 'chat'); assert.equal(calls.at(-1).effort, 'auto');
  configured = false;
  const unavailable = await request(`/api/chats/${chat.id}/messages`, 'POST', { content: '没有执行器' });
  assert.equal(unavailable.status, 503);
  assert.equal(instance.store.get('SELECT COUNT(*) AS n FROM requests').n, 2);
});

test('provider paste endpoint accepts a valid import over the ordinary request body limit', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-import-http-'));
  const instance = createApp({ dataDir: directory, setupToken: 'import-test-setup' });
  const server = createServer(instance.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); instance.close(); const target = realpathSync(directory); assert.ok(target.startsWith(realpathSync(tmpdir()) + sep) && target.includes('apirouter-import-http-')); rmSync(target, { recursive: true, force: true }); });
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'import-test-setup', name: 'Import Admin', email: 'import@example.com', password: 'import-password-2026-safe' }) });
  const session = await setup.json();
  const headers = { 'content-type': 'application/json', Cookie: setup.headers.get('set-cookie').split(';')[0], 'x-csrf-token': session.csrfToken };
  const document = JSON.stringify({ _type: 'newapi_channel_conn', key: 'sk-import-test-only', url: 'https://example.com', ignoredPadding: 'x'.repeat(1100_000) });
  const parsed = await fetch(base + '/api/admin/providers/parse', { method: 'POST', headers, body: JSON.stringify({ text: document }) });
  assert.equal(parsed.status, 200); assert.equal((await parsed.json()).providers.length, 1);
  const ordinary = await fetch(base + '/api/chats', { method: 'POST', headers, body: JSON.stringify({ title: 'x'.repeat(1100_000) }) });
  assert.equal(ordinary.status, 413, 'large limit is not applied to unrelated API writes');
});
