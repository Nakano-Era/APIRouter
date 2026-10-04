import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createStore, digest } from '../server/store.mjs';
import { createApiExports } from '../server/api-exports.mjs';
import { openUpstream, UpstreamError } from '../server/net.mjs';
import { createApp } from '../server/app.mjs';

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-api-exports-')), store = createStore(directory), calls = [];
  const stamp = new Date().toISOString();
  for (const user of ['admin', 'member']) store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', user, user, `${user}@example.com`, 'unused', user === 'admin' ? 'admin' : 'user', stamp);
  function add(rowId, { raw = 'native-model', protocol = 'openai-chat', runtime = 'api', priority = 0, enabled = true, secret = `upstream-secret-${rowId}-private` } = {}) {
    store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,runtime,priority,created_at) VALUES(?,?,?,?,?,?,?,?,?)', `p-${rowId}`, `Channel ${rowId}`, `https://${rowId}.example.com/v1`, protocol, store.encrypt(secret), 'hint', runtime, priority, stamp);
    store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,variant_name,enabled,retries_override) VALUES(?,?,?,?,?,?,?,?)', rowId, `p-${rowId}`, raw, '自定义显示名称', 'Unified display', '高智商版', enabled ? 1 : 0, 0);
  }
  add('chat'); add('responses', { raw: 'response-model', protocol: 'openai-responses' }); add('anthropic', { raw: 'claude-model', protocol: 'anthropic' });
  const service = createApiExports({ store, async upstream(provider, endpoint, input) {
    calls.push({ provider, endpoint, input });
    if (options.upstream) return options.upstream(provider, endpoint, input, calls.length);
    return { response: Response.json({ id: 'native-id', object: 'completion', tools: input.body.tools, model: input.body.model }), signal: input.signal, cleanup: async () => {}, touch() {} };
  }, ...Object.fromEntries(Object.entries(options).filter(([name]) => name !== 'upstream')) });
  const app = express(); service.mountPublic(app); app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { req.user = store.get('SELECT * FROM users WHERE id=?', req.get('x-user') || ''); next(); });
  const auth = (req, res, next) => req.user ? next() : res.sendStatus(401);
  const admin = (req, res, next) => req.user.role === 'admin' ? next() : res.sendStatus(403);
  const csrf = (req, res, next) => ['GET', 'HEAD'].includes(req.method) || req.get('x-csrf-token') === 'test' ? next() : res.sendStatus(403);
  service.registerRoutes(app, { auth, admin, csrf });
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message, code: error.code }));
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await new Promise(resolve => setImmediate(resolve)); store.close(); const path = realpathSync(directory); assert.ok(path.startsWith(realpathSync(tmpdir()) + sep) && path.includes('apirouter-api-exports-')); rmSync(path, { recursive: true, force: true }); });
  const request = (path, { method = 'GET', body, rawBody, key, user = 'admin', csrf = true, headers = {}, signal } = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, signal, headers: { 'x-user': user, ...(csrf ? { 'x-csrf-token': 'test' } : {}), ...(body === undefined && rawBody === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, ...(body === undefined && rawBody === undefined ? {} : { body: rawBody ?? JSON.stringify(body) }) });
  async function key(modelIds = ['chat'], properties = {}) { const response = await request('/api/admin/api-keys', { method: 'POST', body: { name: '外部客户端', modelIds, ...properties } }); assert.equal(response.status, 201); return response.json(); }
  return { store, service, request, key, calls, add };
}

