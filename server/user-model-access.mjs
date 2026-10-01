const fault = (status, message, code) => Object.assign(new Error(message), { status, code });
const maximumLimit = 1_000_000_000;
const eightHours = 8 * 60 * 60 * 1000;

// Asia/Taipei has no daylight-saving transitions in the supported deployment
// period. Boundaries are represented in UTC to match requests.created_at.
export function usagePeriods(at = Date.now()) {
  const time = new Date(at).getTime();
  if (!Number.isFinite(time)) throw new TypeError('Invalid usage time');
  const local = new Date(time + eightHours);
  const year = local.getUTCFullYear(), month = local.getUTCMonth(), day = local.getUTCDate();
  const iso = value => new Date(value - eightHours).toISOString();
  return {
    timeZone: 'Asia/Taipei',
    dayStart: iso(Date.UTC(year, month, day)), dayEnd: iso(Date.UTC(year, month, day + 1)),
    monthStart: iso(Date.UTC(year, month, 1)), monthEnd: iso(Date.UTC(year, month + 1, 1))
  };
}

function limitValue(value, name) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximumLimit) throw fault(400, `${name}应为 0–${maximumLimit} 的整数，或 null（不限）。`);
  return value;
}
function modelText(value, name, optional = false) {
  if (optional && value === null) return null;
  if (typeof value !== 'string' || value.length > (optional ? 100 : 300) || (!optional && !value.trim()) || /[\u0000-\u001f\u007f]/u.test(value)) throw fault(400, `${name}格式无效。`);
  return value.trim();
}

