import express from 'express';
import { id } from './store.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw fail(400, `${label}不能为空，且最多 ${max} 个字符。`);
  return value.trim();
}

export function createAnnouncements({ store, clock = Date.now }) {
  const now = () => new Date(clock()).toISOString();
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',revision INTEGER NOT NULL DEFAULT 1,author_id TEXT NOT NULL REFERENCES users(id),updated_by TEXT NOT NULL REFERENCES users(id),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,published_at TEXT);
    CREATE TABLE IF NOT EXISTS announcement_reads (announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,revision INTEGER NOT NULL,read_at TEXT NOT NULL,PRIMARY KEY(announcement_id,user_id));
    CREATE INDEX IF NOT EXISTS idx_announcements_status ON announcements(status,updated_at);
  `);
  const json = row => ({ id: row.id, title: row.title, body: row.body, status: row.status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, publishedAt: row.published_at });
  const find = value => store.get('SELECT * FROM announcements WHERE id=?', value);
  const validate = (input, previous = {}) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, '公告格式不正确。');
    const title = text(input.title ?? previous.title, '公告标题', 120);
    const body = text(input.body ?? previous.body, '公告内容', 20_000);
    const status = input.status ?? previous.status ?? 'draft';
    if (!['draft', 'published'].includes(status)) throw fail(400, '公告状态不正确。');
    return { title, body, status };
  };
  function registerRoutes(app, { auth, admin, csrf }) {
    const userRoutes = express.Router(), adminRoutes = express.Router();
    userRoutes.get('/', (req, res) => {
      const rows = store.all("SELECT a.* FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id=a.id AND r.user_id=? WHERE a.status='published' AND (r.revision IS NULL OR r.revision<a.revision) ORDER BY a.updated_at DESC,a.id", req.user.id);
      res.set('Cache-Control', 'no-store').json({ announcements: rows.map(json) });
    });
    userRoutes.post('/:id/read', (req, res) => {
      store.transaction(() => {
        const current = find(req.params.id);
        if (!current || current.status !== 'published') throw fail(404, '公告已下架或不存在。');
        if (!Number.isInteger(req.body?.revision) || req.body.revision !== current.revision) throw fail(409, '公告已有更新，请阅读最新内容。');
        store.run('INSERT INTO announcement_reads(announcement_id,user_id,revision,read_at) VALUES(?,?,?,?) ON CONFLICT(announcement_id,user_id) DO UPDATE SET revision=excluded.revision,read_at=excluded.read_at', current.id, req.user.id, current.revision, now());
      });
      res.json({ ok: true });
    });
    adminRoutes.get('/', (_req, res) => res.set('Cache-Control', 'no-store').json({ announcements: store.all('SELECT * FROM announcements ORDER BY updated_at DESC,id').map(json) }));
    adminRoutes.post('/', (req, res) => {
      const value = validate(req.body), time = now(), announcementId = id();
      store.run('INSERT INTO announcements(id,title,body,status,author_id,updated_by,created_at,updated_at,published_at) VALUES(?,?,?,?,?,?,?,?,?)', announcementId, value.title, value.body, value.status, req.user.id, req.user.id, time, time, value.status === 'published' ? time : null);
      res.status(201).json({ announcement: json(find(announcementId)) });
    });
    adminRoutes.patch('/:id', (req, res) => {
      store.transaction(() => {
        const current = find(req.params.id);
        if (!current) throw fail(404, '公告不存在。');
        if (!Number.isInteger(req.body?.revision) || req.body.revision !== current.revision) throw fail(409, '其他管理员已修改此公告，请刷新后再保存。');
        const value = validate(req.body, current);
        if (value.title === current.title && value.body === current.body && value.status === current.status) return;
        const time = now();
        // A content edit or republication is a new revision and must be read again.
        store.run('UPDATE announcements SET title=?,body=?,status=?,revision=revision+1,updated_by=?,updated_at=?,published_at=? WHERE id=?', value.title, value.body, value.status, req.user.id, time, value.status === 'published' ? time : current.published_at, current.id);
      });
      res.json({ announcement: json(find(req.params.id)) });
    });
    app.use('/api/announcements', auth, csrf, userRoutes);
    app.use('/api/admin/announcements', auth, csrf, admin, adminRoutes);
  }
  return { registerRoutes };
}
