import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { createWorkService } from '../server/work.mjs';

test('HTTP Work saves unlimited duration, skips app/router deadline and still stops on user request', { timeout: 15_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-work-timeout-http-'));
  let onStarted;
  const instance = createApp({ dataDir: directory, setupToken: 'unlimited-test-setup', workFactory: options => {
    const service = createWorkService(options);
    return { ...service, isConfigured: () => true, async *stream(input) {
      yield { type: 'delta', text: 'Progress remains saved.' };
      onStarted(input);
      await new Promise((_, reject) => {
        if (input.signal.aborted) reject(input.signal.reason);
        else input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      });
    } };
  } });
  const server = createServer(instance.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    instance.abortAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); instance.close();
    const target = realpathSync(directory), root = realpathSync(tmpdir());
    assert.ok(target.startsWith(root + sep) && target.includes('apirouter-work-timeout-http-')); rmSync(target, { recursive: true, force: true });
  });
  let headers = { 'content-type': 'application/json' };
  const fetchApi = (path, method = 'GET', body) => fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = async (path, method, body) => { const response = await fetchApi(path, method, body); return { status: response.status, data: await response.json() }; };
  const setupResponse = await fetchApi('/api/auth/setup', 'POST', { setupToken: 'unlimited-test-setup', name: 'Admin', email: 'unlimited@example.com', password: 'unlimited-test-password-2026' });
  assert.equal(setupResponse.status, 201); const setup = await setupResponse.json();
  headers = { ...headers, Cookie: setupResponse.headers.get('set-cookie').split(';')[0], 'x-csrf-token': setup.csrfToken };
  const provider = (await json('/api/admin/providers', 'POST', { name: 'Synthetic Work provider', baseUrl: 'https://example.com/v1', apiKey: 'sk-synthetic-unlimited', protocol: 'anthropic', runtime: 'api' })).data.provider;
  const createdModel = await json('/api/admin/models', 'POST', { providerId: provider.id, modelId: 'synthetic-work', routeKey: 'Work model' });
  assert.equal(createdModel.status, 201);
  const modelId = (await json('/api/models')).data.models[0].id;

  const originalSetTimeout = globalThis.setTimeout, taskTimers = [];
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    const stack = new Error().stack ?? '';
    // Observe only app/router deadlines, leaving HTTP and fixture timers alone.
    if (/server\/(?:app|router)\.mjs:/.test(stack)) taskTimers.push(delay);
    return originalSetTimeout(callback, delay, ...args);
  });
  for (const timeoutSeconds of [0, 30]) {
    const changed = await json('/api/admin/work/settings', 'PATCH', { timeoutSeconds });
    assert.equal(changed.status, 200); assert.equal(changed.data.settings.timeoutSeconds, timeoutSeconds);
    const saved = await json('/api/admin/work/settings');
    assert.equal(saved.data.settings.timeoutSeconds, timeoutSeconds);
    assert.equal(JSON.parse(instance.store.get('SELECT value FROM settings WHERE key=?', 'workSettings').value).timeoutSeconds, timeoutSeconds);
    const chat = (await json('/api/chats', 'POST', { modelId, mode: 'work' })).data.chat;
    const started = new Promise(resolve => { onStarted = resolve; });
    const pending = fetchApi(`/api/chats/${chat.id}/messages`, 'POST', { content: 'Run until stopped.' });
    const execution = await started;
    const response = await pending, result = response.text();
    assert.equal(execution.signal.aborted, false);
    assert.deepEqual(taskTimers, timeoutSeconds === 0 ? [] : [90_000]);
    const stopped = await json(`/api/chats/${chat.id}/stop`, 'POST', {});
    assert.equal(stopped.status, 200);
    const stream = await result;
    assert.match(stream, /event: done/); assert.ok(!stream.includes('event: error')); assert.equal(execution.signal.aborted, true);
    const detail = await json(`/api/chats/${chat.id}`);
    assert.equal(detail.data.generating, false);
    assert.equal(detail.data.messages.at(-1).status, 'stopped');
    assert.equal(detail.data.messages.at(-1).content, 'Progress remains saved.');
    taskTimers.length = 0;
  }
});
