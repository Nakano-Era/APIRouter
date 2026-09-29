import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
const frame = data => `data: ${JSON.stringify(data)}\n\n`;

test('HTTP routing integrates equivalent models, retries, persisted cooldown, audit and admin recovery', async t => {
  const originalEnvironment = { private: process.env.ALLOW_PRIVATE_UPSTREAM, origin: process.env.PUBLIC_ORIGIN };
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  delete process.env.PUBLIC_ORIGIN;
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-routing-http-'));
  const servers = [];
  let instance;
  t.after(async () => {
    instance?.abortAll();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    instance?.close();
    const resolved = realpathSync(directory);
    const intendedParent = realpathSync(tmpdir());
    assert.ok(resolved.startsWith(intendedParent + sep) && resolved.includes('apirouter-routing-http-'));
    rmSync(resolved, { recursive: true, force: true });
    if (originalEnvironment.private === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM;
    else process.env.ALLOW_PRIVATE_UPSTREAM = originalEnvironment.private;
    if (originalEnvironment.origin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = originalEnvironment.origin;
  });

  const primaryKey = 'mock-primary-secret-never-display';
  const backupKey = 'mock-backup-secret-never-display';
  const primaryWireId = 'provider-a-special-name';
  const backupWireId = 'provider-b-special-name';
  const routeKey = 'unified-smart-model';
  const requests = [];
  let primaryHealthy = false;
  let primaryCalls = 0;
  let backupCalls = 0;

  function upstream(kind) {
    return createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/v1/models') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ data: [{ id: kind === 'primary' ? primaryWireId : backupWireId }], has_more: false }));
          return;
        }
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        requests.push({ kind, path: url.pathname, headers: req.headers, body });
        if (kind === 'primary') {
          primaryCalls++;
          if (!primaryHealthy) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `Mock outage with ${primaryKey}` } }));
            return;
          }
          res.setHeader('content-type', 'text/event-stream');
          res.write(frame({ choices: [{ index: 0, delta: { content: '主渠道已恢复。' } }] }));
          res.write(frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
          res.end('data: [DONE]\n\n');
          return;
        }
        backupCalls++;
        res.setHeader('content-type', 'text/event-stream');
        res.write(frame({ type: 'message_start', message: { usage: { input_tokens: 14, output_tokens: 1 } } }));
        res.write(frame({ type: 'content_block_delta', delta: { type: 'text_delta', text: '备用渠道完成回答。' } }));
        res.write(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } }));
        res.end(frame({ type: 'message_stop' }));
      } catch (error) { res.destroy(error); }
    });
  }

  const primary = upstream('primary'), backup = upstream('backup');
  servers.push(primary, backup);
  const primaryBase = await listen(primary), backupBase = await listen(backup);
  instance = createApp({ dataDir: directory, setupToken: 'routing-private-setup', logger: { error() {} } });
  const server = createServer(instance.app);
  servers.push(server);
  const base = await listen(server);
  let session;

  async function request(path, { method = 'GET', body, raw = false } = {}) {
    const headers = { ...(session ? { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken } : {}) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(base + path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (raw) return response;
    const data = await response.json();
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
    return { data, response };
  }
  async function send(chatId, modelId, content) {
    const response = await request(`/api/chats/${chatId}/messages`, { method: 'POST', body: { modelId, content }, raw: true });
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    assert.ok(!raw.includes(primaryKey) && !raw.includes(backupKey));
    const events = raw.split('\n\n').filter(part => part.startsWith('event:')).map(part => ({
      type: part.split('\n')[0].slice(7), data: JSON.parse(part.split('\ndata: ')[1]),
    }));
    assert.equal(events.at(-1)?.type, 'done', raw);
    return { events, message: events.at(-1).data.message };
  }

  const bootstrap = await request('/api/auth/setup', { method: 'POST', body: { setupToken: 'routing-private-setup', name: 'Routing Admin', email: 'routing@example.com', password: 'routing-test-password-2026' } });
  session = { cookie: bootstrap.response.headers.get('set-cookie').split(';')[0], csrfToken: bootstrap.data.csrfToken };
  const primaryProvider = (await request('/api/admin/providers', { method: 'POST', body: {
    name: '主渠道', baseUrl: primaryBase, protocol: 'openai-chat', apiKey: primaryKey,
    priority: 20, failureThreshold: 2, cooldownSeconds: 3600,
  } })).data.provider;
  const backupProvider = (await request('/api/admin/providers', { method: 'POST', body: {
    name: '备用渠道', baseUrl: `${backupBase}/v1`, protocol: 'anthropic', authMode: 'bearer', apiKey: backupKey,
    priority: 10, failureThreshold: 3, cooldownSeconds: 60,
  } })).data.provider;
  const primaryModel = (await request(`/api/admin/providers/${primaryProvider.id}/sync`, { method: 'POST' })).data.models[0];
  const backupModel = (await request(`/api/admin/providers/${backupProvider.id}/sync`, { method: 'POST' })).data.models[0];
  assert.equal(primaryModel.modelId, primaryWireId);
  assert.equal(backupModel.modelId, backupWireId);
  await request(`/api/admin/models/${primaryModel.id}`, { method: 'PATCH', body: { enabled: true, routeKey, isDefault: true } });
  await request(`/api/admin/models/${backupModel.id}`, { method: 'PATCH', body: { enabled: true, routeKey } });
  await request('/api/admin/settings', { method: 'PATCH', body: { routingMaxAttempts: 4, retriesPerChannel: 1 } });
  const publicModels = (await request('/api/models')).data;
  assert.equal(publicModels.models.length, 1);
  const routeId = publicModels.models[0].id;
  assert.match(routeId, /^r_[a-f0-9]{32}$/);
  assert.equal(publicModels.defaultModelId, routeId);
  assert.equal(publicModels.models[0].channelCount, 2);
  assert.equal(publicModels.models[0].routeKey, routeKey);
  assert.equal(publicModels.models[0].modelId, routeKey);
  const chat = (await request('/api/chats', { method: 'POST', body: { modelId: routeId } })).data.chat;

  const first = await send(chat.id, routeId, '请先回答第一个问题');
  assert.equal(primaryCalls, 2);
  assert.equal(backupCalls, 1);
  assert.equal(first.events.filter(event => event.type === 'routing').length, 2);
  assert.equal(first.message.content, '备用渠道完成回答。');
  assert.equal(first.message.status, 'complete');
  assert.equal(first.message.modelId, routeId);
  assert.equal(first.message.sourceProvider, '备用渠道');
  assert.equal(first.message.sourceModel, backupWireId);
  const persistedMessage = (await request(`/api/chats/${chat.id}`)).data.messages.at(-1);
  assert.equal(persistedMessage.sourceProvider, '备用渠道');
  assert.equal(persistedMessage.sourceModel, backupWireId);
  assert.equal((await request('/api/admin/stats')).data.requestsToday, 1, 'retries count as one user request');
  const health = (await request('/api/admin/models')).data.models.find(model => model.id === primaryModel.id);
  assert.equal(health.failureCount, 2);
  assert.equal(health.status, 'error');
  assert.ok(Date.parse(health.cooldownUntil) > Date.now());
  const firstLogs = (await request('/api/admin/routing-logs')).data.attempts.reverse();
  assert.deepEqual(firstLogs.map(log => [log.providerName, log.modelId, log.outcome]), [
    ['主渠道', primaryWireId, 'error'], ['主渠道', primaryWireId, 'error'], ['备用渠道', backupWireId, 'complete'],
  ]);
  assert.equal(new Set(firstLogs.map(log => log.requestId)).size, 1);
  assert.ok(!JSON.stringify(firstLogs).includes(primaryKey));
  assert.ok(firstLogs[0].error.includes('503'));
  assert.equal(firstLogs.at(-1).error, null);
  assert.equal(instance.store.get('SELECT input_tokens FROM requests LIMIT 1').input_tokens, 14);
  assert.equal(instance.store.get('SELECT output_tokens FROM requests LIMIT 1').output_tokens, 6);

  // The endpoint has recovered, but persisted cooldown still prevents a paid probe.
  primaryHealthy = true;
  const second = await send(chat.id, routeId, '请接着回答第二个问题');
  assert.equal(primaryCalls, 2);
  assert.equal(backupCalls, 2);
  assert.equal(second.message.sourceProvider, '备用渠道');
  assert.equal((await request('/api/models')).data.models[0].id, routeId);
  assert.equal((await request('/api/admin/stats')).data.requestsToday, 2);

  const reset = (await request(`/api/admin/models/${primaryModel.id}/reset-health`, { method: 'POST' })).data.model;
  assert.equal(reset.failureCount, 0);
  assert.equal(reset.cooldownUntil, null);
  assert.equal(reset.status, 'untested');
  const third = await send(chat.id, routeId, '请回答第三个问题');
  assert.equal(primaryCalls, 3);
  assert.equal(backupCalls, 2);
  assert.equal(third.events.filter(event => event.type === 'routing').length, 0);
  assert.equal(third.message.content, '主渠道已恢复。');
  assert.equal(third.message.sourceProvider, '主渠道');
  assert.equal(third.message.sourceModel, primaryWireId);
  assert.equal((await request('/api/admin/stats')).data.requestsToday, 3);
  const finalHealth = (await request('/api/admin/models')).data.models.find(model => model.id === primaryModel.id);
  assert.equal(finalHealth.status, 'ok');
  assert.equal(finalHealth.failureCount, 0);
  assert.equal(finalHealth.cooldownUntil, null);
  const logs = (await request('/api/admin/routing-logs')).data.attempts;
  assert.equal(logs.length, 5);
  assert.equal(new Set(logs.map(log => log.requestId)).size, 3);
  assert.ok(logs.every(log => log.outcome !== 'running'));

  for (const captured of requests) {
    if (captured.kind === 'primary') {
      assert.equal(captured.path, '/v1/chat/completions');
      assert.equal(captured.body.model, primaryWireId);
      assert.equal(captured.headers.authorization, `Bearer ${primaryKey}`);
    } else {
      assert.equal(captured.path, '/v1/messages');
      assert.equal(captured.body.model, backupWireId);
      assert.equal(captured.headers.authorization, `Bearer ${backupKey}`);
      assert.equal(captured.headers['x-api-key'], undefined);
      assert.equal(captured.headers['anthropic-version'], '2023-06-01');
    }
  }
  assert.ok(JSON.stringify(requests.filter(item => item.kind === 'backup').at(-1).body.messages).includes('请先回答第一个问题'));
  await request(`/api/admin/providers/${primaryProvider.id}`, { method: 'PATCH', body: { priority: 0 } });
  assert.equal((await request('/api/models')).data.models[0].id, routeId, 'public model identity survives channel priority changes');
});
