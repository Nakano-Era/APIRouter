import { digest, now } from './store.mjs';

export const modelRouteId = (name, variant = '') => `${variant ? 'v' : 'r'}_${digest(variant ? JSON.stringify([name, variant]) : name).slice(0, 32)}`;
export function variantName(value = '') {
  if (typeof value !== 'string' || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw Object.assign(new Error('版本名称最多 100 个字符，不能包含控制字符。'), { status: 400 });
  return value.trim();
}
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function createModelCatalog({ store, ensureProviderIdle }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS model_catalog (name TEXT PRIMARY KEY,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS model_versions (route_key TEXT NOT NULL REFERENCES model_catalog(name) ON DELETE CASCADE,name TEXT NOT NULL,position INTEGER NOT NULL,PRIMARY KEY(route_key,name));`);
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
    if (!Array.isArray(body.variants) || body.variants.length > 100) throw bad('每个模型最多设置 100 个版本。');
    const names = new Set(), ids = new Set();
    const variants = body.variants.map(item => {
      const name = variantName(item?.name);
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
      return { name, models };
    });
    const prior = store.all('SELECT * FROM models WHERE route_key=? AND (enabled=1 OR catalog_assigned=1)', name);
    for (const providerId of new Set([...prior, ...variants.flatMap(item => item.models)].map(row => row.provider_id))) ensureProviderIdle(providerId);
    store.transaction(() => {
      store.run('INSERT OR IGNORE INTO model_catalog(name,created_at) VALUES (?,?)', name, now());
      store.run('DELETE FROM model_versions WHERE route_key=?', name);
      for (const row of prior) if (!ids.has(row.id)) store.run("UPDATE models SET enabled=0,catalog_assigned=0,route_key=model_id,variant_name='' WHERE id=?", row.id);
      variants.forEach((version, index) => {
        store.run('INSERT INTO model_versions(route_key,name,position) VALUES (?,?,?)', name, version.name, index);
        for (const model of version.models) store.run('UPDATE models SET route_key=?,variant_name=?,catalog_assigned=1,enabled=1 WHERE id=?', name, version.name, model.id);
      });
    });
    return { groups: listGroups() };
  }
  function registerRoutes(app, { auth, admin, csrf }) {
    app.get('/api/admin/model-groups', auth, admin, (_req, res) => res.json({ groups: listGroups() }));
    app.put('/api/admin/model-groups', auth, admin, csrf, (req, res) => res.json(saveGroup(req.body)));
  }
  return { listGroups, saveGroup, registerRoutes };
}
