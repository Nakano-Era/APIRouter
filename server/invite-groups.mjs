import { id } from './store.mjs';
import { addBillingPeriod } from './billing.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fields = new Set(['name', 'enabled', 'planId', 'duration', 'activeUntil', 'rules']);

// A group is a template. Each invitation freezes rights at creation; toggling
// or deleting the group remains an immediate revocation of unredeemed links.
export function createInviteGroups({ store, userRouting, clock = Date.now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS invite_groups (
    id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE,enabled INTEGER NOT NULL DEFAULT 1,
    plan_id TEXT,duration TEXT NOT NULL DEFAULT 'period',active_until TEXT,
    rules_json TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  );`);
  const inviteColumns = store.all('PRAGMA table_info(invites)').map(row => row.name);
  for (const column of ['group_id', 'group_snapshot', 'group_user_id']) if (!inviteColumns.includes(column)) store.db.exec(`ALTER TABLE invites ADD COLUMN ${column} TEXT`);
  const iso = () => new Date(clock()).toISOString();
  const groupJSON = row => row ? { id: row.id, name: row.name, enabled: !!row.enabled, planId: row.plan_id, duration: row.duration, activeUntil: row.active_until, rules: JSON.parse(row.rules_json), createdAt: row.created_at, updatedAt: row.updated_at } : null;
  const get = groupId => groupJSON(store.get('SELECT * FROM invite_groups WHERE id=?', groupId));
  function planSnapshot(planId) {
    if (planId === null) return null;
    if (planId === 'free') return { id: 'free', name: '免费版', interval: 'month', dailyLimit: store.settings().dailyLimit, allowedRoutes: JSON.parse(store.get('SELECT free_routes FROM billing_config WHERE id=1').free_routes) };
    const row = store.get('SELECT * FROM billing_plans WHERE id=?', planId);
    if (!row) throw fail(400, '所选套餐不存在，请重新选择。');
    return { ...JSON.parse(row.data), id: row.id, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function validateGroup(input, existing = null) {
    if (!object(input) || Object.keys(input).some(key => !fields.has(key))) throw fail(400, '邀请分组配置格式无效。');
    const value = { name: '', enabled: true, planId: null, duration: 'period', activeUntil: null, rules: [], ...existing, ...input };
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(value.name)) throw fail(400, '分组名称需为 1–80 个字符。');
    if (typeof value.enabled !== 'boolean') throw fail(400, '分组启用状态无效。');
    if (value.planId !== null && (typeof value.planId !== 'string' || !value.planId || value.planId.length > 100)) throw fail(400, '套餐选择无效。');
    if (!['period', 'permanent', 'until'].includes(value.duration)) throw fail(400, '套餐期限无效。');
    planSnapshot(value.planId);
    let activeUntil = null;
    if (value.planId !== null && value.duration === 'until') {
      const date = typeof value.activeUntil === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value.activeUntil) ? new Date(value.activeUntil) : null;
      if (!date || !Number.isFinite(date.getTime()) || value.enabled && date.getTime() <= clock()) throw fail(400, '套餐截止时间必须是未来的有效时间。');
      activeUntil = date.toISOString();
    }
    const rules = userRouting.validateRules(value.rules, { checkAvailability: value.enabled });
    return { name: value.name.trim(), enabled: value.enabled, planId: value.planId, duration: value.planId === null ? 'period' : value.duration, activeUntil, rules };
  }
  function requireGroup(groupId) {
    const value = typeof groupId === 'string' && get(groupId);
    if (!value) throw fail(404, '邀请分组不存在。');
    return value;
  }
  function snapshotForInvite(groupId, adminId) {
    if (groupId === null || groupId === undefined || groupId === '') return { groupId: null, groupSnapshot: null };
    const group = requireGroup(groupId);
    if (!group.enabled) throw fail(400, '该邀请分组已停用。');
    const current = validateGroup({}, group);
    const admin = store.get('SELECT role,disabled FROM users WHERE id=?', adminId);
    if (!admin || admin.role !== 'admin' || admin.disabled) throw fail(403, '仅有效管理员可创建邀请。');
    const snapshot = { version: 1, groupId: group.id, groupName: group.name, adminId, plan: planSnapshot(current.planId), duration: current.duration, activeUntil: current.activeUntil, rules: current.rules };
    return { groupId: group.id, groupSnapshot: JSON.stringify(snapshot) };
  }
  function validateInvitation(invite) {
    if (!invite) throw fail(400, '邀请已失效或已使用。');
    if (!invite.group_id && !invite.group_snapshot) return null;
    if (!invite.group_id || !invite.group_snapshot || invite.used_at || invite.group_user_id || invite.expires_at <= iso()) throw fail(400, '邀请已失效或已使用。');
    const group = get(invite.group_id);
    if (!group?.enabled) throw fail(400, '此邀请分组已停用或删除，请联系管理员获取新邀请。');
    let snapshot;
    try { snapshot = JSON.parse(invite.group_snapshot); } catch { throw fail(400, '邀请配置无效，请联系管理员重新创建。'); }
    if (!object(snapshot) || snapshot.version !== 1 || snapshot.groupId !== invite.group_id || typeof snapshot.groupName !== 'string' || !['period', 'permanent', 'until'].includes(snapshot.duration)) throw fail(400, '邀请配置无效，请联系管理员重新创建。');
    const admin = store.get('SELECT role,disabled FROM users WHERE id=?', snapshot.adminId);
    if (!admin || admin.role !== 'admin' || admin.disabled) throw fail(400, '邀请创建者已失效，请联系管理员获取新邀请。');
    if (snapshot.plan !== null && (!object(snapshot.plan) || typeof snapshot.plan.id !== 'string' || typeof snapshot.plan.name !== 'string' || !['month', 'year'].includes(snapshot.plan.interval) || !Number.isInteger(snapshot.plan.dailyLimit) || !Array.isArray(snapshot.plan.allowedRoutes))) throw fail(400, '邀请套餐配置无效。');
    if (snapshot.plan && snapshot.duration === 'until' && (!Number.isFinite(Date.parse(snapshot.activeUntil)) || Date.parse(snapshot.activeUntil) <= clock())) throw fail(400, '此邀请的套餐赠送期限已结束，请联系管理员。');
    // Current availability is not part of frozen access. Temporarily offline
    // providers must not prevent the invited user from registering.
    return { ...snapshot, rules: userRouting.validateRules(snapshot.rules, { checkAvailability: false }) };
  }
  function describeInvitation(invite) {
    let snapshot = null;
    try { snapshot = invite.group_snapshot ? JSON.parse(invite.group_snapshot) : null; } catch { /* Incomplete old row. */ }
    return { groupId: invite.group_id || null, groupName: snapshot?.groupName || null };
  }
  function applyInvitation(invite, userId) {
    // The registration caller owns the enclosing INSERT-user / consume-invite
    // transaction. Keep this operation synchronous and never begin a nested one.
    if (!store.db.isTransaction) throw new Error('Invitation rights must be applied within registration transaction');
    const current = store.get('SELECT * FROM invites WHERE id=?', invite.id);
    const snapshot = validateInvitation(current);
    if (!snapshot) return;
    const user = store.get('SELECT id,role FROM users WHERE id=?', userId);
    if (!user || user.role !== 'user' || store.get('SELECT 1 FROM billing_entitlement_overrides WHERE user_id=?', userId) || store.get('SELECT 1 FROM user_model_routing WHERE user_id=?', userId) || store.get('SELECT 1 FROM invites WHERE group_user_id=?', userId)) throw fail(409, '此账号不能重复领取邀请权益。');
    const time = iso();
    if (snapshot.plan) {
      const activeUntil = snapshot.duration === 'period' ? addBillingPeriod(time, snapshot.plan.interval) : snapshot.duration === 'until' ? snapshot.activeUntil : null;
      const reason = `邀请分组：${snapshot.groupName}`;
      store.run('INSERT INTO billing_entitlement_overrides(user_id,plan_id,plan_snapshot,active_until,reason,admin_id,updated_at) VALUES(?,?,?,?,?,?,?)', userId, snapshot.plan.id, JSON.stringify(snapshot.plan), activeUntil, reason, snapshot.adminId, time);
      const next = { planId: snapshot.plan.id === 'free' ? null : snapshot.plan.id, planName: snapshot.plan.name, activeUntil, source: 'admin', status: 'active', cancelAtPeriodEnd: false, dailyLimit: snapshot.plan.dailyLimit, allowedRoutes: snapshot.plan.allowedRoutes, reason, adminId: snapshot.adminId, updatedAt: time };
      store.run('INSERT INTO billing_entitlement_audit(id,user_id,admin_id,action,previous_value,next_value,reason,created_at) VALUES(?,?,?,?,?,?,?,?)', id(), userId, snapshot.adminId, 'set', null, JSON.stringify(next), reason, time);
    }
    userRouting.applyValidatedRules(userId, snapshot.rules);
    store.run('UPDATE invites SET group_user_id=? WHERE id=?', userId, current.id);
  }
  function registerRoutes(app, { auth, admin, csrf }) {
    app.get('/api/admin/invite-groups', auth, admin, (_req, res) => res.set('Cache-Control', 'no-store').json({ groups: store.all('SELECT * FROM invite_groups ORDER BY enabled DESC,name,id').map(groupJSON) }));
    app.post('/api/admin/invite-groups', auth, admin, csrf, (req, res) => {
      const group = validateGroup(req.body), groupId = id(), time = iso();
      if (store.get('SELECT id FROM invite_groups WHERE name=?', group.name)) throw fail(409, '此分组名称已存在。');
      store.run('INSERT INTO invite_groups(id,name,enabled,plan_id,duration,active_until,rules_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)', groupId, group.name, Number(group.enabled), group.planId, group.duration, group.activeUntil, JSON.stringify(group.rules), time, time);
      res.status(201).json({ group: get(groupId) });
    });
    app.patch('/api/admin/invite-groups/:id', auth, admin, csrf, (req, res) => {
      const current = requireGroup(req.params.id), value = validateGroup(req.body, current);
      if (store.get('SELECT id FROM invite_groups WHERE name=? AND id<>?', value.name, current.id)) throw fail(409, '此分组名称已存在。');
      store.run('UPDATE invite_groups SET name=?,enabled=?,plan_id=?,duration=?,active_until=?,rules_json=?,updated_at=? WHERE id=?', value.name, Number(value.enabled), value.planId, value.duration, value.activeUntil, JSON.stringify(value.rules), iso(), current.id);
      res.json({ group: get(current.id) });
    });
    app.delete('/api/admin/invite-groups/:id', auth, admin, csrf, (req, res) => { store.run('DELETE FROM invite_groups WHERE id=?', req.params.id); res.json({ ok: true }); });
  }
  return { registerRoutes, validateGroup, snapshotForInvite, validateInvitation, applyInvitation, describeInvitation };
}