test('export key administration enforces admin/CSRF, stores only hash and returns full key once', async t => {
  const f = await fixture(t), path = '/api/admin/api-keys';
  for (const user of ['', 'member']) for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    const response = await f.request(path + (['PATCH', 'DELETE'].includes(method) ? '/missing' : ''), { method, user, ...(method === 'POST' ? { body: { name: 'key', modelIds: ['chat'] } } : {}) });
    assert.equal(response.status, user ? 403 : 401);
  }
  for (const method of ['POST', 'PATCH', 'DELETE']) assert.equal((await f.request(path + (method === 'POST' ? '' : '/missing'), { method, csrf: false, body: { name: 'key', modelIds: ['chat'] } })).status, 403);
  const { key, apiKey } = await f.key(); assert.match(apiKey, /^ar_sk_[\w-]{43}$/); assert.equal(key.name, '外部客户端'); assert.equal(key.enabled, true);
  const stored = f.store.get('SELECT * FROM api_export_keys WHERE id=?', key.id); assert.equal(stored.token_hash, digest(apiKey)); assert.equal(stored.created_by, 'admin'); assert.ok(!JSON.stringify(stored).includes(apiKey));
  const listed = await (await f.request(path)).json(); assert.deepEqual(listed, { keys: [key] }); assert.ok(!JSON.stringify(listed).includes('hash')); assert.ok(!JSON.stringify(listed).includes(apiKey));
  const patched = await (await f.request(path + '/' + key.id, { method: 'PATCH', body: { name: '改名', enabled: false } })).json(); assert.equal(patched.key.name, '改名'); assert.equal(patched.apiKey, undefined);
  assert.equal((await f.request('/v1/models', { key: apiKey })).status, 401);
  await f.request(path + '/' + key.id, { method: 'PATCH', body: { enabled: true } }); assert.equal((await f.request('/v1/models', { key: apiKey })).status, 200);
  await f.request(path + '/' + key.id, { method: 'DELETE' }); assert.equal((await f.request('/v1/models', { key: apiKey })).status, 401);
});

test('allowlists require explicit API model row IDs and invalid edits do not change existing keys', async t => {
  const f = await fixture(t); f.add('cli', { runtime: 'claude-code' }); const { key } = await f.key();
  for (const modelIds of [[], ['missing'], ['Unified display'], ['native-model'], ['cli']]) {
    const response = await f.request('/api/admin/api-keys/' + key.id, { method: 'PATCH', body: { name: 'must not save', modelIds } }); assert.equal(response.status, 400);
    assert.equal(f.store.get('SELECT name FROM api_export_keys WHERE id=?', key.id).name, '外部客户端');
  }
  assert.equal((await f.request('/api/admin/api-keys', { method: 'POST', body: { name: 'bad', modelIds: ['chat'], enabled: 'yes' } })).status, 400);
  f.store.run("UPDATE providers SET runtime='claude-code' WHERE id='p-chat'");
  assert.equal((await f.request('/api/admin/api-keys/' + key.id, { method: 'PATCH', body: { enabled: false } })).status, 200);
});

test('model listing exposes only authorized raw IDs, deduplicates, and immediately observes channel state and key owner status', async t => {
  const f = await fixture(t); f.add('duplicate'); f.add('unlisted', { raw: 'private-id' });
  const { apiKey } = await f.key(['chat', 'duplicate', 'responses']);
  const list = async headers => { const response = await f.request('/v1/models', { key: apiKey, headers }); assert.equal(response.status, 200); return (await response.json()).data.map(item => item.id); };
  assert.deepEqual(await list(), ['native-model', 'response-model']);
  assert.equal((await f.request('/v1/models', { headers: { 'x-api-key': apiKey }, user: '' })).status, 200);
  assert.equal((await f.request('/v1/models', { key: apiKey, headers: { 'x-api-key': 'ar_sk_' + 'a'.repeat(43) } })).status, 401);
  f.store.run("UPDATE providers SET enabled=0 WHERE id='p-responses'"); f.store.run("UPDATE models SET available=0 WHERE id='chat'"); assert.deepEqual(await list(), ['native-model']);
  f.store.run("DELETE FROM providers WHERE id='p-duplicate'"); assert.deepEqual(await list(), []);
  f.store.run("UPDATE users SET disabled=1 WHERE id='admin'"); assert.equal((await f.request('/v1/models', { key: apiKey })).status, 401);
  f.store.run("UPDATE users SET disabled=0,role='user' WHERE id='admin'"); assert.equal((await f.request('/v1/models', { key: apiKey })).status, 401);
});

