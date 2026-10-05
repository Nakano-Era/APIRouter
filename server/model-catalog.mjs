import { digest, now } from './store.mjs';
import { createModelRename } from './model-rename.mjs';

export const modelRouteId = (name, variant = '') => `${variant ? 'v' : 'r'}_${digest(variant ? JSON.stringify([name, variant]) : name).slice(0, 32)}`;
export function variantName(value = '') {
  if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw Object.assign(new Error('版本名称最多 100 个字符，不能包含控制字符。'), { status: 400 });
  return value.trim();
}
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function createModelCatalog({ store, ensureProviderIdle, ensureRenameIdle = () => {} }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS model_catalog (name TEXT PRIMARY KEY,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS model_versions (route_key TEXT NOT NULL REFERENCES model_catalog(name) ON DELETE CASCADE,name TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(route_key,name));`);
  const rename = createModelRename({ store, routeId: modelRouteId });
  // Backfill request labels once for known legacy model IDs. These snapshots
  // remain intact after a channel is renamed, reassigned, disabled or deleted.
  store.transaction(() => {
    for (const row of store.all('SELECT id,route_key,variant_name FROM models')) {
      store.run('UPDATE requests SET route_key=?,variant_name=? WHERE route_key IS NULL AND model_id IN (?,?)', row.route_key, row.variant_name, row.id, modelRouteId(row.route_key, row.variant_name));
    }
  });
  function listGroups() {
    const groups = new Map(store.all('SELECT name FROM model_catalog ORDER BY created_at,name').map(row => [row.name, { name: row.name, variants: [] }]));
    const get = name => { if (!groups.has(name)) groups.set(name, { name, variants: [] }); return groups.get(name); };
    for (const version of store.all('SELECT * FROM model_versions ORDER BY position,name')) get(version.route_key).variants.push({ name: version.name, modelIds: [] });
    for (const row of store.all('SELECT id,route_key,variant_name FROM models WHERE enabled=1 OR catalog_assigned=1 ORDER BY name,id')) {
      const group = get(row.route_key);
      let version = group.variants.find(item => item.name === row.variant_name);
      if (!version) { version = { name: row.variant_name, modelIds: [] }; group.variants.push(version); }
      version.modelIds.push(row.id);
    }
    return [...groups.values()];
  }
  function saveGroup(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 300 || /[\u0000-\u001f\u007f]/.test(name)) throw bad('请输入有效的模型名称（最多 300 个字符）。');
    const originalName = body.originalName === undefined ? name : typeof body.originalName === 'string' ? body.originalName.trim() : '';
    if (!originalName || originalName.length > 300 || /[\u0000-\u001f\u007f]/.test(originalName)) throw bad('原模型名称无效，请刷新模型列表后重试。');
    if (body.originalName !== undefined && !listGroups().some(group => group.name === originalName)) throw bad('原模型已不存在或已改名，请刷新后重试。', 404);
    const renaming = originalName !== name;
    if (renaming) rename.assertUnused(name);
    if (!Array.isArray(body.variants) || body.variants.length > 100) throw bad('每个模型最多设置 100 个版本。');
    const names = new Set(), ids = new Set();
    const variants = body.variants.map(item => {
      const name = variantName(item?.name);
      if (item.retries !== undefined && item.retries !== null && (!Number.isInteger(item.retries) || item.retries < 0 || item.retries > 100)) throw bad('模型额外重试次数需要为 0–100，或留空继承。');
      if (names.has(name)) throw bad('同一模型的版本名称不能重复。');
      names.add(name);
      if (!Array.isArray(item.modelIds) || item.modelIds.length > 500) throw bad('每个版本最多绑定 500 个渠道模型。');
      const models = item.modelIds.map(id => {
        if (typeof id !== 'string' || ids.has(id)) throw bad('同一个渠道模型只能绑定一个版本。');
        ids.add(id);
        const model = store.get('SELECT * FROM models WHERE id=?', id);
        if (!model) throw bad('选择的渠道模型已不存在，请刷新后重试。', 404);
        return model;
      });
      return { name, models, retries: item.retries };
    });
    const prior = store.all('SELECT * FROM models WHERE route_key=? AND (enabled=1 OR catalog_assigned=1)', originalName);
    if (renaming) {
      ensureRenameIdle(originalName);
      for (const row of store.all('SELECT DISTINCT provider_id FROM models WHERE route_key=?', originalName)) ensureProviderIdle(row.provider_id);
    }
    for (const providerId of new Set([...prior, ...variants.flatMap(item => item.models)].map(row => row.provider_id))) ensureProviderIdle(providerId);
    store.transaction(() => {
      if (renaming) { rename.assertUnused(name); rename.apply(originalName, name); }
      store.run('INSERT OR IGNORE INTO model_catalog(name,created_at) VALUES (?,?)', name, now());
      store.run('DELETE FROM model_versions WHERE route_key=?', name);
      for (const row of prior) if (!ids.has(row.id)) store.run("UPDATE models SET enabled=0,catalog_assigned=0,route_key=model_id,variant_name='' WHERE id=?", row.id);
      variants.forEach((version, index) => {
        store.run('INSERT INTO model_versions(route_key,name,position) VALUES (?,?,?)', name, version.name, index);
        for (const model of version.models) {
          const enabled = renaming && model.route_key === originalName && model.variant_name === version.name && model.catalog_assigned ? model.enabled : 1;
          store.run('UPDATE models SET route_key=?,variant_name=?,catalog_assigned=1,enabled=? WHERE id=?', name, version.name, enabled, model.id);
          if (version.retries !== undefined) store.run('UPDATE models SET retries_override=? WHERE id=?', version.retries, model.id);
        }
      });
    });
    return { groups: listGroups() };
  }
  function deleteGroup(name) {
    const group = listGroups().find(item => item.name === name);
    if (!group) throw bad('模型已不存在，请刷新列表。', 404);
    ensureRenameIdle(name);
    const rows = store.all('SELECT id,provider_id FROM models WHERE route_key=?', name);
    for (const providerId of new Set(rows.map(row => row.provider_id))) ensureProviderIdle(providerId);
    store.transaction(() => {
      const defaultId = store.settings().defaultModelId;
      const ids = new Set([...rows.map(row => row.id), modelRouteId(name), ...group.variants.map(version => modelRouteId(name, version.name)), ...store.all('SELECT id FROM model_route_aliases WHERE route_key=?', name).map(row => row.id)]);
      if (ids.has(defaultId)) store.setSetting('defaultModelId', null);
      store.run("UPDATE models SET enabled=0,catalog_assigned=0,route_key=model_id,variant_name='' WHERE route_key=?", name);
      store.run('DELETE FROM model_route_aliases WHERE route_key=?', name);
      store.run('DELETE FROM model_catalog WHERE name=?', name);
    });
    return { ok: true, groups: listGroups() };
  }
  function registerRoutes(app, { auth, admin, csrf }) {
    app.get('/api/admin/model-groups', auth, admin, (_req, res) => res.json({ groups: listGroups() }));
    app.put('/api/admin/model-groups', auth, admin, csrf, (req, res) => res.json(saveGroup(req.body)));
    app.delete('/api/admin/model-groups/:name', auth, admin, csrf, (req, res) => res.json(deleteGroup(req.params.name)));
  }
  return { listGroups, saveGroup, deleteGroup, registerRoutes, resolveRouteId: rename.resolve, routeAliases: rename.aliases };
}
