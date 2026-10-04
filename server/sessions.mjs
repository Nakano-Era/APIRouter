import { randomBytes } from 'node:crypto';
import { digest, id, now } from './store.mjs';
import { sessionClientInfo } from './session-client-info.mjs';

const legacyLifetime = 7 * 86400_000;
// Browser cookies have a practical lifetime cap; server-side sessions do not.
const cookieLifetime = 400 * 86400_000;
const cookieRefreshInterval = 86400_000;
const persistentExpiry = '9999-12-31T23:59:59.999Z';
const seenInterval = 60_000;

// Keep only a coarse, fixed device label; never store raw user agents.
export function deviceName(userAgent) {
  const agent = typeof userAgent === 'string' ? userAgent.slice(0, 1024) : '';
  const system = /iPad|iPhone|iPod/i.test(agent) ? 'iOS' : /Android/i.test(agent) ? 'Android' : /Windows/i.test(agent) ? 'Windows' : /Macintosh|Mac OS X/i.test(agent) ? 'macOS' : /Linux/i.test(agent) ? 'Linux' : '';
  const browser = /Edg(?:e|A|iOS)?\//i.test(agent) ? 'Edge' : /OPR\/|Opera/i.test(agent) ? 'Opera' : /Firefox\/|FxiOS\//i.test(agent) ? 'Firefox' : /Chrome\/|CriOS\//i.test(agent) ? 'Chrome' : /Safari\//i.test(agent) ? 'Safari' : '';
  return [browser, system].filter(Boolean).join(' · ') || '未知设备';
}

export function createSessionManager({ store, secureCookies }) {
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/' };
  function replaceCookie(res) {
    // A login/logout in this request supersedes any earlier renewal header.
    const cookies = res.getHeader('Set-Cookie');
    if (cookies) res.setHeader('Set-Cookie', (Array.isArray(cookies) ? cookies : [cookies]).filter(value => !String(value).startsWith('apirouter_session=')));
  }
  const clearCookie = res => { replaceCookie(res); res.clearCookie('apirouter_session', cookieOptions); };
  function setCookie(res, token) { replaceCookie(res); res.cookie('apirouter_session', token, { ...cookieOptions, maxAge: cookieLifetime }); }
  function metadata(session) {
    if (session.public_id && session.created_at && session.last_seen_at) return session;
    const createdAt = session.persistent === 1 ? now() : Number.isFinite(Date.parse(session.expires_at)) ? new Date(Date.parse(session.expires_at) - legacyLifetime).toISOString() : now();
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
  function renewCookie(session, token, res) {
    if (session.persistent !== 1 || (session.cookie_refreshed_at && Date.parse(session.cookie_refreshed_at) > Date.now() - cookieRefreshInterval)) return;
    const stamp = now();
    const updated = store.run('UPDATE sessions SET cookie_refreshed_at=? WHERE token=? AND persistent=1 AND (cookie_refreshed_at IS NULL OR cookie_refreshed_at<=?)', stamp, session.token, new Date(Date.now() - cookieRefreshInterval).toISOString());
    if (updated.changes) { session.cookie_refreshed_at = stamp; setCookie(res, token); }
  }
  function create(req, res, userId) {
    const token = randomBytes(32).toString('base64url'), csrfToken = randomBytes(24).toString('base64url');
    const createdAt = now(), client = sessionClientInfo(req);
    store.transaction(() => {
      store.run('DELETE FROM sessions WHERE persistent<>1 AND expires_at<=?', createdAt);
      // Reauthentication replaces only this browser's session, never other devices.
      if (req.session?.user_id === userId) store.run('DELETE FROM sessions WHERE token=? AND user_id=?', req.session.token, userId);
      store.run('INSERT INTO sessions(token,user_id,csrf,expires_at,public_id,created_at,last_seen_at,device_label,persistent,cookie_refreshed_at,login_ip,geo_location,device_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', digest(token), userId, csrfToken, persistentExpiry, id(), createdAt, createdAt, deviceName(req.get('user-agent')), 1, createdAt, client.loginIp, client.geoLocation, client.deviceType);
    });
    setCookie(res, token);
    return csrfToken;
  }
  function list(userId, currentToken) {
    return store.all('SELECT * FROM sessions WHERE user_id=? AND (persistent=1 OR expires_at>?) ORDER BY last_seen_at DESC,created_at DESC', userId, now()).map(metadata).map(row => ({
        id: row.public_id, deviceName: row.device_label || '未知设备', createdAt: row.created_at,
        lastSeenAt: row.last_seen_at, expiresAt: row.persistent === 1 ? null : row.expires_at, current: row.token === currentToken,
        loginIp: row.login_ip || null, geoLocation: row.geo_location || '未记录', deviceType: row.device_type || 'unknown'
      })).sort((left, right) => Number(right.current) - Number(left.current));
  }
  function registerRoutes(app, { auth, csrf, admin }) {
    app.get('/api/auth/sessions', auth, (req, res) => {
      res.json({ sessions: list(req.user.id, req.session.token) });
    });
    app.get('/api/admin/users/:id/sessions', auth, admin, (req, res) => {
      const user = store.get('SELECT id,disabled FROM users WHERE id=?', req.params.id);
      if (!user) return res.status(404).json({ error: '用户不存在。' });
      res.json({ sessions: user.disabled ? [] : list(user.id, req.session.token) });
    });
    app.delete('/api/auth/sessions/:id', auth, csrf, (req, res) => {
      const row = store.get('SELECT token FROM sessions WHERE public_id=? AND user_id=? AND (persistent=1 OR expires_at>?)', req.params.id, req.user.id, now());
      if (!row) return res.status(404).json({ error: '此设备已退出或不存在。' });
      const current = row.token === req.session.token;
      store.run('DELETE FROM sessions WHERE token=? AND user_id=?', row.token, req.user.id);
      if (current) clearCookie(res);
      res.json({ ok: true, current });
    });
    app.post('/api/auth/sessions/logout-others', auth, csrf, (req, res) => {
      const revokedCount = store.transaction(() => {
        store.run('DELETE FROM sessions WHERE user_id=? AND persistent<>1 AND expires_at<=?', req.user.id, now());
        return Number(store.run('DELETE FROM sessions WHERE user_id=? AND token<>?', req.user.id, req.session.token).changes);
      });
      res.json({ ok: true, revokedCount });
    });
  }
  return { create, touch, renewCookie, clearCookie, registerRoutes };
}
