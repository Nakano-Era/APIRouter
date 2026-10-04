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

const original = '原模型', variant = '高智商版';
const originalId = modelRouteId(original, variant);
const variants = [{ name: variant, modelIds: ['premium', 'disabled'] }, { name: '', modelIds: ['basic'] }];
async function fixture(t, { stream } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-rename-')), calls = [];
  const instance = createApp({ dataDir: directory, logger: { error() {} }, workFactory: () => ({
    registerRoutes() {}, isConfigured: () => true, close() {},
    async *stream(options) { calls.push(options); if (stream) yield* stream(options); else yield { type: 'delta', text: '保留的回答。' }; }
  }) });
  const { store } = instance, sessions = {}, stamp = new Date().toISOString();
  for (const user of ['admin', 'member', 'other', 'paid']) {
    const token = randomBytes(32).toString('base64url'); sessions[user] = token;
    store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', user, user, `${user}@example.com`, 'fixture', user === 'admin' ? 'admin' : 'user', stamp);
    store.run('INSERT INTO sessions(token,user_id,csrf,expires_at) VALUES(?,?,?,?)', digest(token), user, 'test-csrf', new Date(Date.now() + 3_600_000).toISOString());
  }
  for (const id of ['premium', 'basic', 'disabled', 'target', 'spare']) {
    store.run('INSERT INTO providers(id,name,base_url,protocol,runtime,encrypted_key,key_hint,created_at) VALUES(?,?,?,?,?,?,?,?)', id, id, 'https://fixture.invalid', 'anthropic', 'claude-code', store.encrypt('fixture-secret'), 'fixture', stamp);
    store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,enabled) VALUES(?,?,?,?,?,?)', id, id, `${id}-upstream`, id, id === 'target' ? '目标模型' : id, id === 'target' ? 1 : 0);
  }
  const server = createServer(instance.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    instance.abortAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); instance.close();
    const path = realpathSync(directory); assert.ok(path.startsWith(realpathSync(tmpdir()) + sep) && path.includes('apirouter-rename-')); rmSync(path, { recursive: true, force: true });
  });
  async function request(path, { user = 'admin', method = 'GET', body, csrf = true } = {}) {
    return fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: {
      ...(sessions[user] ? { Cookie: `apirouter_session=${sessions[user]}`, ...(csrf ? { 'X-CSRF-Token': 'test-csrf' } : {}) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  const save = body => request('/api/admin/model-groups', { method: 'PUT', body });
  assert.equal((await save({ name: original, variants })).status, 200);
  store.run('UPDATE models SET enabled=0 WHERE id=?', 'disabled');
  const chat = async (user = 'member', modelId = originalId) => {
    const response = await request('/api/chats', { user, method: 'POST', body: { modelId, mode: 'work' } });
    assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).chat;
  };
  return { store, instance, calls, request, save, chat, stamp };
}

test('display rename preserves upstream bindings, independent quotas, historical conversation IDs, silent routing and all plan snapshots', async t => {
  const f = await fixture(t), { store } = f, renamed = '新模型', newId = modelRouteId(renamed, variant);
  assert.equal((await f.request('/api/admin/users/member/model-limits', { method: 'PUT', body: { limits: [
    { routeKey: original, variantName: variant, dailyLimit: 2, monthlyLimit: 3 }, { routeKey: original, variantName: '', dailyLimit: 7, monthlyLimit: 8 }
  ] } })).status, 200);
  for (const [user, source, sourceVariant, target, targetVariant] of [
    ['member', original, variant, '目标模型', ''], ['other', '目标模型', '', original, variant]
  ]) assert.equal((await f.request(`/api/admin/users/${user}/model-routing`, { method: 'PUT', body: { rules: [{ sourceRouteKey: source, sourceVariantName: sourceVariant, targetRouteKey: target, targetVariantName: targetVariant, enabled: true, effort: 'auto' }] } })).status, 200);
  const chat = await f.chat();
  const first = await f.request(`/api/chats/${chat.id}/messages`, { user: 'member', method: 'POST', body: { content: '请回答' } });
  assert.equal(first.status, 200); await first.text(); assert.equal(f.calls[0].model.modelId, 'target-upstream');
  const priorHistory = await (await f.request(`/api/chats/${chat.id}`, { user: 'member' })).json();
  store.setSetting('defaultModelId', originalId);
  const plan = { id: 'plan', name: '会员', dailyLimit: 99, priceCents: 1288, currency: 'USD', interval: 'month', allowedRoutes: [original, '目标模型'] };
  store.run('UPDATE billing_config SET free_routes=? WHERE id=1', JSON.stringify([original]));
  store.run('INSERT INTO billing_plans(id,data,created_at,updated_at) VALUES(?,?,?,?)', plan.id, JSON.stringify(plan), f.stamp, f.stamp);
  store.run('INSERT INTO billing_memberships(user_id,plan_id,plan_snapshot,active_until,source,updated_at) VALUES(?,?,?,?,?,?)', 'paid', plan.id, JSON.stringify(plan), '2099-01-01', 'manual', f.stamp);
  store.run('INSERT INTO billing_requests(id,user_id,plan_id,plan_snapshot,note,created_at) VALUES(?,?,?,?,?,?)', 'pending', 'other', plan.id, JSON.stringify(plan), 'unchanged note', f.stamp);
  store.run('INSERT INTO billing_checkouts(id,user_id,plan_id,plan_snapshot,status,expires_at,created_at,request_origin) VALUES(?,?,?,?,?,?,?,?)', 'checkout', 'paid', plan.id, JSON.stringify(plan), 'open', '2099-01-01', f.stamp, 'https://fixture.invalid');
  const historicalId = modelRouteId(original, '已移除版本');
  store.run('INSERT INTO chats(id,user_id,title,model_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'historical', 'member', '历史版本', historicalId, f.stamp, f.stamp);
  store.run('INSERT INTO requests(id,user_id,model_id,route_key,variant_name,status,created_at) VALUES(?,?,?,?,?,?,?)', 'historical', 'member', historicalId, original, '已移除版本', 'complete', f.stamp);
  const beforeRequests = store.all('SELECT * FROM requests ORDER BY id');
  const beforeAttempts = store.all('SELECT * FROM route_attempts ORDER BY id');
  const replyId = priorHistory.messages.at(-1).id;
  store.db.exec('CREATE TABLE work_checkpoints (assistant_id TEXT PRIMARY KEY, model TEXT, encrypted_state TEXT);');
  store.run('INSERT INTO work_checkpoints VALUES(?,?,?)', replyId, 'target-upstream', store.encrypt('{"model":"target-upstream","files":["result.svg"]}'));
  const checkpoint = store.get('SELECT * FROM work_checkpoints');
  const result = await f.save({ originalName: original, name: renamed, variants });
  assert.equal(result.status, 200, await result.clone().text());
  assert.ok(!(await result.json()).groups.some(group => group.name === original));
  assert.equal(store.get('SELECT enabled FROM models WHERE id=?', 'disabled').enabled, 0);
  for (const id of ['premium', 'basic', 'disabled']) {
    const model = store.get('SELECT * FROM models WHERE id=?', id);
    assert.equal(model.route_key, renamed); assert.equal(model.model_id, `${id}-upstream`);
  }
  const limits = (await (await f.request('/api/admin/users/member/model-limits')).json()).limits;
  assert.deepEqual(limits.map(row => [row.routeKey, row.variantName, row.dailyLimit, row.monthlyLimit, row.usedToday]).sort(), [[renamed, '', 7, 8, 0], [renamed, variant, 2, 3, 1]].sort());
  assert.equal(store.get('SELECT source_route_key FROM user_model_routing WHERE user_id=?', 'member').source_route_key, renamed);
  assert.equal(store.get('SELECT target_route_key FROM user_model_routing WHERE user_id=?', 'other').target_route_key, renamed);
  const history = await (await f.request(`/api/chats/${chat.id}`, { user: 'member' })).json();
  assert.equal(history.chat.modelId, newId); assert.ok(history.messages.every(row => row.modelId === newId));
  assert.deepEqual(history.messages.map(row => row.content), priorHistory.messages.map(row => row.content));
  assert.equal(store.get('SELECT model_id FROM chats WHERE id=?', 'historical').model_id, modelRouteId(renamed, '已移除版本'));
  assert.equal(store.settings().defaultModelId, newId);
  for (const before of beforeRequests) {
    const after = store.get('SELECT * FROM requests WHERE id=?', before.id);
    assert.deepEqual({ ...after }, { ...before, route_key: renamed, model_id: modelRouteId(renamed, before.variant_name) });
  }
  assert.deepEqual(store.all('SELECT * FROM route_attempts ORDER BY id'), beforeAttempts);
  assert.deepEqual(store.get('SELECT * FROM work_checkpoints'), checkpoint);
  for (const [table, column] of [['billing_plans', 'data'], ['billing_memberships', 'plan_snapshot'], ['billing_requests', 'plan_snapshot'], ['billing_checkouts', 'plan_snapshot']]) {
    assert.deepEqual(JSON.parse(store.get(`SELECT ${column} AS value FROM ${table}`).value), { ...plan, allowedRoutes: [renamed, '目标模型'] });
  }
  assert.deepEqual(JSON.parse(store.get('SELECT free_routes FROM billing_config').free_routes), [renamed]);
  const publicModels = await (await f.request('/api/models', { user: 'member' })).json();
  assert.equal(publicModels.modelAliases[originalId], newId); assert.equal(publicModels.defaultModelId, newId);
  assert.ok(publicModels.models.every(row => row.routeKey === renamed));
  assert.ok((await (await f.request('/api/models', { user: 'paid' })).json()).models.some(row => row.id === newId));
  const continued = await f.request(`/api/chats/${chat.id}/continue`, { user: 'member', method: 'POST', body: { modelId: originalId } });
  assert.equal(continued.status, 200, await continued.clone().text()); await continued.text();
  assert.equal(f.calls[1].model.modelId, 'target-upstream');
  const denied = await f.request(`/api/chats/${chat.id}/regenerate`, { user: 'member', method: 'POST', body: { modelId: originalId } });
  assert.equal(denied.status, 429); assert.equal((await denied.json()).code, 'USER_MODEL_DAILY_LIMIT');
});

test('rename validation, conflicts and database failure leave the original model and aliases unchanged', async t => {
  const f = await fixture(t), before = f.store.all('SELECT * FROM models ORDER BY id');
  for (const [body, status] of [
    [{ originalName: 'missing', name: '新模型', variants }, 404], [{ originalName: null, name: '新模型', variants }, 400],
    [{ originalName: original, name: '目标模型', variants }, 409], [{ originalName: original, name: 'spare', variants }, 409],
    [{ originalName: original, name: 'bad\nname', variants }, 400], [{ originalName: original, name: '新模型', variants: [{ name: '', modelIds: ['missing'] }] }, 404]
  ]) { const result = await f.save(body); assert.equal(result.status, status, await result.text()); assert.deepEqual(f.store.all('SELECT * FROM models ORDER BY id'), before); }
  const rename = { originalName: original, name: '新模型', variants };
  for (const [options, status] of [[{ user: '' }, 401], [{ user: 'member' }, 403], [{ csrf: false }, 403]]) {
    assert.equal((await f.request('/api/admin/model-groups', { method: 'PUT', body: rename, ...options })).status, status);
  }
  f.store.db.exec("CREATE TRIGGER fail_rename BEFORE INSERT ON model_versions WHEN NEW.route_key='新模型' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
  assert.equal((await f.save(rename)).status, 500);
  assert.deepEqual(f.store.all('SELECT * FROM models ORDER BY id'), before);
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM model_route_aliases').count, 0);
  assert.equal(f.store.get('SELECT name FROM model_catalog WHERE name=?', '新模型'), undefined);
  f.store.db.exec('DROP TRIGGER fail_rename');
  assert.equal((await f.save(rename)).status, 200);
});

test('multiple renames flatten aliases and reusing an old display name never redirects its new live model', async t => {
  const f = await fixture(t), middle = '中间名称', final = '最终名称';
  for (const [from, to] of [[original, middle], [middle, final]]) assert.equal((await f.save({ originalName: from, name: to, variants })).status, 200);
  let models = await (await f.request('/api/models')).json();
  const finalId = modelRouteId(final, variant);
  assert.equal(models.modelAliases[originalId], finalId); assert.equal(models.modelAliases[modelRouteId(middle, variant)], finalId);
  assert.equal((await f.save({ originalName: final, name: original, variants })).status, 200);
  models = await (await f.request('/api/models')).json();
  assert.equal(models.modelAliases[originalId], undefined); assert.equal(models.modelAliases[finalId], originalId);
  assert.equal((await f.save({ originalName: original, name: final, variants })).status, 200);
  const staleChat = await f.chat('member', originalId);
  assert.equal(staleChat.modelId, finalId, 'old pages create conversations with the canonical identity');
  assert.equal((await f.save({ name: original, variants: [{ name: variant, modelIds: ['spare'] }] })).status, 200);
  f.store.setSetting('defaultModelId', originalId);
  models = await (await f.request('/api/models')).json();
  assert.equal(models.modelAliases[originalId], undefined); assert.equal(models.defaultModelId, originalId);
  const chat = await f.chat('member', originalId);
  const response = await f.request(`/api/chats/${chat.id}/messages`, { user: 'member', method: 'POST', body: { content: '用新建模型' } });
  assert.equal(response.status, 200); await response.text(); assert.equal(f.calls.at(-1).model.modelId, 'spare-upstream');
  assert.equal(f.store.get('SELECT route_key FROM requests WHERE user_id=?', 'member').route_key, original);
  f.store.run('UPDATE models SET enabled=0 WHERE id=?', 'spare');
  models = await (await f.request('/api/models')).json();
  assert.equal(models.modelAliases[originalId], undefined, 'disabled replacement model owns its identity and cannot alias to another model');
  const unavailable = await f.request(`/api/chats/${chat.id}/messages`, { user: 'member', method: 'POST', body: { content: '不能跨模型' } });
  assert.equal(unavailable.status, 400); assert.equal(f.calls.length, 1);
  assert.equal(f.store.get('SELECT model_id FROM chats WHERE id=?', staleChat.id).model_id, finalId);
});

test('rename refuses an active silent-routed source or execution target before mutating catalog', async t => {
  const entered = Promise.withResolvers();
  const f = await fixture(t, { async *stream(options) {
    entered.resolve(); yield { type: 'delta', text: '处理中' };
    await new Promise(resolve => options.signal.aborted ? resolve() : options.signal.addEventListener('abort', resolve, { once: true }));
  } });
  assert.equal((await f.request('/api/admin/users/member/model-routing', { method: 'PUT', body: { rules: [{ sourceRouteKey: original, sourceVariantName: variant, targetRouteKey: '目标模型', targetVariantName: '' }] } })).status, 200);
  const chat = await f.chat(), response = await f.request(`/api/chats/${chat.id}/messages`, { user: 'member', method: 'POST', body: { content: '慢任务' } });
  await entered.promise;
  for (const body of [{ originalName: original, name: '运行中源模型', variants }, { originalName: '目标模型', name: '运行中目标模型', variants: [{ name: '', modelIds: ['target'] }] }]) {
    const rename = await f.save(body); assert.equal(rename.status, 409); assert.match((await rename.json()).error, /进行中的任务|正在处理请求/);
  }
  assert.equal(f.store.get('SELECT COUNT(*) AS count FROM model_route_aliases').count, 0);
  f.instance.abortAll(); await response.text();
});