test('native APIs preserve tools, images, arbitrary parameters and SSE without alias translation or cross-protocol attempts', async t => {
  const nativeSSE = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello","item_id":"upstream-id"}\n\nevent: response.completed\ndata: {"type":"response.completed"}\n\n';
  const f = await fixture(t, { upstream: async (_provider, _endpoint, input) => ({ response: input.body.stream ? new Response(nativeSSE, { headers: { 'content-type': 'text/event-stream', 'set-cookie': 'upstream-secret=bad' } }) : Response.json({ ...input.body, id: 'native-id' }), signal: input.signal }) });
  const { apiKey } = await f.key(['chat', 'responses', 'anthropic']);
  for (const [path, model, protocol] of [['chat/completions', 'native-model', 'openai-chat'], ['responses', 'response-model', 'openai-responses'], ['messages', 'claude-model', 'anthropic']]) {
    const body = { model, stream: path === 'responses', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }], input: [{ type: 'message', role: 'user', content: 'hello' }], tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }], max_output_tokens: 2048, store: true, temperature: 0.8, reasoning: { effort: 'high' } };
    const response = await f.request('/v1/' + path, { key: apiKey, method: 'POST', body }); assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null);
    if (body.stream) assert.equal(await response.text(), nativeSSE); else assert.deepEqual(await response.json(), { ...body, id: 'native-id' });
    const call = f.calls.at(-1); assert.equal(call.provider.protocol, protocol); assert.deepEqual(call.input.body, body); assert.equal(call.input.nativePassthrough, true); assert.equal(call.endpoint, path); assert.notEqual(call.provider.apiKey, apiKey);
  }
  const before = f.calls.length;
  for (const [path, model] of [['responses', 'native-model'], ['chat/completions', 'Unified display'], ['chat/completions', 'private-id']]) assert.equal((await f.request('/v1/' + path, { key: apiKey, method: 'POST', body: { model } })).status, 404);
  assert.equal(f.calls.length, before); assert.equal(f.store.get('SELECT COUNT(*) n FROM requests').n, 0); assert.equal(f.store.get('SELECT COUNT(*) n FROM chats').n, 0);
});

test('fallback stays within authorized raw-ID rows and honors per-model retries, priorities and cooldowns', async t => {
  const f = await fixture(t, { upstream: async (provider, _endpoint, input) => { if (provider.baseUrl.includes('chat.example')) throw new UpstreamError('bad', 'UPSTREAM_HTTP_ERROR', 502, 502); return { response: Response.json({ model: input.body.model, answer: 'backup' }), signal: input.signal }; } });
  f.add('unapproved', { priority: 100 }); f.add('backup', { priority: -10 }); f.store.run("UPDATE models SET retries_override=1 WHERE id='chat'");
  const { apiKey } = await f.key(['chat', 'backup']);
  const response = await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', body: { model: 'native-model' } }); assert.equal(response.status, 200); assert.equal((await response.json()).answer, 'backup');
  assert.deepEqual(f.calls.map(item => item.provider.baseUrl), ['https://chat.example.com/v1', 'https://chat.example.com/v1', 'https://backup.example.com/v1']);
  f.store.run("UPDATE models SET cooldown_until=? WHERE id='chat'", new Date(Date.now() + 60000).toISOString()); f.calls.length = 0;
  assert.equal((await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', body: { model: 'native-model' } })).status, 200); assert.equal(f.calls.length, 1); assert.match(f.calls[0].provider.baseUrl, /backup/);
});

test('invalid native payload HTTP 400 is sanitized and never retried or sent to a different model', async t => {
  const f = await fixture(t, { upstream: async provider => { const error = new UpstreamError(`secret ${provider.apiKey}`, 'UPSTREAM_HTTP_ERROR', 502, 400); error.rawDiagnostic = { body: provider.apiKey }; throw error; } }); f.add('backup');
  const { apiKey } = await f.key(['chat', 'backup']); const response = await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', body: { model: 'native-model' } }); assert.equal(response.status, 400); const text = await response.text(); assert.ok(!text.includes('upstream-secret')); assert.ok(!text.includes('rawDiagnostic')); assert.equal(f.calls.length, 1);
  const audit = f.store.get('SELECT * FROM route_attempts'); assert.equal(audit.outcome, 'error'); assert.match(audit.request_id, /^api-export-/); assert.equal(audit.model_id, 'backup');
  assert.ok(audit.encrypted_detail); assert.ok(!audit.error.includes('secret')); const detail = JSON.parse(f.store.decrypt(audit.encrypted_detail)); assert.ok(!detail.body.includes('upstream-secret')); assert.match(detail.body, /REDACTED/);
  assert.equal(f.store.get('SELECT COUNT(*) n FROM requests').n, 0);
});

test('upstream idle abort before output retries authorized backup and keeps a distinct audit for each attempt', async t => {
  const f = await fixture(t, { upstream: async (provider, _endpoint, input) => {
    if (!provider.baseUrl.includes('chat.example')) return { response: Response.json({ answer: 'recovered' }), signal: input.signal };
    const timeout = new AbortController(); timeout.abort(new UpstreamError('timeout', 'UPSTREAM_TIMEOUT', 504));
    return { response: new Response(new ReadableStream({ start(controller) { controller.error(new DOMException('Aborted', 'AbortError')); } }), { headers: { 'content-type': 'text/event-stream' } }), signal: timeout.signal };
  } }); f.add('backup', { priority: -1 }); const { apiKey } = await f.key(['chat', 'backup']);
  const response = await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', body: { model: 'native-model' } }); assert.equal(response.status, 200); assert.equal((await response.json()).answer, 'recovered');
  const attempts = f.store.all('SELECT * FROM route_attempts ORDER BY rowid'); assert.equal(attempts.length, 2); assert.equal(attempts[0].request_id, attempts[1].request_id); assert.deepEqual(attempts.map(row => row.outcome), ['error', 'complete']); assert.deepEqual(attempts.map(row => row.model_id), ['chat', 'backup']);
});

test('a stream interrupted after output never restarts on another channel', async t => {
  const f = await fixture(t, { upstream: async (_provider, _endpoint, input) => {
    let count = 0; return { signal: input.signal, response: new Response(new ReadableStream({ async pull(controller) { if (count++ === 0) controller.enqueue(Buffer.from('data: ' + JSON.stringify({ delta: 'first output '.repeat(30) }) + '\n\n')); else { await new Promise(resolve => setTimeout(resolve, 30)); controller.error(new UpstreamError('Interrupted', 'UPSTREAM_CONNECTION_ERROR')); } } }), { headers: { 'content-type': 'text/event-stream' } }) };
  } }); f.add('backup'); const { apiKey } = await f.key(['chat', 'backup']);
  const response = await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', body: { model: 'native-model', stream: true } }); assert.equal(response.status, 200);
  await assert.rejects(response.text()); assert.equal(f.calls.length, 1);
});

test('reflected upstream credentials are redacted across chunk boundaries without exposing export keys', async t => {
  const secret = 'upstream-secret-chat-private';
  const f = await fixture(t, { upstream: async (_provider, _endpoint, input) => ({ signal: input.signal, response: new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('{"message":"prefix ' + secret.slice(0, 12))); controller.enqueue(Buffer.from(secret.slice(12) + ' suffix"}')); controller.close(); } }), { headers: { 'content-type': 'application/json' } }) }) });
  const { apiKey } = await f.key(); const response = await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', body: { model: 'native-model' } }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { message: 'prefix [REDACTED] suffix' });
});

