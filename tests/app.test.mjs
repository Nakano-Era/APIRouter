import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';

let instance, server, upstream, base, upstreamBase, directory;
let admin, member, providerId, modelId, chatId, attachmentId;
let listedModels = ['test-chat', 'test-vision'];
const captured = [];
const secret = 'sk-test-DO-NOT-EXPOSE-123456';
const diagnosticModelId = 'diagnostic-rejection';
const diagnosticMarker = 'unique-parameter-error';
const setupToken = 'test-admin-bootstrap-token';
const password = 'an-example-test-password-2026';

async function start(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${server.address().port}`; }
async function request(path, { session, method = 'GET', body, headers = {}, raw = false, csrf = true } = {}) {
  const options = { method, headers: { ...(session ? { Cookie: session.cookie } : {}), ...(session && csrf && method !== 'GET' ? { 'X-CSRF-Token': session.csrfToken } : {}), ...headers } };
  if (body instanceof FormData) options.body = body;
  else if (body !== undefined) { options.body = JSON.stringify(body); options.headers['Content-Type'] = 'application/json'; }
  const response = await fetch(base + path, options);
  if (raw) return response;
  const data = await response.json();
  return { response, data, status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function streamChat(path, session, body) {
  const response = await request(path, { session, method: 'POST', body, raw: true });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  const events = text.split('\n\n').filter(part => part.startsWith('event:')).map(part => ({ type: part.split('\n')[0].slice(7), data: JSON.parse(part.split('\ndata: ')[1]) }));
  return { text, events };
}
before(async () => {
  process.env.ALLOW_PRIVATE_UPSTREAM = 'true';
  directory = mkdtempSync(join(tmpdir(), 'apirouter-api-test-'));
  upstream = createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: listedModels.map(id => ({ id })) })); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); captured.push({ body, auth: req.headers.authorization });
    if (body.model === diagnosticModelId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: `${diagnosticMarker}: unsupported parameter; Authorization: Bearer ${secret}` } }));
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '测试回答：' } }] })}\n\n`);
    if (JSON.stringify(body.messages.at(-1)).includes('WAIT_FOR_STOP')) { const interval = setInterval(() => res.write(': waiting\n\n'), 100); res.on('close', () => clearInterval(interval)); return; }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '你好，世界。' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  upstreamBase = await start(upstream);
  instance = createApp({ dataDir: directory, setupToken, logger: { error() {} } });
  server = createServer(instance.app); base = await start(server);
});
after(async () => {
  instance?.abortAll();
  server?.closeAllConnections(); upstream?.closeAllConnections();
  await Promise.all([server, upstream].filter(Boolean).map(s => new Promise(resolve => s.close(resolve))));
  instance?.close();
  delete process.env.ALLOW_PRIVATE_UPSTREAM;
  rmSync(directory, { recursive: true, force: true });
});

