import { now } from './store.mjs';

const fault = (status, message, code) => Object.assign(new Error(message), { status, code });
const efforts = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
function text(value, name, version = false) {
  if (typeof value !== 'string' || value.length > (version ? 100 : 300) || (!version && !value.trim()) || /[\u0000-\u001f\u007f]/u.test(value)) throw fault(400, `${name}格式无效。`);
  return value.trim();
}

// These mappings only select an execution route. They never alter prompts or
// instruct an upstream to claim another model's identity.
export function createUserModelRouting({ store, ensureUserIdle }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS user_model_routing (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_route_key TEXT NOT NULL, source_variant_name TEXT NOT NULL,
    target_route_key TEXT NOT NULL, target_variant_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, effort TEXT NOT NULL DEFAULT 'auto',
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id,source_route_key,source_variant_name)
  );`);
  if (!store.all('PRAGMA table_info(user_model_routing)').some(column => column.name === 'fallbacks_json')) {
    store.db.exec("ALTER TABLE user_model_routing ADD COLUMN fallbacks_json TEXT NOT NULL DEFAULT '[]'");
  }
  function requireUser(userId) {
    if (!store.get('SELECT id FROM users WHERE id=?', userId)) throw fault(404, '用户不存在。');
  }
  function known(routeKey, variantName) {
    return store.get('SELECT 1 FROM models WHERE route_key=? AND variant_name=? LIMIT 1', routeKey, variantName)
      || store.get('SELECT 1 FROM model_versions WHERE route_key=? AND name=?', routeKey, variantName);
  }
  function usableTargets(routeKey, variantName) {
    return store.all('SELECT m.* FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.route_key=? AND m.variant_name=? AND m.enabled=1 AND m.available=1 AND p.enabled=1', routeKey, variantName);
  }
  function ruleJSON(row) {
    return { sourceRouteKey: row.source_route_key, sourceVariantName: row.source_variant_name, targetRouteKey: row.target_route_key,
      targetVariantName: row.target_variant_name, enabled: !!row.enabled, effort: row.effort,
      fallbacks: JSON.parse(row.fallbacks_json || '[]') };
  }
  function listRules(userId) {
    requireUser(userId);
    return { rules: store.all('SELECT * FROM user_model_routing WHERE user_id=? ORDER BY source_route_key,source_variant_name', userId).map(ruleJSON) };
  }
  function replaceRules(userId, values) {
    requireUser(userId);
    if (!Array.isArray(values) || values.length > 100) throw fault(400, '用户模型路由应为最多 100 项的列表。');
    const seen = new Set();
    const rules = values.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault(400, '用户模型路由格式无效。');
      const sourceRouteKey = text(value.sourceRouteKey, '所选模型'), sourceVariantName = text(value.sourceVariantName ?? '', '所选版本', true);
      const targetRouteKey = text(value.targetRouteKey, '执行模型'), targetVariantName = text(value.targetVariantName ?? '', '执行版本', true);
      const enabled = value.enabled ?? true, effort = value.effort ?? 'auto';
      if (typeof enabled !== 'boolean' || !efforts.has(effort)) throw fault(400, '路由开关或执行思考强度无效。');
      const key = JSON.stringify([sourceRouteKey, sourceVariantName]);
      if (seen.has(key)) throw fault(400, '同一所选模型与版本只能配置一条路由。');
      seen.add(key);
      if (sourceRouteKey === targetRouteKey && sourceVariantName === targetVariantName) throw fault(400, '执行模型与版本需要不同于所选模型与版本。');
      const fallbacks = value.fallbacks === undefined ? [] : value.fallbacks;
      if (!Array.isArray(fallbacks)) throw fault(400, '备用模型应为按执行顺序排列的列表。');
      const targetsSeen = new Set([JSON.stringify([targetRouteKey, targetVariantName, effort])]);
      // The request's body limit bounds storage; there is no fixed backup count.
      // Falling back to the originally selected source is allowed and remains
      // one explicit step, not another lookup of that source's routing rule.
      const backups = fallbacks.map(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw fault(400, '备用模型格式无效。');
        const targetRouteKey = text(item.targetRouteKey, '备用模型'), targetVariantName = text(item.targetVariantName ?? '', '备用版本', true);
        const effort = item.effort ?? 'auto';
        if (!efforts.has(effort)) throw fault(400, '备用模型思考强度无效。');
        const targetKey = JSON.stringify([targetRouteKey, targetVariantName, effort]);
        if (targetsSeen.has(targetKey)) throw fault(400, '执行列表中不能重复添加相同模型、版本和思考强度。');
        targetsSeen.add(targetKey);
        return { targetRouteKey, targetVariantName, effort };
      });
      // Disabled records can still be removed or retained if a channel was
      // subsequently deleted. Enabling always revalidates both route names.
      if (enabled) {
        if (!known(sourceRouteKey, sourceVariantName)) throw fault(400, '所选模型的版本不存在，请刷新模型目录。');
        for (const step of [{ targetRouteKey, targetVariantName, effort }, ...backups]) {
          if (!known(step.targetRouteKey, step.targetVariantName)) throw fault(400, '执行模型或备用模型的版本不存在，请刷新模型目录。');
          const targets = usableTargets(step.targetRouteKey, step.targetVariantName);
          if (!targets.length) throw fault(400, '执行模型或备用模型的版本没有可用渠道，请先配置并启用渠道。');
          if (step.effort !== 'auto' && !targets.some(row => JSON.parse(row.reasoning_efforts || '[]').includes(step.effort))) throw fault(400, '执行模型或备用模型的版本不支持配置的思考强度。');
        }
      }
      return { sourceRouteKey, sourceVariantName, targetRouteKey, targetVariantName, enabled, effort, fallbacks: backups };
    });
    ensureUserIdle(userId);
    store.transaction(() => {
      store.run('DELETE FROM user_model_routing WHERE user_id=?', userId);
      for (const rule of rules) store.run('INSERT INTO user_model_routing(user_id,source_route_key,source_variant_name,target_route_key,target_variant_name,enabled,effort,updated_at,fallbacks_json) VALUES (?,?,?,?,?,?,?,?,?)',
        userId, rule.sourceRouteKey, rule.sourceVariantName, rule.targetRouteKey, rule.targetVariantName, rule.enabled ? 1 : 0, rule.effort, now(), JSON.stringify(rule.fallbacks));
    });
    return listRules(userId);
  }
  // Resolve exactly once. The caller walks the primary and explicit backups;
  // routing rules belonging to those targets must not be applied recursively.
  function resolve(userId, routeKey, variantName = '') {
    const row = store.get('SELECT * FROM user_model_routing WHERE user_id=? AND source_route_key=? AND source_variant_name=? AND enabled=1', userId, routeKey, variantName);
    return row ? ruleJSON(row) : null;
  }
  function registerRoutes(app, { auth, admin, csrf }) {
    app.get('/api/admin/users/:id/model-routing', auth, admin, (req, res) => res.json(listRules(req.params.id)));
    app.put('/api/admin/users/:id/model-routing', auth, admin, csrf, (req, res) => res.json(replaceRules(req.params.id, req.body?.rules)));
  }
  return { listRules, replaceRules, resolve, registerRoutes };
}