test('public JSON limits apply after API authentication and malformed/oversized requests never call upstream', async t => {
  const f = await fixture(t, { requestLimit: '1kb' }), { apiKey } = await f.key();
  assert.equal((await f.request('/v1/chat/completions', { method: 'POST', body: { model: 'native-model', messages: 'x'.repeat(3000) }, user: 'admin' })).status, 401);
  assert.equal((await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', body: { model: 'native-model', messages: 'x'.repeat(3000) } })).status, 413);
  assert.equal((await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', rawBody: '{wrong' })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('revoking a key cancels an in-flight upstream stream', async t => {
  let aborted = false;
  const f = await fixture(t, { upstream: async (_provider, _endpoint, input) => ({ signal: input.signal, response: new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('data: ' + JSON.stringify({ delta: 'kept '.repeat(100) }) + '\n\n')); input.signal.addEventListener('abort', () => { aborted = true; controller.error(input.signal.reason); }, { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } }) }) });
  const { key, apiKey } = await f.key(); const response = await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', body: { model: 'native-model', stream: true } }); assert.equal(response.status, 200);
  assert.equal((await f.request('/api/admin/api-keys/' + key.id, { method: 'DELETE' })).status, 200); await assert.rejects(response.text()); assert.equal(aborted, true);
});

test('terminal SSE frames reach clients before upstream EOF and client disconnect cancels the upstream', async t => {
  let abortResolve; const aborted = new Promise(resolve => { abortResolve = resolve; });
  const f = await fixture(t, { upstream: async (_provider, _endpoint, input) => ({ signal: input.signal, response: new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('data: [DONE]\n\n')); input.signal.addEventListener('abort', () => { abortResolve(); controller.error(input.signal.reason); }, { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } }) }) });
  const { apiKey } = await f.key(), client = new AbortController();
  const response = await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', body: { model: 'native-model', stream: true }, signal: client.signal });
  const reader = response.body.getReader(); assert.equal(Buffer.from((await reader.read()).value).toString(), 'data: [DONE]\n\n'); client.abort();
  await aborted; await reader.cancel().catch(() => {});
});

test('total timeout returns 504 before any output and never fails over after cancellation', async t => {
  const f = await fixture(t, { totalTimeoutMs: 20, upstream: async (_provider, _endpoint, input) => {
    await new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
  } }); f.add('backup'); const { apiKey } = await f.key(['chat', 'backup']);
  const response = await f.request('/v1/chat/completions', { key: apiKey, method: 'POST', body: { model: 'native-model' } }); assert.equal(response.status, 504); assert.equal((await response.json()).error.code, 'request_timeout'); assert.equal(f.calls.length, 1);
});

test('native network mode skips Codex adapter, forwards only protocol headers and uses upstream credentials', async t => {
  const previous = process.env.ALLOW_PRIVATE_UPSTREAM; process.env.ALLOW_PRIVATE_UPSTREAM = 'true'; t.after(() => { if (previous === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAM; else process.env.ALLOW_PRIVATE_UPSTREAM = previous; });
  let received;
  const server = createServer(async (req, res) => { const chunks = []; for await (const part of req) chunks.push(part); received = { body: JSON.parse(Buffer.concat(chunks)), headers: req.headers, url: req.url }; res.setHeader('content-type', 'application/json'); res.end('{"output":"native"}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const body = { model: 'gpt-test', stream: false, max_output_tokens: 27, temperature: 0.8, input: 'hello', store: true };
  const opened = await openUpstream({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'openai-responses', responsesProfile: 'codex', apiKey: 'actual-upstream-credential' }, 'responses', { body, nativePassthrough: true, requestHeaders: { authorization: 'Bearer exported-key', cookie: 'session=private', 'anthropic-beta': 'feature-v1', 'openai-beta': 'responses=v1', 'x-client-request-id': 'native-client', 'user-agent': 'codex-cli/native-client' } });
  try { assert.deepEqual(await opened.response.json(), { output: 'native' }); } finally { await opened.cleanup(); }
  assert.deepEqual(received.body, body); assert.equal(received.url, '/v1/responses'); assert.equal(received.headers.authorization, 'Bearer actual-upstream-credential'); assert.equal(received.headers.cookie, undefined); assert.equal(received.headers['openai-beta'], 'responses=v1'); assert.equal(received.headers['x-client-request-id'], 'native-client');
  assert.equal(received.headers['user-agent'], 'codex-cli/native-client');
  await assert.rejects(openUpstream({ baseUrl: 'https://10.0.0.1', protocol: 'openai-chat', apiKey: 'key' }, 'chat/completions', { body, nativePassthrough: true }), error => error.code === 'BLOCKED_UPSTREAM_ADDRESS');
});

test('full app mounts API-key auth before session auth and its larger JSON parser', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-export-app-'));
  const service = createApp({ dataDir: directory, setupToken: 'fixture', logger: { error() {} } });
  const server = createServer(service.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close(); const path = realpathSync(directory); assert.ok(path.startsWith(realpathSync(tmpdir()) + sep) && path.includes('apirouter-export-app-')); rmSync(path, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'fixture', name: 'Admin', email: 'admin@example.com', password: 'long-password-12345' }) });
  const cookie = setup.headers.get('set-cookie').split(';')[0], { csrfToken } = await setup.json(), stamp = new Date().toISOString();
  service.store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,created_at) VALUES(?,?,?,?,?,?,?)', 'p', 'test', 'https://example.com', 'openai-chat', service.store.encrypt('credential'), 'hint', stamp);
  service.store.run('INSERT INTO models(id,provider_id,model_id,name,route_key) VALUES(?,?,?,?,?)', 'm', 'p', 'raw', 'pretty', 'pretty');
  const created = await fetch(base + '/api/admin/api-keys', { method: 'POST', headers: { 'content-type': 'application/json', cookie, 'x-csrf-token': csrfToken }, body: JSON.stringify({ name: 'test', modelIds: ['m'] }) }); assert.equal(created.status, 201); const { apiKey } = await created.json();
  assert.equal((await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${apiKey}` } })).status, 200);
  const large = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: 'unauthorized', input: 'x'.repeat(1100000) }) }); assert.equal(large.status, 404);
  assert.equal((await fetch(base + '/api/admin/api-keys', { headers: { authorization: `Bearer ${apiKey}` } })).status, 401);
});