test('bootstrap requires a private token and authenticated APIs reject anonymous requests', async () => {
  const result = await request('/api/auth/session'); assert.deepEqual(result.data, { user: null, needsSetup: true }); assert.ok(!JSON.stringify(result.data).includes(setupToken));
  assert.equal((await request('/api/models')).status, 401);
  assert.equal((await request('/api/auth/setup', { method: 'POST', body: { setupToken: 'wrong', email: 'admin@example.com', name: '管理员', password } })).status, 403);
  const created = await request('/api/auth/setup', { method: 'POST', body: { setupToken, email: 'admin@example.com', name: '管理员', password } });
  assert.equal(created.status, 201); assert.equal(created.data.user.role, 'admin'); assert.match(created.response.headers.get('set-cookie'), /HttpOnly/); assert.match(created.response.headers.get('set-cookie'), /SameSite=Strict/);
  admin = { ...created.data, cookie: created.cookie };
  assert.equal((await request('/api/auth/session', { session: admin })).data.user.id, admin.user.id);
  assert.equal((await request('/api/auth/setup', { method: 'POST', body: { setupToken, email: 'a@example.com', name: 'A', password } })).status, 409);
});
test('CSRF and cross-origin writes are blocked, even with an authenticated cookie', async () => {
  assert.equal((await request('/api/chats', { method: 'POST', session: admin, body: {}, csrf: false })).status, 403);
  assert.equal((await request('/api/chats', { method: 'POST', session: admin, body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: admin.user.email, password }, headers: { Origin: 'https://evil.example' } })).status, 403);
});
test('provider keys are encrypted at rest and model sync preserves administrator choices', async () => {
  assert.deepEqual((await request('/api/models', { session: admin })).data.models, []);
  const created = await request('/api/admin/providers', { session: admin, method: 'POST', body: { name: '本地测试上游', baseUrl: upstreamBase, apiKey: secret, protocol: 'openai-chat' } });
  assert.equal(created.status, 201); providerId = created.data.provider.id;
  assert.ok(!JSON.stringify(created.data).includes(secret)); assert.equal(created.data.provider.hasKey, true);
  const raw = instance.store.get('SELECT * FROM providers WHERE id=?', providerId);
  assert.notEqual(raw.encrypted_key, secret); assert.equal(instance.store.decrypt(raw.encrypted_key), secret);
  const synced = await request(`/api/admin/providers/${providerId}/sync`, { session: admin, method: 'POST' });
  assert.equal(synced.data.count, 2); assert.equal((await request('/api/models', { session: admin })).data.models.length, 0);
  modelId = synced.data.models.find(m => m.modelId === 'test-chat').id;
  await request(`/api/admin/models/${modelId}`, { session: admin, method: 'PATCH', body: { enabled: true, isDefault: true } });
  const available = (await request('/api/models', { session: admin })).data;
  assert.match(available.defaultModelId, /^r_[a-f0-9]{32}$/); assert.equal(available.models[0].modelId, 'test-chat'); assert.equal(available.models.length, 1);
  await request(`/api/admin/providers/${providerId}/sync`, { session: admin, method: 'POST' });
  assert.equal((await request('/api/models', { session: admin })).data.models.length, 1);
  await request(`/api/admin/providers/${providerId}`, { session: admin, method: 'PATCH', body: { apiKey: '' } });
  assert.equal(instance.store.decrypt(instance.store.get('SELECT encrypted_key FROM providers WHERE id=?', providerId).encrypted_key), secret);
  const invalid = await request(`/api/admin/models/${modelId}`, { session: admin, method: 'PATCH', body: { enabled: false, isDefault: true } });
  assert.equal(invalid.status, 400); assert.equal((await request('/api/models', { session: admin })).data.models.length, 1, 'failed patch rolled back');
});
test('invites are single-use and ordinary members cannot access admin configuration', async () => {
  const invited = await request('/api/admin/invites', { session: admin, method: 'POST', body: { email: 'member@example.com', days: 7 } });
  assert.equal(invited.status, 201);
  const token = invited.data.invite.token;
  assert.ok(!JSON.stringify((await request('/api/admin/invites', { session: admin })).data).includes(token));
  const accepted = await request('/api/auth/invite/accept', { method: 'POST', body: { token, name: '成员', email: 'member@example.com', password } });
  assert.equal(accepted.status, 201); member = { ...accepted.data, cookie: accepted.cookie };
  assert.equal((await request('/api/auth/invite/accept', { method: 'POST', body: { token, name: '第二人', password } })).status, 400);
  assert.equal((await request('/api/admin/providers', { session: member })).status, 403);
  assert.equal((await request('/api/admin/users', { session: member })).status, 403);
  assert.equal((await request('/api/settings', { session: member })).data.settings.systemPrompt, undefined);
});

