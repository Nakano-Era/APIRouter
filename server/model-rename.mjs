// A display-model rename changes public routing identities, not upstream model
// IDs. The caller must execute these changes in its catalog transaction.
export function createModelRename({ store, routeId }) {
  store.db.exec('CREATE TABLE IF NOT EXISTS model_route_aliases (id TEXT PRIMARY KEY,route_key TEXT NOT NULL,variant_name TEXT NOT NULL);');
  const exists = table => !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);
  const snapshots = [
    ['billing_plans', 'id', 'data'], ['billing_memberships', 'user_id', 'plan_snapshot'],
    ['billing_requests', 'id', 'plan_snapshot'], ['billing_checkouts', 'id', 'plan_snapshot']
  ];
  const references = [
    ['models', 'route_key'], ['model_catalog', 'name'], ['model_versions', 'route_key'],
    ['user_model_limits', 'route_key'], ['user_model_routing', 'source_route_key'], ['user_model_routing', 'target_route_key'],
    ['requests', 'route_key'], ['requests', 'execution_route_key'], ['model_route_aliases', 'route_key']
  ];
  function assertUnused(name) {
    const conflict = () => { throw Object.assign(new Error('此模型名称已被使用，请选择其他名称。'), { status: 409 }); };
    for (const [table, column] of references) if (exists(table) && store.get(`SELECT 1 FROM ${table} WHERE ${column}=? LIMIT 1`, name)) conflict();
    if (exists('billing_config')) for (const row of store.all('SELECT free_routes FROM billing_config')) if (JSON.parse(row.free_routes).includes(name)) conflict();
    for (const [table, , column] of snapshots) if (exists(table)) for (const row of store.all(`SELECT ${column} FROM ${table}`)) if (JSON.parse(row[column]).allowedRoutes?.includes(name)) conflict();
  }
  function apply(original, name) {
    const variants = new Set(['']);
    for (const [table, key, variant] of [
      ['models', 'route_key', 'variant_name'], ['model_versions', 'route_key', 'name'],
      ['requests', 'route_key', 'variant_name'], ['requests', 'execution_route_key', 'execution_variant_name'],
      ['user_model_limits', 'route_key', 'variant_name'], ['user_model_routing', 'source_route_key', 'source_variant_name'],
      ['user_model_routing', 'target_route_key', 'target_variant_name'], ['model_route_aliases', 'route_key', 'variant_name']
    ]) if (exists(table)) for (const row of store.all(`SELECT DISTINCT ${variant} AS variant FROM ${table} WHERE ${key}=?`, original)) variants.add(row.variant || '');
    const oldCatalog = store.get('SELECT created_at FROM model_catalog WHERE name=?', original);
    store.run('INSERT INTO model_catalog(name,created_at) VALUES (?,?)', name, oldCatalog?.created_at || new Date().toISOString());
    store.run('UPDATE model_versions SET route_key=? WHERE route_key=?', name, original);
    for (const [table, column] of references) if (!['model_catalog', 'model_versions'].includes(table) && exists(table)) store.run(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`, name, original);
    for (const variant of variants) {
      const oldId = routeId(original, variant), newId = routeId(name, variant);
      for (const table of ['chats', 'messages', 'requests']) store.run(`UPDATE ${table} SET model_id=? WHERE model_id=?`, newId, oldId);
      if (store.settings().defaultModelId === oldId) store.setSetting('defaultModelId', newId);
      store.run('INSERT INTO model_route_aliases(id,route_key,variant_name) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET route_key=excluded.route_key,variant_name=excluded.variant_name', oldId, name, variant);
      // Renaming back to an earlier name must not shadow its live public ID.
      store.run('DELETE FROM model_route_aliases WHERE id=?', newId);
    }
    const replace = values => [...new Set(values.map(value => value === original ? name : value))];
    if (exists('billing_config')) for (const row of store.all('SELECT id,free_routes FROM billing_config')) {
      const values = JSON.parse(row.free_routes);
      if (values.includes(original)) store.run('UPDATE billing_config SET free_routes=? WHERE id=?', JSON.stringify(replace(values)), row.id);
    }
    for (const [table, key, column] of snapshots) if (exists(table)) for (const row of store.all(`SELECT ${key},${column} FROM ${table}`)) {
      const value = JSON.parse(row[column]);
      if (value.allowedRoutes?.includes(original)) store.run(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`, JSON.stringify({ ...value, allowedRoutes: replace(value.allowedRoutes) }), row[key]);
    }
    store.run('DELETE FROM model_catalog WHERE name=?', original);
  }
  function resolve(id) {
    const alias = store.get('SELECT route_key,variant_name FROM model_route_aliases WHERE id=?', id);
    return alias && !currentIds().has(id) ? routeId(alias.route_key, alias.variant_name) : id;
  }
  function currentIds() {
    return new Set([
      ...store.all('SELECT route_key,variant_name FROM models'),
      ...store.all('SELECT route_key,name AS variant_name FROM model_versions'),
      ...store.all("SELECT name AS route_key,'' AS variant_name FROM model_catalog")
    ].map(row => routeId(row.route_key, row.variant_name)));
  }
  function aliases(modelIds) {
    const allowed = new Set(modelIds), current = currentIds();
    return Object.fromEntries(store.all('SELECT * FROM model_route_aliases').map(row => [row.id, routeId(row.route_key, row.variant_name)]).filter(([source, target]) => !current.has(source) && allowed.has(target)));
  }
  return { assertUnused, apply, resolve, aliases };
}
