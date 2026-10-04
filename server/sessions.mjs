import { randomBytes } from 'node:crypto';
import { digest, id, now } from './store.mjs';

const lifetime = 7 * 86400_000;
const seenInterval = 60_000;

// Keep only a coarse, fixed label. Raw user agents and IP addresses are not stored.
export function deviceName(userAgent) {
  const agent = typeof userAgent === 'string' ? userAgent.slice(0, 1024) : '';
  const system = /iPad|iPhone|iPod/i.test(agent) ? 'iOS' : /Android/i.test(agent) ? 'Android' : /Windows/i.test(agent) ? 'Windows' : /Macintosh|Mac OS X/i.test(agent) ? 'macOS' : /Linux/i.test(agent) ? 'Linux' : '';
  const browser = /Edg(?:e|A|iOS)?\//i.test(agent) ? 'Edge' : /OPR\/|Opera/i.test(agent) ? 'Opera' : /Firefox\/|FxiOS\//i.test(agent) ? 'Firefox' : /Chrome\/|CriOS\//i.test(agent) ? 'Chrome' : /Safari\//i.test(agent) ? 'Safari' : '';
  return [browser, system].filter(Boolean).join(' · ') || '未知设备';
}

export function createSessionManager({ store, secureCookies }) {
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/' };
  const clearCookie = res => res.clearCookie('apirouter_session', cookieOptions);
  function metadata(session) {
    if (session.public_id && session.created_at && session.last_seen_at) return session;
    const createdAt = Number.isFinite(Date.parse(session.expires_at)) ? new Date(Date.parse(session.expires_at) - lifetime).toISOString() : now();
    store.run('UPDATE sessions SET public_id=COALESCE(public_id,?),created_at=COALESCE(created_at,?),last_seen_at=COALESCE(last_seen_at,?),device_label=COALESCE(device_label,?) WHERE token=?', id(), createdAt, createdAt, '原有设备', session.token);
    return store.get('SELECT * FROM sessions WHERE token=?', session.token);
  }
  function touch(session) {
    const current = metadata(session), stamp = now();
    if (!current.last_seen_at || Date.parse(current.last_seen_at) <= Date.now() - seenInterval) {
      store.run('UPDATE sessions SET last_seen_at=? WHERE token=? AND (last_seen_at IS NULL OR last_seen_at<=?)', stamp, current.token, new Date(Date.now() - seenInterval).toISOString());
      current.last_seen_at = stamp;
    }
    return current;
  }
  function create(req, res, userId) {
    const token = randomBytes(32).toString('base64url'), csrfToken = randomBytes(24).toString('base64url');
    const createdAt = now(), expiresAt = new Date(Date.now() + lifetime).toISOString();
    store.transaction(() => {
      store.run('DELETE FROM sessions WHERE expires_at<=?', createdAt);
      // Reauthentication replaces only this browser's session, never other devices.
      if (req.session?.user_id === userId) store.run('DELETE FROM sessions WHERE token=? AND user_id=?', req.session.token, userId);
      store.run('INSERT INTO sessions(token,user_id,csrf,expires_at,public_id,created_at,last_seen_at,device_label) VALUES (?,?,?,?,?,?,?,?)', digest(token), userId, csrfToken, expiresAt, id(), createdAt, createdAt, deviceName(req.get('user-agent')));
    });
    res.cookie('apirouter_session', token, { ...cookieOptions, maxAge: lifetime });
    return csrfToken;
  }
  function registerRoutes(app, { auth, csrf }) {
    app.get('/api/auth/sessions', auth, (req, res) => {
      const sessions = store.all('SELECT * FROM sessions WHERE user_id=? AND expires_at>? ORDER BY last_seen_at DESC,created_at DESC', req.user.id, now()).map(metadata).map(row => ({
        id: row.public_id, deviceName: row.device_label || '未知设备', createdAt: row.created_at,
        lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, current: row.token === req.session.token
      })).sort((left, right) => Number(right.current) - Number(left.current));
      res.json({ sessions });
    });
    app.delete('/api/auth/sessions/:id', auth, csrf, (req, res) => {
      const row = store.get('SELECT token FROM sessions WHERE public_id=? AND user_id=? AND expires_at>?', req.params.id, req.user.id, now());
      if (!row) return res.status(404).json({ error: '此设备已退出或不存在。' });
      const current = row.token === req.session.token;
      store.run('DELETE FROM sessions WHERE token=? AND user_id=?', row.token, req.user.id);
      if (current) clearCookie(res);
      res.json({ ok: true, current });
    });
    app.post('/api/auth/sessions/logout-others', auth, csrf, (req, res) => {
      const revokedCount = store.transaction(() => {
        store.run('DELETE FROM sessions WHERE user_id=? AND expires_at<=?', req.user.id, now());
        return Number(store.run('DELETE FROM sessions WHERE user_id=? AND token<>?', req.user.id, req.session.token).changes);
      });
      res.json({ ok: true, revokedCount });
    });
  }
  return { create, touch, clearCookie, registerRoutes };
}