export function createUserModelAccess({ store, clock = Date.now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS user_model_limits (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    route_key TEXT NOT NULL, scope_key TEXT NOT NULL, variant_name TEXT,
    daily_limit INTEGER CHECK(daily_limit IS NULL OR daily_limit >= 0),
    monthly_limit INTEGER CHECK(monthly_limit IS NULL OR monthly_limit >= 0),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(user_id,route_key,scope_key)
  );
  CREATE INDEX IF NOT EXISTS idx_requests_model_quota ON requests(user_id,route_key,variant_name,created_at);`);

  // Earlier builds allowed a family-wide rule. Preserve its configured values
  // as independent rules for each existing version, without sharing counters.
  // Existing explicit version rules always take precedence.
  const hasVersions = !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_versions'");
  store.transaction(() => {
    for (const legacy of store.all('SELECT * FROM user_model_limits WHERE variant_name IS NULL')) {
      const variants = new Set(store.all('SELECT DISTINCT variant_name FROM models WHERE route_key=?', legacy.route_key).map(row => row.variant_name || ''));
      if (hasVersions) for (const row of store.all('SELECT name FROM model_versions WHERE route_key=?', legacy.route_key)) variants.add(row.name);
      if (!variants.size) variants.add('');
      for (const variant of variants) store.run('INSERT OR IGNORE INTO user_model_limits(user_id,route_key,scope_key,variant_name,daily_limit,monthly_limit,updated_at) VALUES (?,?,?,?,?,?,?)', legacy.user_id, legacy.route_key, JSON.stringify(variant), variant, legacy.daily_limit, legacy.monthly_limit, legacy.updated_at);
      store.run('DELETE FROM user_model_limits WHERE user_id=? AND route_key=? AND scope_key=?', legacy.user_id, legacy.route_key, legacy.scope_key);
    }
  });

  function requireUser(userId) {
    if (!store.get('SELECT id FROM users WHERE id=?', userId)) throw fault(404, '用户不存在。');
  }
  function countUsage(userId, routeKey, variantName, periods) {
    const row = store.get('SELECT COUNT(*) AS usedMonth, COALESCE(SUM(CASE WHEN created_at>=? AND created_at<? THEN 1 ELSE 0 END),0) AS usedToday FROM requests WHERE user_id=? AND route_key=? AND created_at>=? AND created_at<? AND variant_name=?', periods.dayStart, periods.dayEnd, userId, routeKey, periods.monthStart, periods.monthEnd, variantName);
    return { usedToday: Number(row.usedToday), usedMonth: Number(row.usedMonth) };
  }
  function limitJSON(row, periods) {
    return { routeKey: row.route_key, variantName: row.variant_name, dailyLimit: row.daily_limit, monthlyLimit: row.monthly_limit,
      ...countUsage(row.user_id, row.route_key, row.variant_name, periods), updatedAt: row.updated_at };
  }
  function listLimits(userId, { at = clock() } = {}) {
    requireUser(userId);
    const periods = usagePeriods(at);
    return { limits: store.all('SELECT * FROM user_model_limits WHERE user_id=? ORDER BY route_key,scope_key', userId).map(row => limitJSON(row, periods)),
      timeZone: periods.timeZone, resetsAt: { daily: periods.dayEnd, monthly: periods.monthEnd } };
  }
  function replaceLimits(userId, values) {
    requireUser(userId);
    if (!Array.isArray(values) || values.length > 500) throw fault(400, '模型额度应为最多 500 项的列表。');
    const seen = new Set();
    const limits = values.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw fault(400, '模型额度格式无效。');
      const routeKey = modelText(value.routeKey, '模型名称'), variantName = modelText(value.variantName, '模型版本', true) ?? '';
      const scopeKey = JSON.stringify(variantName), key = JSON.stringify([routeKey, variantName]);
      if (seen.has(key)) throw fault(400, '同一模型和版本不能重复设置额度。');
      seen.add(key);
      return { routeKey, variantName, scopeKey, dailyLimit: limitValue(value.dailyLimit, '每日额度'), monthlyLimit: limitValue(value.monthlyLimit, '每月额度') };
    });
    const updatedAt = new Date(clock()).toISOString();
    store.transaction(() => {
      store.run('DELETE FROM user_model_limits WHERE user_id=?', userId);
      for (const limit of limits) store.run('INSERT INTO user_model_limits(user_id,route_key,scope_key,variant_name,daily_limit,monthly_limit,updated_at) VALUES (?,?,?,?,?,?,?)', userId, limit.routeKey, limit.scopeKey, limit.variantName, limit.dailyLimit, limit.monthlyLimit, updatedAt);
    });
    return listLimits(userId);
  }

  // The caller MUST run this synchronously inside the same BEGIN IMMEDIATE
  // transaction as INSERT requests. No await is allowed between the two. A
  // generation, continuation or regeneration reserves one request; retries use
  // that existing request and therefore never reserve again.
  function assertCanGenerate(userId, routeKey, variantName, { at = clock() } = {}) {
    const periods = usagePeriods(at);
    const scopes = store.all('SELECT * FROM user_model_limits WHERE user_id=? AND route_key=? AND variant_name=? ORDER BY scope_key', userId, routeKey, variantName ?? '');
    for (const scope of scopes) {
      const label = `${routeKey} · ${scope.variant_name || '默认版本'}`;
      if (scope.daily_limit === 0 || scope.monthly_limit === 0) throw fault(403, `管理员已禁止此账号使用 ${label}。`, 'USER_MODEL_DISABLED');
      const usage = countUsage(userId, routeKey, scope.variant_name, periods);
      if (scope.daily_limit !== null && usage.usedToday >= scope.daily_limit) throw fault(429, `${label} 的每日使用额度已用完，请明日再试或联系管理员。`, 'USER_MODEL_DAILY_LIMIT');
      if (scope.monthly_limit !== null && usage.usedMonth >= scope.monthly_limit) throw fault(429, `${label} 的每月使用额度已用完，请下月再试或联系管理员。`, 'USER_MODEL_MONTHLY_LIMIT');
    }
  }

  function registerRoutes(app, { auth, admin, csrf }) {
    app.get('/api/admin/users/:id/model-limits', auth, admin, (req, res) => res.json(listLimits(req.params.id)));
    app.put('/api/admin/users/:id/model-limits', auth, admin, csrf, (req, res) => res.json(replaceLimits(req.params.id, req.body?.limits)));
  }
  return { registerRoutes, listLimits, replaceLimits, assertCanGenerate };
}
