import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { createStore } from '../server/store.mjs';
import { createModelCatalog, modelRouteId, variantName } from '../server/model-catalog.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-model-catalog-')), store = createStore(directory), touched = [];
  t.after(() => { store.close(); const target = realpathSync(directory); assert.ok(target.startsWith(realpathSync(tmpdir()) + sep) && target.includes('apirouter-model-catalog-')); rmSync(target, { recursive: true, force: true }); });
  for (const name of ['anyrouter', 'aihub', 'kuaipao']) {
    store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,created_at) VALUES (?,?,?,?,?,?,?)', name, name, 'https://example.com/v1', 'openai-responses', store.encrypt('sk-local-fixture'), 'fixture', '2026-10-01');
    store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,enabled,available) VALUES (?,?,?,?,?,?,?)', `${name}-gpt`, name, 'gpt-6-astra', 'gpt-6-astra', 'gpt-6-astra', 0, 1);
  }
  const catalog = createModelCatalog({ store, ensureProviderIdle: id => touched.push(id) });
  const group = { name: 'ChatGPT 6 Astra', variants: [{ name: '高智商版', modelIds: ['anyrouter-gpt'] }, { name: '普通版', modelIds: ['aihub-gpt'] }, { name: '降智版', modelIds: ['kuaipao-gpt'] }] };
  return { store, catalog, touched, group };
}

test('catalog creates named model versions in order and binds only explicitly selected channel models', t => {
  const { store, catalog, touched, group } = fixture(t);
  assert.deepEqual(catalog.listGroups(), []);
  const result = catalog.saveGroup(group);
  assert.deepEqual(result.groups, [group]);
  assert.deepEqual(new Set(touched), new Set(['anyrouter', 'aihub', 'kuaipao']));
  for (const variant of group.variants) {
    const row = store.get('SELECT * FROM models WHERE id=?', variant.modelIds[0]);
    assert.equal(row.route_key, group.name); assert.equal(row.variant_name, variant.name);
    assert.equal(row.catalog_assigned, 1); assert.equal(row.enabled, 1); assert.equal(row.model_id, 'gpt-6-astra');
  }
  assert.equal(new Set(group.variants.map(variant => modelRouteId(group.name, variant.name))).size, 3);
  assert.notEqual(modelRouteId(group.name), modelRouteId(group.name, '普通版'));
});

test('catalog reassigns versions atomically, disables removed bindings and keeps an explicitly empty version', t => {
  const { store, catalog, group } = fixture(t); catalog.saveGroup(group);
  const updated = { name: group.name, variants: [{ name: '普通版', modelIds: ['aihub-gpt', 'anyrouter-gpt'] }, { name: '待配置', modelIds: [] }] };
  catalog.saveGroup(updated);
  assert.deepEqual(catalog.listGroups(), [updated]);
  const removed = store.get('SELECT * FROM models WHERE id=?', 'kuaipao-gpt');
  assert.equal(removed.enabled, 0); assert.equal(removed.catalog_assigned, 0); assert.equal(removed.route_key, removed.model_id); assert.equal(removed.variant_name, '');
  const reassigned = { name: '另一个展示模型', variants: [{ name: '', modelIds: ['aihub-gpt'] }] };
  catalog.saveGroup(reassigned);
  assert.deepEqual(catalog.listGroups().find(item => item.name === group.name).variants[0].modelIds, ['anyrouter-gpt']);
  assert.deepEqual(catalog.listGroups().find(item => item.name === reassigned.name), reassigned);
});

test('invalid catalog edits never partially mutate a saved group', t => {
  const { catalog, group } = fixture(t); catalog.saveGroup(group);
  for (const body of [
    { name: '', variants: [] }, { name: 'bad\nname', variants: [] }, { name: group.name, variants: [{ name: '重复', modelIds: [] }, { name: ' 重复 ', modelIds: [] }] },
    { name: group.name, variants: [{ name: '同一模型重复', modelIds: ['anyrouter-gpt', 'anyrouter-gpt'] }] },
    { name: group.name, variants: [{ name: '不跨分组重复', modelIds: ['anyrouter-gpt'] }, { name: '第二个', modelIds: ['anyrouter-gpt'] }] },
    { name: group.name, variants: [{ name: '删除的模型', modelIds: ['missing-model'] }] },
    { name: group.name, variants: [{ name: 'bad\0name', modelIds: [] }] },
  ]) { assert.throws(() => catalog.saveGroup(body)); assert.deepEqual(catalog.listGroups(), [group]); }
  assert.throws(() => variantName(null)); assert.throws(() => variantName('x'.repeat(101))); assert.equal(variantName(' 普通版 '), '普通版');
});

test('catalog refuses edits involving active providers before changing assignments', t => {
  const { store, catalog, group } = fixture(t); catalog.saveGroup(group);
  const locked = createModelCatalog({ store, ensureProviderIdle: id => { if (id === 'aihub') throw Object.assign(new Error('任务正在使用该渠道'), { status: 409 }); } });
  assert.throws(() => locked.saveGroup({ name: group.name, variants: [] }), error => error.status === 409);
  assert.deepEqual(catalog.listGroups(), [group]);
});

