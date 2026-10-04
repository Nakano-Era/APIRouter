import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createStore } from '../server/store.mjs';
import { createUserModelRouting } from '../server/user-model-routing.mjs';
import { createModelCatalog, modelRouteId } from '../server/model-catalog.mjs';

const rule = overrides => ({ sourceRouteKey: 'source', sourceVariantName: '', targetRouteKey: 'target', targetVariantName: '', effort: 'auto', enabled: true, ...overrides });
const step = (targetRouteKey, targetVariantName = '', effort = 'auto') => ({ targetRouteKey, targetVariantName, effort });

function fixture(t, { legacy = false, ensureUserIdle = () => {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-routing-config-'));
  const store = createStore(directory);
  t.after(() => {
    store.close(); const path = realpathSync(directory);
    assert.ok(path.startsWith(realpathSync(tmpdir()) + sep) && path.includes('apirouter-routing-config-'));
    rmSync(path, { recursive: true, force: true });
  });
  const stamp = new Date().toISOString();
  store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', 'member', 'Member', 'member@example.com', 'unused', 'user', stamp);
  store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,created_at) VALUES(?,?,?,?,?,?,?)', 'provider', 'Provider', 'https://example.com', 'openai-chat', store.encrypt('fixture'), 'fixture', stamp);
  for (const name of ['source', 'target', 'backup']) store.run('INSERT INTO models(id,provider_id,model_id,name,route_key,variant_name,reasoning_efforts,catalog_assigned) VALUES(?,?,?,?,?,?,?,1)', name, 'provider', name, name, name, '', '["low","high"]');
  if (legacy) {
    store.db.exec('CREATE TABLE user_model_routing (user_id TEXT NOT NULL,source_route_key TEXT NOT NULL,source_variant_name TEXT NOT NULL,target_route_key TEXT NOT NULL,target_variant_name TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,effort TEXT NOT NULL DEFAULT \'auto\',updated_at TEXT NOT NULL,PRIMARY KEY(user_id,source_route_key,source_variant_name));');
    store.run('INSERT INTO user_model_routing VALUES(?,?,?,?,?,?,?,?)', 'member', 'source', '', 'target', '', 1, 'low', stamp);
  }
  const catalog = createModelCatalog({ store, ensureProviderIdle() {} });
  const routing = createUserModelRouting({ store, ensureUserIdle });
  return { store, catalog, routing };
}

test('legacy routing rows migrate to an empty ordered backup list without changing the primary', t => {
  const { store, routing } = fixture(t, { legacy: true });
  assert.deepEqual(routing.resolve('member', 'source'), rule({ effort: 'low', fallbacks: [] }));
  assert.equal(store.get('SELECT fallbacks_json FROM user_model_routing').fallbacks_json, '[]');
  createUserModelRouting({ store, ensureUserIdle() {} });
  assert.deepEqual(routing.replaceRules('member', [rule()]), { rules: [rule({ fallbacks: [] })] });
});

test('ordered backups can return to the selected source and retry a target at different reasoning strength', t => {
  const { routing } = fixture(t);
  const fallbacks = [step('backup'), step('target', '', 'high'), step('source', '', 'low')];
  const result = routing.replaceRules('member', [rule({ fallbacks }), rule({ sourceRouteKey: 'target', targetRouteKey: 'backup' })]);
  assert.deepEqual(result.rules.find(row => row.sourceRouteKey === 'source').fallbacks, fallbacks);
  assert.deepEqual(routing.resolve('member', 'source').fallbacks, fallbacks, 'resolution returns explicit steps and never expands target rules');
});

test('backup validation is atomic, includes availability and effort, and permits disabled stale configurations', t => {
  const { routing, store } = fixture(t);
  const before = routing.replaceRules('member', [rule({ fallbacks: [step('backup')] })]);
  for (const fallbacks of [null, {}, [null], [[]], [step('')], [step('bad\nname')], [step('backup', 'x'.repeat(101))], [step('backup', '', 'ultra')], [step('missing')], [step('backup', '', 'max')], [step('target')], [step('backup'), step('backup')]]) {
    assert.throws(() => routing.replaceRules('member', [rule({ fallbacks })]), error => error.status === 400);
    assert.deepEqual(routing.listRules('member'), before);
  }
  for (const [table, id] of [['models', 'backup'], ['providers', 'provider']]) {
    store.run(`UPDATE ${table} SET enabled=0 WHERE id=?`, id);
    assert.throws(() => routing.replaceRules('member', [rule({ fallbacks: [step('backup')] })]), error => error.status === 400);
    assert.deepEqual(routing.listRules('member'), before);
    store.run(`UPDATE ${table} SET enabled=1 WHERE id=?`, id);
  }
  const disabled = rule({ enabled: false, fallbacks: [step('missing'), step('backup', '', 'max')] });
  assert.deepEqual(routing.replaceRules('member', [disabled]), { rules: [disabled] });
  assert.equal(routing.resolve('member', 'source'), null);
});

test('backups have no fixed 100-item ceiling and preserve their full order', t => {
  const { routing, store } = fixture(t);
  const fallbacks = Array.from({ length: 125 }, (_, index) => step(`backup-${index}`));
  for (const backup of fallbacks) store.run('INSERT INTO models(id,provider_id,model_id,name,route_key) VALUES(?,?,?,?,?)', backup.targetRouteKey, 'provider', backup.targetRouteKey, backup.targetRouteKey, backup.targetRouteKey);
  const result = routing.replaceRules('member', [rule({ fallbacks })]);
  assert.deepEqual(result.rules[0].fallbacks, fallbacks);
  assert.deepEqual(routing.resolve('member', 'source').fallbacks, fallbacks);
});

test('editing backups while a user is active leaves the previous list untouched', t => {
  let busy = false;
  const { routing } = fixture(t, { ensureUserIdle() { if (busy) throw Object.assign(new Error('busy'), { status: 409 }); } });
  const before = routing.replaceRules('member', [rule()]); busy = true;
  assert.throws(() => routing.replaceRules('member', [rule({ fallbacks: [step('backup')] })]), error => error.status === 409);
  assert.deepEqual(routing.listRules('member'), before);
});

test('model rename migrates fallback-only references, removed-version aliases and administrator overrides atomically', t => {
  const { routing, catalog, store } = fixture(t);
  catalog.saveGroup({ name: 'backup', variants: [{ name: '', modelIds: ['backup'] }] });
  const fallbacks = [step('backup', 'retired', 'high'), step('source', '', 'low')];
  routing.replaceRules('member', [rule({ enabled: false, fallbacks })]);
  store.db.exec('CREATE TABLE billing_entitlement_overrides(user_id TEXT PRIMARY KEY,plan_snapshot TEXT NOT NULL);');
  store.run('INSERT INTO billing_entitlement_overrides VALUES(?,?)', 'member', JSON.stringify({ allowedRoutes: ['backup'], dailyLimit: 99 }));
  const oldId = modelRouteId('backup', 'retired');
  store.run('INSERT INTO chats(id,user_id,title,model_id,created_at,updated_at) VALUES(?,?,?,?,?,?)', 'chat', 'member', 'Old version', oldId, '2026-10-04', '2026-10-04');
  catalog.saveGroup({ originalName: 'backup', name: 'renamed', variants: [{ name: '', modelIds: ['backup'] }] });
  assert.deepEqual(routing.listRules('member').rules[0].fallbacks, [step('renamed', 'retired', 'high'), step('source', '', 'low')]);
  assert.equal(store.get('SELECT model_id FROM chats WHERE id=?', 'chat').model_id, modelRouteId('renamed', 'retired'));
  assert.equal(catalog.resolveRouteId(oldId), modelRouteId('renamed', 'retired'));
  assert.deepEqual(JSON.parse(store.get('SELECT plan_snapshot FROM billing_entitlement_overrides').plan_snapshot), { allowedRoutes: ['renamed'], dailyLimit: 99 });
  // Renaming a rule source and its fallback-to-source must not lose the JSON
  // update when the composite primary key changes during the same transaction.
  catalog.saveGroup({ originalName: 'source', name: 'source-renamed', variants: [{ name: '', modelIds: ['source'] }] });
  assert.equal(routing.listRules('member').rules[0].sourceRouteKey, 'source-renamed');
  assert.deepEqual(routing.listRules('member').rules[0].fallbacks[1], step('source-renamed', '', 'low'));
});

test('model rename cannot claim a name referenced only by an inactive backup', t => {
  const { routing, catalog, store } = fixture(t);
  routing.replaceRules('member', [rule({ enabled: false, fallbacks: [step('reserved-name')] })]);
  assert.throws(() => catalog.saveGroup({ originalName: 'backup', name: 'reserved-name', variants: [{ name: '', modelIds: ['backup'] }] }), error => error.status === 409);
  assert.equal(store.get('SELECT route_key FROM models WHERE id=?', 'backup').route_key, 'backup');
  assert.deepEqual(routing.listRules('member').rules[0].fallbacks, [step('reserved-name')]);
});