test('per-model retry override is admin-only, nullable, bounded and survives sync', async () => {
  const path = `/api/admin/models/${modelId}`;
  for (const retries of [-1, 101, 1.5, '2']) assert.equal((await request(path, { session: admin, method: 'PATCH', body: { retries } })).status, 400);
  assert.equal((await request(path, { session: member, method: 'PATCH', body: { retries: 0 } })).status, 403);
  assert.equal((await request(path, { session: admin, csrf: false, method: 'PATCH', body: { retries: 0 } })).status, 403);
  assert.equal((await request(path, { session: admin, method: 'PATCH', body: { retries: 0 } })).data.model.retries, 0);
  const synced = await request(`/api/admin/providers/${providerId}/sync`, { session: admin, method: 'POST' });
  assert.equal(synced.data.models.find(model => model.id === modelId).retries, 0);
  assert.equal((await request(path, { session: admin, method: 'PATCH', body: { retries: null } })).data.model.retries, null);
});
test('upstream diagnostics are available only in the administrator probe response', async t => {
  const created = await request('/api/admin/models', { session: admin, method: 'POST', body: { providerId, modelId: diagnosticModelId } });
  assert.equal(created.status, 201);
  const diagnosticId = created.data.model.id;
  let diagnosticChatId;
  t.after(async () => {
    if (diagnosticChatId) await request(`/api/chats/${diagnosticChatId}`, { session: member, method: 'DELETE' });
    await request(`/api/admin/models/${diagnosticId}`, { session: admin, method: 'DELETE' });
  });
  assert.equal((await request(`/api/admin/models/${diagnosticId}`, { session: admin, method: 'PATCH', body: { enabled: true } })).status, 200);

  const attemptsBeforeMemberProbe = captured.length;
  assert.equal((await request(`/api/admin/models/${diagnosticId}/test`, { session: member, method: 'POST' })).status, 403);
  assert.equal(captured.length, attemptsBeforeMemberProbe, 'unauthorized probes never reach the upstream');
  const probe = await request(`/api/admin/models/${diagnosticId}/test`, { session: admin, method: 'POST' });
  assert.equal(probe.status, 200);
  assert.deepEqual(Object.keys(probe.data).sort(), ['diagnostic', 'error', 'latencyMs', 'ok']);
  assert.equal(probe.data.ok, false);
  assert.ok(probe.data.error.includes(diagnosticMarker));
  assert.ok(!probe.data.error.includes(secret));
  assert.equal(typeof probe.data.latencyMs, 'number');
  assert.equal(probe.data.diagnostic.version, 2);
  assert.equal(probe.data.diagnostic.protocol, 'openai-chat');
  assert.equal(probe.data.diagnostic.method, 'POST');
  assert.equal(probe.data.diagnostic.path, '/v1/chat/completions');
  assert.equal(probe.data.diagnostic.modelId, diagnosticModelId);
  assert.equal(probe.data.diagnostic.upstreamStatus, 400);
  assert.ok(probe.data.diagnostic.authMode?.trim());
  assert.ok(probe.data.diagnostic.responseFormat?.trim());
  assert.ok(probe.data.diagnostic.note?.trim());
  assert.ok(probe.data.diagnostic.detail.includes(diagnosticMarker));
  assert.ok(!JSON.stringify(probe.data.diagnostic).includes(secret));
  assert.ok(probe.data.diagnostic.raw.body.includes(diagnosticMarker));
  const rawLogs = (await request('/api/admin/routing-logs', { session: admin })).data.attempts;
  const probeLog = rawLogs.find(log => log.modelId === diagnosticModelId && log.hasDetail);
  assert.ok(probeLog);
  assert.equal((await request('/api/admin/routing-logs/' + probeLog.id + '/detail', { session: member })).status, 403);
  const rawDetail = (await request('/api/admin/routing-logs/' + probeLog.id + '/detail', { session: admin })).data.detail;
  assert.ok(rawDetail.body.includes(diagnosticMarker));
  assert.ok(!JSON.stringify(rawDetail).includes(secret));
  const encrypted = instance.store.get('SELECT encrypted_detail FROM route_attempts WHERE id=?', probeLog.id).encrypted_detail;
  assert.ok(!encrypted.includes(diagnosticMarker));

  const storedError = instance.store.get('SELECT error FROM models WHERE id=?', diagnosticId).error;
  assert.match(storedError, /HTTP 400/);
  const adminModels = (await request('/api/admin/models', { session: admin })).data;
  const publicModels = (await request('/api/models', { session: member })).data;
  assert.ok(publicModels.models.some(model => model.modelId === diagnosticModelId), 'public model listing includes the probed model');
  for (const value of [storedError, adminModels, publicModels]) {
    assert.ok(!JSON.stringify(value).includes(diagnosticMarker));
    assert.ok(!JSON.stringify(value).includes(secret));
  }

  const chat = await request('/api/chats', { session: member, method: 'POST', body: { modelId: diagnosticId } });
  assert.equal(chat.status, 201);
  diagnosticChatId = chat.data.chat.id;
  const reply = await streamChat(`/api/chats/${diagnosticChatId}/messages`, member, { content: 'An ordinary private message.', modelId: diagnosticId });
  assert.equal(reply.events.at(-1).type, 'error');
  assert.match(reply.events.at(-1).data.error, /本次回答未完成/);
  const logs = (await request('/api/admin/routing-logs', { session: admin })).data;
  assert.ok(logs.attempts.some(attempt => attempt.modelId === diagnosticModelId), 'the failed ordinary request was audited');
  for (const value of [reply.text, logs]) {
    assert.ok(!JSON.stringify(value).includes(diagnosticMarker));
    assert.ok(!JSON.stringify(value).includes(secret));
  }
});
test('file ownership and chat ownership hold across upload, read, stream and deletion', async () => {
  const form = new FormData(); form.append('files', new Blob(['机密资料：收入 42。'], { type: 'text/plain' }), '报表.txt');
  const uploaded = await request('/api/files', { session: admin, method: 'POST', body: form });
  assert.equal(uploaded.status, 201); attachmentId = uploaded.data.files[0].id;
  assert.equal(uploaded.data.files[0].name, '报表.txt');
  assert.equal((await request(`/api/files/${attachmentId}/download`, { session: member })).status, 404);
  const chat = await request('/api/chats', { session: admin, method: 'POST', body: { modelId } });
  assert.equal(chat.status, 201); chatId = chat.data.chat.id;
  assert.equal((await request(`/api/chats/${chatId}`, { session: member })).status, 404);
  assert.equal((await request(`/api/chats/${chatId}`, { session: member, method: 'DELETE' })).status, 404);
  const userChat = await request('/api/chats', { session: member, method: 'POST', body: { modelId } });
  assert.equal((await request(`/api/chats/${userChat.data.chat.id}/messages`, { session: member, method: 'POST', body: { content: 'steal', modelId, attachmentIds: [attachmentId] } })).status, 404);
  const result = await streamChat(`/api/chats/${chatId}/messages`, admin, { content: '总结附件', modelId, attachmentIds: [attachmentId] });
  assert.deepEqual(result.events.map(e => e.type), ['meta', 'delta', 'delta', 'done']);
  assert.equal(result.events.at(-1).data.message.status, 'complete');
  assert.equal(result.events.at(-1).data.message.content, '测试回答：你好，世界。');
  assert.ok(JSON.stringify(captured.at(-1).body).includes('收入 42')); assert.equal(captured.at(-1).auth, `Bearer ${secret}`);
  assert.ok(!result.text.includes(secret));
  const stored = (await request(`/api/chats/${chatId}`, { session: admin })).data;
  assert.equal(stored.messages.length, 2); assert.equal(stored.messages[0].attachments[0].id, attachmentId);
});
test('regenerate replaces only last response; editing prunes history and removes orphaned files', async () => {
  await streamChat(`/api/chats/${chatId}/regenerate`, admin, { modelId });
  const first = (await request(`/api/chats/${chatId}`, { session: admin })).data.messages;
  assert.equal(first.length, 2);
  await streamChat(`/api/chats/${chatId}/messages`, admin, { content: '再说明一下', modelId });
  assert.equal((await request(`/api/chats/${chatId}`, { session: admin })).data.messages.length, 4);
  await streamChat(`/api/chats/${chatId}/edit`, admin, { messageId: first[0].id, content: '替换后的消息', attachmentIds: [], modelId });
  const afterEdit = (await request(`/api/chats/${chatId}`, { session: admin })).data.messages;
  assert.equal(afterEdit.length, 2); assert.equal(afterEdit[0].content, '替换后的消息');
  assert.equal((await request(`/api/files/${attachmentId}/download`, { session: admin })).status, 404);
});
test('stop aborts a real stream and in-flight provider changes are rejected', async () => {
  const response = await request(`/api/chats/${chatId}/messages`, { session: admin, method: 'POST', body: { content: 'WAIT_FOR_STOP', modelId }, raw: true });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(); await reader.read();
  assert.equal((await request(`/api/admin/providers/${providerId}`, { session: admin, method: 'PATCH', body: { name: 'during generation' } })).status, 409);
  assert.equal((await request(`/api/chats/${chatId}`, { session: admin, method: 'DELETE' })).status, 409);
  assert.equal((await request(`/api/chats/${chatId}/stop`, { session: member, method: 'POST' })).status, 404);
  assert.equal((await request(`/api/chats/${chatId}/stop`, { session: admin, method: 'POST' })).status, 200);
  while (!(await reader.read()).done) {} reader.releaseLock();
  assert.equal((await request(`/api/chats/${chatId}`, { session: admin })).data.messages.at(-1).status, 'stopped');
});
test('model disappearance, daily limits and disabled accounts are enforced', async () => {
  listedModels = ['test-vision']; await request(`/api/admin/providers/${providerId}/sync`, { session: admin, method: 'POST' });
  assert.equal((await request('/api/models', { session: admin })).data.models.length, 0);
  assert.equal((await request(`/api/chats/${chatId}/messages`, { session: admin, method: 'POST', body: { content: 'unavailable', modelId } })).status, 400);
  listedModels = ['test-chat', 'test-vision']; await request(`/api/admin/providers/${providerId}/sync`, { session: admin, method: 'POST' });
  const ownChat = await request('/api/chats', { session: member, method: 'POST', body: { modelId } });
  await request(`/api/admin/users/${member.user.id}`, { session: admin, method: 'PATCH', body: { dailyLimit: 0 } });
  assert.equal((await request(`/api/chats/${ownChat.data.chat.id}/messages`, { session: member, method: 'POST', body: { content: 'over quota', modelId } })).status, 429);
  await request(`/api/admin/users/${member.user.id}`, { session: admin, method: 'PATCH', body: { disabled: true } });
  assert.equal((await request('/api/models', { session: member })).status, 401);
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: 'member@example.com', password } })).status, 401);
  assert.equal((await request(`/api/admin/users/${admin.user.id}`, { session: admin, method: 'PATCH', body: { disabled: true } })).status, 400);
});
test('deleting a chat frees its attachment storage and logout revokes the session', async () => {
  const form = new FormData(); form.append('files', new Blob(['cleanup']), 'cleanup.txt');
  const uploaded = await request('/api/files', { session: admin, method: 'POST', body: form }); const fileId = uploaded.data.files[0].id;
  await streamChat(`/api/chats/${chatId}/messages`, admin, { content: 'cleanup', modelId, attachmentIds: [fileId] });
  assert.equal((await request(`/api/chats/${chatId}`, { session: admin, method: 'DELETE' })).status, 200);
  assert.equal((await request(`/api/files/${fileId}/download`, { session: admin })).status, 404);
  await request('/api/auth/logout', { session: admin, method: 'POST' });
  assert.equal((await request('/api/models', { session: admin })).status, 401);
  const database = readFileSync(join(directory, 'app.sqlite'));
  assert.ok(!database.includes(Buffer.from(secret))); assert.ok(!database.includes(Buffer.from(password)));
});