test('request route snapshots survive later model reassignments and repeated catalog initialization', t => {
  const { store, catalog, group } = fixture(t);
  store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', 'owner', 'owner', 'catalog@example.com', 'fixture', 'user', '2026-10-01');
  for (const [id, modelId] of [['channel-request', 'anyrouter-gpt'], ['route-request', modelRouteId('gpt-6-astra')]]) store.run('INSERT INTO requests(id,user_id,model_id,status,created_at) VALUES (?,?,?,?,?)', id, 'owner', modelId, 'complete', '2026-10-01');
  createModelCatalog({ store, ensureProviderIdle() {} });
  catalog.saveGroup(group);
  createModelCatalog({ store, ensureProviderIdle() {} });
  const rows = store.all('SELECT route_key,variant_name FROM requests');
  assert.equal(rows.length, 2); assert.ok(rows.every(row => row.route_key === 'gpt-6-astra' && row.variant_name === ''));
});

test('model catalog HTTP routes require administrator access and CSRF for mutation', async t => {
  const { catalog, group } = fixture(t), app = express(); app.use(express.json());
  const auth = (req, res, next) => req.get('x-user') ? next() : res.sendStatus(401);
  const admin = (req, res, next) => req.get('x-user') === 'admin' ? next() : res.sendStatus(403);
  const csrf = (req, res, next) => req.get('x-csrf-token') === 'fixture-token' ? next() : res.sendStatus(403);
  catalog.registerRoutes(app, { auth, admin, csrf });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/api/admin/model-groups`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { 'x-user': 'user' } })).status, 403);
  const body = JSON.stringify(group);
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'x-user': 'admin', 'content-type': 'application/json' }, body })).status, 403);
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'x-user': 'admin', 'content-type': 'application/json', 'x-csrf-token': 'fixture-token' }, body })).status, 200);
  assert.deepEqual(await (await fetch(url, { headers: { 'x-user': 'admin' } })).json(), { groups: [group] });
  const deletion = `${url}/${encodeURIComponent(group.name)}`;
  assert.equal((await fetch(deletion, { method: 'DELETE' })).status, 401);
  assert.equal((await fetch(deletion, { method: 'DELETE', headers: { 'x-user': 'user' } })).status, 403);
  assert.equal((await fetch(deletion, { method: 'DELETE', headers: { 'x-user': 'admin' } })).status, 403);
  assert.equal((await fetch(deletion, { method: 'DELETE', headers: { 'x-user': 'admin', 'x-csrf-token': 'fixture-token' } })).status, 200);
  assert.deepEqual(catalog.listGroups(), []);
});

test('deleting a displayed model removes all versions and default selection but retains disabled upstream records', t => {
  const { store, catalog, group } = fixture(t); catalog.saveGroup(group);
  store.setSetting('defaultModelId', modelRouteId(group.name, group.variants[0].name));
  catalog.deleteGroup(group.name);
  assert.deepEqual(catalog.listGroups(), []);
  assert.equal(store.get('SELECT COUNT(*) n FROM model_versions').n, 0);
  assert.equal(store.settings().defaultModelId, null);
  const rows = store.all('SELECT * FROM models'); assert.equal(rows.length, 3);
  assert.ok(rows.every(row => row.enabled === 0 && row.catalog_assigned === 0 && row.route_key === row.model_id && row.variant_name === ''));
  assert.throws(() => catalog.deleteGroup(group.name), error => error.status === 404);
});

test('catalog version retries update bound channels, preserve omitted settings and accept inheritance explicitly', t => {
  const { store, catalog, group } = fixture(t);
  catalog.saveGroup({ ...group, variants: group.variants.map((variant, index) => ({ ...variant, retries: index === 0 ? 100 : 0 })) });
  assert.equal(store.get('SELECT retries_override FROM models WHERE id=?', 'anyrouter-gpt').retries_override, 100);
  catalog.saveGroup(group);
  assert.equal(store.get('SELECT retries_override FROM models WHERE id=?', 'anyrouter-gpt').retries_override, 100);
  catalog.saveGroup({ ...group, variants: group.variants.map(variant => ({ ...variant, retries: null })) });
  assert.ok(store.all('SELECT retries_override FROM models').every(row => row.retries_override === null));
  assert.throws(() => catalog.saveGroup({ ...group, variants: [{ ...group.variants[0], retries: 101 }] }), error => error.status === 400);
  const locked = createModelCatalog({ store, ensureProviderIdle() { throw Object.assign(new Error('busy'), { status: 409 }); } });
  assert.throws(() => locked.deleteGroup(group.name), error => error.status === 409);
  assert.deepEqual(catalog.listGroups(), [group]);
});
