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
import { modelRouteId } from '../server/model-catalog.mjs';
import { UpstreamError } from '../server/upstream.mjs';

const source = { routeKey: 'Opus 5.5', variantName: '高智商版', upstream: 'private-opus-5-5', id: 'source' };
const target = { routeKey: 'GPT 6', variantName: '', upstream: 'private-gpt-6', id: 'target' };
const otherVersion = { routeKey: 'GPT 6', variantName: '其他版', upstream: 'private-gpt-other', id: 'other-target' };
const third = { routeKey: '第三个模型', variantName: '', upstream: 'private-third', id: 'third' };
const rule = (values = {}) => ({ sourceRouteKey: source.routeKey, sourceVariantName: source.variantName, targetRouteKey: target.routeKey, targetVariantName: target.variantName, enabled: true, effort: 'auto', ...values });
const sourceId = modelRouteId(source.routeKey, source.variantName);

async function fixture(t, { implementation, continuationCandidates } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-user-route-')), calls = [];
  const instance = createApp({ dataDir: directory, setupToken: 'local-fixture-only', logger: { error() {} }, workFactory: () => ({
    registerRoutes() {}, isConfigured: () => true, close() {}, ...(continuationCandidates ? { continuationCandidates } : {}),
    async *stream(options) { calls.push(options); if (implementation) yield* implementation(options, calls.length); else yield { type: 'delta', text: `回答正文${calls.length}。` }; }
  }) });
  const server = createServer(instance.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`, sessions = {}, stamp = new Date().toISOString();
  t.after(async () => {
    instance.abortAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); instance.close();
    const path = realpathSync(directory); assert.ok(path.startsWith(realpathSync(tmpdir()) + sep) && path.includes('apirouter-user-route-')); rmSync(path, { recursive: true, force: true });
  });
  for (const user of ['admin', 'member', 'other']) {
    const token = randomBytes(32).toString('base64url'); sessions[user] = token;
    instance.store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', user, user, `${user}@example.com`, 'fixture', user === 'admin' ? 'admin' : 'user', stamp);
    instance.store.run('INSERT INTO sessions(token,user_id,csrf,expires_at) VALUES(?,?,?,?)', digest(token), user, 'test-csrf', new Date(Date.now() + 3_600_000).toISOString());
  }
  for (const row of [source, target, otherVersion, third]) {
    instance.store.run('INSERT INTO providers(id,name,base_url,protocol,runtime,encrypted_key,key_hint,created_at) VALUES(?,?,?,?,?,?,?,?)', row.id, `private-${row.id}-provider`, 'https://provider.invalid', 'anthropic', 'claude-code', instance.store.encrypt('fixture-secret'), 'fixture', stamp);
    instance.store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,variant_name,reasoning_efforts) VALUES(?,?,?,?,?,?,?)', row.id, row.id, row.upstream, row.routeKey, row.routeKey, row.variantName, JSON.stringify(row.id === source.id ? ['max', 'high'] : ['low']));
  }
  const request = async (path, { user = 'member', method = 'GET', body, csrf = true } = {}) => fetch(base + path, { method, headers: {
    ...(sessions[user] ? { Cookie: `apirouter_session=${sessions[user]}`, ...(csrf ? { 'X-CSRF-Token': 'test-csrf' } : {}) } : {}),
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const save = (rules, user = 'member') => request(`/api/admin/users/${user}/model-routing`, { user: 'admin', method: 'PUT', body: { rules } });
  const chat = async (user = 'member', options = {}) => {
    const response = await request('/api/chats', { user, method: 'POST', body: { modelId: sourceId, ...options } });
    assert.equal(response.status, 201); return (await response.json()).chat;
  };
  return { instance, calls, request, save, chat };
}

test('user model routing requires administrator auth and CSRF, validates atomically and retains disabled records', async t => {
  const f = await fixture(t), path = '/api/admin/users/member/model-routing';
  assert.equal((await f.request(path, { user: '' })).status, 401);
  assert.equal((await f.request(path)).status, 403);
  assert.equal((await f.request(path, { user: 'admin', method: 'PUT', body: { rules: [rule()] }, csrf: false })).status, 403);
  assert.equal((await f.save([rule()])).status, 200);
  const before = await (await f.request(path, { user: 'admin' })).json();
  for (const invalid of [
    [rule(), rule()], [rule({ targetRouteKey: source.routeKey, targetVariantName: source.variantName })],
    [rule({ effort: 'max' })], [rule({ sourceRouteKey: 'missing' })], [rule({ targetRouteKey: 'missing' })],
    [rule({ enabled: 'yes' })], [rule({ effort: 'unsupported' })], [rule({ targetVariantName: 'x'.repeat(101) })],
    [rule({ sourceRouteKey: 'bad\nname' })], Array.from({ length: 101 }, (_, i) => rule({ sourceRouteKey: `draft-${i}`, enabled: false }))
  ]) {
    assert.equal((await f.save(invalid)).status, 400);
    assert.deepEqual(await (await f.request(path, { user: 'admin' })).json(), before);
  }
  assert.equal((await f.save([rule({ sourceRouteKey: 'deleted', targetRouteKey: 'missing', enabled: false })])).status, 200);
  assert.equal((await f.save([], 'missing-user')).status, 404);
  assert.equal((await f.save([])).status, 200);
  assert.deepEqual(await (await f.request(path, { user: 'admin' })).json(), { rules: [] });
});

test('mapped execution preserves selected model in all public metadata, uses target effort and keeps quotas on the source version', async t => {
  const f = await fixture(t); assert.equal((await f.save([rule({ effort: 'low' })])).status, 200);
  assert.equal((await f.request('/api/admin/users/member/model-limits', { user: 'admin', method: 'PUT', body: { limits: [
    { routeKey: source.routeKey, variantName: source.variantName, dailyLimit: 3, monthlyLimit: 3 },
    { routeKey: target.routeKey, variantName: target.variantName, dailyLimit: 0, monthlyLimit: 0 }
  ] } })).status, 200);
  // A plan may allow the displayed source only. The administrator's target is
  // an execution choice, not a second user-facing model entitlement.
  assert.equal((await f.request('/api/admin/billing/settings', { user: 'admin', method: 'PATCH', body: { freeAllowedRoutes: [source.routeKey] } })).status, 200);
  const publicModels = await (await f.request('/api/models')).json();
  assert.deepEqual(publicModels.models.map(row => row.id), [sourceId]);
  const chat = await f.chat('member', { effort: 'max' });
  for (const [action, body] of [['messages', { content: 'hello' }], ['continue', {}], ['regenerate', {}]]) {
    const response = await f.request(`/api/chats/${chat.id}/${action}`, { method: 'POST', body }); const text = await response.text();
    assert.equal(response.status, 200, text); assert.match(text, /event: done/);
    assert.ok(!text.includes(target.upstream) && !text.includes(target.routeKey) && !text.includes('executionRouteKey'));
    assert.ok(text.includes(sourceId));
  }
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(args => args.model.modelId === target.upstream && args.effort === 'low'));
  assert.equal(f.calls[1].context.continuation, true); assert.equal(f.calls[2].context.continuation, false);
  const history = await (await f.request(`/api/chats/${chat.id}`)).json();
  assert.equal(history.chat.modelId, sourceId); assert.equal(history.chat.effort, 'max');
  assert.ok(history.messages.every(message => message.modelId === sourceId));
  const denied = await f.request(`/api/chats/${chat.id}/regenerate`, { method: 'POST', body: {} });
  assert.equal(denied.status, 429); assert.equal((await denied.json()).code, 'USER_MODEL_DAILY_LIMIT');
  assert.deepEqual(await (await f.request(`/api/chats/${chat.id}`)).json(), history);
  const limits = (await (await f.request('/api/admin/users/member/model-limits', { user: 'admin' })).json()).limits;
  assert.equal(limits.find(row => row.routeKey === source.routeKey).usedToday, 3);
  assert.equal(limits.find(row => row.routeKey === target.routeKey).usedToday, 0);
  const log = (await (await f.request('/api/admin/routing-logs', { user: 'admin' })).json()).attempts;
  assert.equal(log.length, 3); assert.ok(log.every(row => row.sourceRouteKey === source.routeKey && row.sourceVariantName === source.variantName && row.executionRouteKey === target.routeKey && row.executionVariantName === '' && row.userRoutingApplied && row.requestedEffort === 'max' && row.executionEffort === 'low' && row.modelId === target.upstream && row.userId === 'member'));
  assert.equal((await f.request('/api/admin/routing-logs')).status, 403);
  const otherChat = await f.chat('other', { effort: 'max' });
  const otherResponse = await f.request(`/api/chats/${otherChat.id}/messages`, { user: 'other', method: 'POST', body: { content: 'not mapped' } });
  assert.match(await otherResponse.text(), /event: done/); assert.equal(f.calls.at(-1).model.modelId, source.upstream); assert.equal(f.calls.at(-1).effort, 'max');
  // Source entitlements remain enforced even when an execution mapping exists.
  assert.equal((await f.request('/api/admin/billing/settings', { user: 'admin', method: 'PATCH', body: { freeAllowedRoutes: [target.routeKey] } })).status, 200);
  assert.equal((await f.request(`/api/chats/${otherChat.id}/messages`, { user: 'other', method: 'POST', body: { content: 'restricted' } })).status, 403);
});

test('routing is single-hop, disabled mappings use source, and target failure never crosses its version or falls back to source', async t => {
  const f = await fixture(t, { implementation: async function* (args) { if (args.model.modelId === target.upstream) throw new UpstreamError('fixture upstream failed', 'UPSTREAM_HTTP_ERROR', 502, 503); yield { type: 'delta', text: 'ok' }; } });
  f.instance.store.setSetting('retriesPerChannel', 0);
  assert.equal((await f.save([rule(), rule({ sourceRouteKey: target.routeKey, sourceVariantName: '', targetRouteKey: third.routeKey, targetVariantName: '' })])).status, 200);
  const chat = await f.chat();
  const response = await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: 'hello' } });
  assert.match(await response.text(), /event: error/); assert.deepEqual(f.calls.map(args => args.model.modelId), [target.upstream]);
  assert.equal((await f.save([rule({ enabled: false })])).status, 200);
  const next = await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: 'new task' } });
  assert.match(await next.text(), /event: done/); assert.equal(f.calls.at(-1).model.modelId, source.upstream);
});

test('unavailable target rejects before saving messages or quota and never exposes target names', async t => {
  const f = await fixture(t); assert.equal((await f.save([rule()])).status, 200); const chat = await f.chat();
  for (const disable of ['UPDATE models SET enabled=0 WHERE id=?', 'UPDATE providers SET enabled=0 WHERE id=?']) {
    f.instance.store.run(disable, target.id);
    const response = await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: 'hello' } });
    const body = await response.json(); assert.equal(response.status, 503); assert.equal(body.code, 'MODEL_UNAVAILABLE'); assert.ok(!body.error.includes(target.routeKey));
    assert.equal(f.calls.length, 0); assert.equal(f.instance.store.get('SELECT COUNT(*) AS n FROM requests').n, 0);
    assert.deepEqual((await (await f.request(`/api/chats/${chat.id}`)).json()).messages, []);
    f.instance.store.run('UPDATE models SET enabled=1 WHERE id=?', target.id); f.instance.store.run('UPDATE providers SET enabled=1 WHERE id=?', target.id);
  }
  // Existing fixed efforts can become unsupported after a model edit.
  assert.equal((await f.save([rule({ effort: 'low' })])).status, 200);
  f.instance.store.run("UPDATE models SET reasoning_efforts='[]' WHERE id=?", target.id);
  assert.equal((await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: 'hello' } })).status, 503);
  assert.equal(f.instance.store.get('SELECT COUNT(*) AS n FROM requests').n, 0);
});

test('admin cannot change a user mapping while any of their tasks are running', async t => {
  const f = await fixture(t, { implementation: async function* (args) {
    yield { type: 'delta', text: '正在处理' };
    await new Promise((resolve, reject) => { if (args.signal.aborted) reject(args.signal.reason); else args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }); });
  } });
  assert.equal((await f.save([rule()])).status, 200); const chat = await f.chat();
  const running = await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: 'wait' } });
  assert.equal(running.status, 200);
  assert.equal((await f.save([rule({ enabled: false })])).status, 409);
  assert.equal((await f.save([rule()], 'other')).status, 200);
  const before = await (await f.request('/api/admin/users/member/model-routing', { user: 'admin' })).json(); assert.equal(before.rules[0].enabled, true);
  await f.request(`/api/chats/${chat.id}/stop`, { method: 'POST', body: {} }); await running.text();
  assert.equal((await f.save([rule({ enabled: false })])).status, 200);
});

test('Work continuation selects actual target candidates and refuses incompatible checkpoints before any tool replay', async t => {
  let checkpointModel = null;
  const f = await fixture(t, { implementation: async function* (args) {
    checkpointModel = args.model.modelId; yield { type: 'delta', text: args.context.continuation ? '已续写。' : '已执行工具并保存。' };
  }, continuationCandidates(_context, rows) { return checkpointModel ? rows.filter(row => row.model_id === checkpointModel) : rows; } });
  assert.equal((await f.save([rule()])).status, 200); const chat = await f.chat('member', { mode: 'work' });
  for (const [action, body] of [['messages', { content: '执行任务' }], ['continue', {}]]) {
    const response = await f.request(`/api/chats/${chat.id}/${action}`, { method: 'POST', body }); assert.match(await response.text(), /event: done/);
  }
  assert.equal(f.calls.length, 2); assert.ok(f.calls.every(args => args.model.modelId === target.upstream));
  assert.equal((await f.save([rule({ targetRouteKey: third.routeKey, targetVariantName: '' })])).status, 200);
  const history = await (await f.request(`/api/chats/${chat.id}`)).json();
  const rejected = await f.request(`/api/chats/${chat.id}/continue`, { method: 'POST', body: {} });
  assert.equal(rejected.status, 409); const body = await rejected.json(); assert.equal(body.code, 'WORK_CHECKPOINT_INCOMPATIBLE'); assert.ok(!body.error.includes(third.routeKey));
  assert.equal(f.calls.length, 2); assert.equal(f.instance.store.get('SELECT COUNT(*) AS n FROM requests').n, 2);
  assert.deepEqual(await (await f.request(`/api/chats/${chat.id}`)).json(), history);
});

test('ordered targets continue partial output in one assistant and one quota request with per-attempt execution audits', async t => {
  const prefix = '这里是已经保存的第一部分内容，后续方案必须接着这段输出继续完成。';
  const f = await fixture(t, { implementation: async function* (args) {
    if (args.model.modelId === target.upstream) {
      yield { type: 'delta', text: prefix }; yield { type: 'usage', inputTokens: 10, outputTokens: 5 };
      throw new UpstreamError('响应未完成', 'UPSTREAM_INCOMPLETE');
    }
    assert.equal(args.model.modelId, third.upstream); assert.equal(args.context.fallback, true); assert.equal(args.context.continuation, true); assert.equal(args.context.resumeText, prefix);
    assert.equal(args.messages.at(-2).role, 'assistant'); assert.equal(args.messages.at(-2).content, prefix); assert.match(args.messages.at(-1).content, /Continue the same answer/);
    yield { type: 'delta', text: prefix + '现在接续完成。' }; yield { type: 'usage', inputTokens: 20, outputTokens: 8 };
  } });
  assert.equal((await f.save([rule({ effort: 'low', fallbacks: [{ targetRouteKey: third.routeKey, targetVariantName: '', effort: 'low' }] })])).status, 200);
  // A target's own routing rule must not introduce an implicit next hop.
  f.instance.store.run('INSERT INTO user_model_routing(user_id,source_route_key,source_variant_name,target_route_key,target_variant_name,effort,updated_at) VALUES(?,?,?,?,?,?,?)', 'member', third.routeKey, '', otherVersion.routeKey, otherVersion.variantName, 'auto', new Date().toISOString());
  assert.equal((await f.request('/api/admin/users/member/model-limits', { user: 'admin', method: 'PUT', body: { limits: [{ routeKey: source.routeKey, variantName: source.variantName, dailyLimit: 1, monthlyLimit: 1 }] } })).status, 200);
  const chat = await f.chat();
  const response = await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: '连续回答' } });
  const text = await response.text(); assert.equal(response.status, 200); assert.equal((text.match(/event: done/g) || []).length, 1); assert.ok(!text.includes('event: error'));
  assert.ok(!text.includes(target.routeKey) && !text.includes(third.routeKey)); assert.equal(f.calls.length, 3);
  const history = await (await f.request(`/api/chats/${chat.id}`)).json();
  assert.equal(history.messages.length, 2); assert.equal(history.messages[1].content, prefix + '现在接续完成。'); assert.equal(history.messages[1].status, 'complete'); assert.equal(history.messages[1].modelId, sourceId);
  const request = f.instance.store.get('SELECT * FROM requests');
  assert.equal(f.instance.store.get('SELECT COUNT(*) AS count FROM requests').count, 1); assert.equal(request.route_key, source.routeKey); assert.equal(request.variant_name, source.variantName);
  assert.equal(request.execution_route_key, third.routeKey); assert.equal(request.input_tokens, 40); assert.equal(request.output_tokens, 18);
  const logs = (await (await f.request('/api/admin/routing-logs', { user: 'admin' })).json()).attempts.reverse();
  assert.deepEqual(logs.map(row => [row.executionRouteKey, row.executionVariantName, row.executionEffort, row.outcome]), [[target.routeKey, '', 'low', 'error'], [target.routeKey, '', 'low', 'error'], [third.routeKey, '', 'low', 'complete']]);
  assert.ok(logs.every(row => row.requestId === request.id && row.sourceRouteKey === source.routeKey));
  assert.equal((await f.request(`/api/chats/${chat.id}/continue`, { method: 'POST', body: {} })).status, 429);
});

test('all failed targets preserve cumulative partial text and remain continuable without falsely completing', async t => {
  const f = await fixture(t, { implementation: async function* (_args, number) {
    yield { type: 'delta', text: `第${number}部分也已保存。` };
    throw new UpstreamError('输出达到上限', 'OUTPUT_LIMIT_REACHED');
  } });
  assert.equal((await f.save([rule({ fallbacks: [{ targetRouteKey: third.routeKey, targetVariantName: '', effort: 'auto' }] })])).status, 200);
  const chat = await f.chat(), response = await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: '继续保存' } });
  const stream = await response.text(); assert.match(stream, /event: error/); assert.ok(!stream.includes('event: done')); assert.equal(f.calls.length, 4);
  const history = await (await f.request(`/api/chats/${chat.id}`)).json();
  assert.equal(history.messages[1].content, '第1部分也已保存。第2部分也已保存。第3部分也已保存。第4部分也已保存。'); assert.equal(history.messages[1].status, 'error'); assert.equal(history.messages[1].canContinue, true);
  assert.equal(f.instance.store.get('SELECT COUNT(*) AS count FROM requests').count, 1);
});

test('failed prechecks skip unavailable effort and context targets before executing the first usable fallback', async t => {
  const f = await fixture(t);
  assert.equal((await f.save([rule({ effort: 'low', fallbacks: [
    { targetRouteKey: third.routeKey, targetVariantName: '', effort: 'low' },
    { targetRouteKey: otherVersion.routeKey, targetVariantName: otherVersion.variantName, effort: 'low' },
    { targetRouteKey: source.routeKey, targetVariantName: source.variantName, effort: 'high' }
  ] })])).status, 200);
  f.instance.store.run('UPDATE providers SET enabled=0 WHERE id=?', target.id);
  f.instance.store.run("UPDATE models SET reasoning_efforts='[]' WHERE id=?", third.id);
  f.instance.store.run('UPDATE models SET context_window=1 WHERE id=?', otherVersion.id);
  const chat = await f.chat(), response = await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: '跳过不可用方案' } });
  assert.equal(response.status, 200); assert.match(await response.text(), /event: done/);
  assert.deepEqual(f.calls.map(call => call.model.modelId), [source.upstream]); assert.equal(f.calls[0].effort, 'high');
  assert.equal(f.instance.store.get('SELECT COUNT(*) AS count FROM requests').count, 1);
  assert.deepEqual(f.instance.store.all('SELECT outcome FROM route_attempts ORDER BY rowid').map(row => row.outcome), ['skipped', 'skipped', 'skipped', 'complete']);
});

test('target vision mismatch skips to an image-capable fallback without rejecting a valid source image request', async t => {
  const f = await fixture(t);
  f.instance.store.run('UPDATE models SET vision=1 WHERE id IN (?,?)', source.id, third.id);
  assert.equal((await f.save([rule({ fallbacks: [{ targetRouteKey: third.routeKey, targetVariantName: '', effort: 'auto' }] })])).status, 200);
  const { writeFileSync } = await import('node:fs');
  f.instance.store.run('INSERT INTO files(id,user_id,name,mime,size,kind,created_at) VALUES(?,?,?,?,?,?,?)', 'image', 'member', 'test.png', 'image/png', 1, 'image', new Date().toISOString());
  writeFileSync(join(f.instance.store.dataDir, 'files', 'image'), Buffer.from([0]));
  const chat = await f.chat(), response = await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: '看图', attachmentIds: ['image'] } });
  assert.equal(response.status, 200); assert.match(await response.text(), /event: done/);
  assert.deepEqual(f.calls.map(call => call.model.modelId), [third.upstream]); assert.equal(f.calls[0].messages[0].attachments[0].kind, 'image');
});

test('active planned backup routes are busy and a user stop never invokes the backup', async t => {
  const entered = Promise.withResolvers();
  const f = await fixture(t, { implementation: async function* (args) {
    yield { type: 'delta', text: '正在执行第一方案' }; entered.resolve();
    await new Promise((resolve, reject) => args.signal.aborted ? reject(args.signal.reason) : args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }));
  } });
  assert.equal((await f.save([rule({ fallbacks: [{ targetRouteKey: third.routeKey, targetVariantName: '', effort: 'auto' }] })])).status, 200);
  const chat = await f.chat(), running = await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: '执行任务' } });
  await entered.promise;
  assert.equal((await f.request(`/api/admin/providers/${third.id}`, { user: 'admin', method: 'PATCH', body: { enabled: false } })).status, 409);
  assert.equal((await f.request('/api/admin/model-groups', { user: 'admin', method: 'PUT', body: { originalName: third.routeKey, name: '改名', variants: [{ name: '', modelIds: [third.id] }] } })).status, 409);
  assert.equal((await f.request(`/api/chats/${chat.id}/stop`, { method: 'POST', body: {} })).status, 200);
  const text = await running.text(); assert.match(text, /event: done/); assert.equal(f.calls.length, 1);
  assert.equal(f.instance.store.get('SELECT status FROM requests').status, 'stopped');
  assert.equal((await (await f.request(`/api/chats/${chat.id}`)).json()).messages[1].status, 'stopped');
});

test('the per-target channel attempt budget does not truncate a longer explicit fallback sequence', async t => {
  const f = await fixture(t, { implementation: async function* (args) {
    if (args.model.modelId !== 'backup-7-upstream') throw new UpstreamError('上游响应超时', 'UPSTREAM_TIMEOUT');
    yield { type: 'delta', text: '最后方案成功完成。' };
  } });
  const fallbacks = [];
  f.instance.store.setSetting('routingMaxAttempts', 1);
  f.instance.store.setSetting('retriesPerChannel', 0);
  for (let index = 1; index <= 7; index++) {
    const routeKey = `备用模型 ${index}`, modelId = `backup-${index}`;
    f.instance.store.run('INSERT INTO models(id,provider_id,model_id,name,route_key) VALUES(?,?,?,?,?)', modelId, third.id, `${modelId}-upstream`, routeKey, routeKey);
    fallbacks.push({ targetRouteKey: routeKey, targetVariantName: '', effort: 'auto' });
  }
  assert.equal((await f.save([rule({ fallbacks })])).status, 200);
  const chat = await f.chat(), response = await f.request(`/api/chats/${chat.id}/messages`, { method: 'POST', body: { content: '依次完成全部方案' } });
  assert.match(await response.text(), /event: done/); assert.equal(f.calls.length, 8);
  assert.deepEqual(f.calls.map(call => call.model.modelId), [target.upstream, ...Array.from({ length: 7 }, (_, index) => `backup-${index + 1}-upstream`)]);
  assert.equal(f.instance.store.get('SELECT COUNT(*) AS count FROM requests').count, 1);
});
