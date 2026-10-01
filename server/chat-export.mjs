import archiver from 'archiver';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';

const fault = (status, message) => Object.assign(new Error(message), { status });
const json = value => JSON.stringify(value, null, 2);
const safeId = value => encodeURIComponent(String(value));
const array = value => { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };
const fenced = value => {
  const text = String(value ?? '');
  let length = 3;
  for (const match of text.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = '`'.repeat(length);
  return `${fence}\n${text}\n${fence}`;
};

function messageJSON(db, row) {
  let content = row.content, reasoning = row.reasoning || '';
  for (const chunk of db.prepare('SELECT content,kind FROM message_chunks WHERE message_id=? ORDER BY seq').iterate(row.id)) {
    if (chunk.kind === 'reasoning') reasoning += chunk.content; else content += chunk.content;
  }
  const attachments = array(row.attachment_ids).map(id => db.prepare('SELECT id,name,mime,size,kind,created_at FROM files WHERE id=?').get(id)).filter(Boolean).map(file => ({ id: file.id, name: file.name, mime: file.mime, size: file.size, kind: file.kind, createdAt: file.created_at }));
  return { id: row.id, role: row.role, content, reasoning, modelId: row.model_id, status: row.status, error: row.error, createdAt: row.created_at, attachments };
}
function chatJSON(row) {
  return { id: row.id, title: row.title, modelId: row.model_id, variantName: row.variant_name ?? null,
    mode: row.mode, effort: row.effort, pinned: !!row.pinned, archived: !!row.archived, createdAt: row.created_at, updatedAt: row.updated_at };
}
function artifactsFor(db, chatId, hasArtifacts) {
  return hasArtifacts ? db.prepare('SELECT id,name,path,mime,size,created_at AS createdAt FROM work_artifacts WHERE chat_id=? ORDER BY created_at,id').all(chatId) : [];
}
function* chatMessages(db, chatId) {
  // Keyset reads release each SQLite statement before the ZIP stream awaits
  // backpressure. An aborted stream never leaves a live message cursor behind.
  const next = db.prepare('SELECT rowid AS export_rowid,* FROM messages WHERE chat_id=? AND rowid>? ORDER BY rowid LIMIT 1');
  let rowid = 0, row;
  while ((row = next.get(chatId, rowid))) { rowid = row.export_rowid; yield row; }
}
async function* jsonChat(db, chat, hasArtifacts) {
  yield `${json(chatJSON(chat)).slice(0, -2)},\n  "messages": [\n`;
  let first = true;
  for (const message of chatMessages(db, chat.id)) {
    yield `${first ? '' : ',\n'}${json(messageJSON(db, message))}`;
    first = false;
  }
  yield `\n  ],\n  "artifacts": ${json(artifactsFor(db, chat.id, hasArtifacts))}\n}\n`;
}
async function* markdownChat(db, chat, hasArtifacts) {
  yield `# 聊天记录\n\n## 对话信息\n\n${fenced(json(chatJSON(chat)))}\n\n`;
  for (const row of chatMessages(db, chat.id)) {
    const message = messageJSON(db, row);
    yield `## ${message.role === 'assistant' ? '助手' : message.role === 'user' ? '用户' : '消息'} · ${message.createdAt}\n\n`;
    yield `### 正文\n\n${message.content}\n\n`;
    if (message.reasoning) yield `### 思考与过程（与正文分开）\n\n${fenced(message.reasoning)}\n\n`;
    yield `### 消息信息\n\n${fenced(json({ id: message.id, role: message.role, modelId: message.modelId, status: message.status, error: message.error, attachments: message.attachments }))}\n\n`;
  }
  yield `## 工作文件元数据\n\n${fenced(json(artifactsFor(db, chat.id, hasArtifacts)))}\n`;
}

export function createChatExport({ store, clock = Date.now }) {
  const activeExports = new Set();
  function registerRoutes(app, { auth, admin }) {
    app.get('/api/admin/chats/export', auth, admin, async (req, res) => {
      const format = req.query.format ?? 'json';
      if (!['json', 'markdown'].includes(format)) throw fault(400, '导出格式请选择 json 或 markdown。');
      if (activeExports.size >= 2) throw fault(429, '已有聊天记录正在导出，请等待完成后重试。');
      const ticket = Symbol(); activeExports.add(ticket);
      let db, archive, closed = false;
      let releaseDisconnected;
      const disconnected = new Promise(resolve => { releaseDisconnected = resolve; });
      const cancelled = () => { closed = true; archive?.abort(); releaseDisconnected(); };
      res.on('close', cancelled);
      try {
        // A separate WAL read transaction provides one consistent snapshot
        // while chat generation and account changes continue normally.
        db = new DatabaseSync(resolve(store.dataDir, 'app.sqlite'), { readOnly: true });
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;');
        const counts = db.prepare('SELECT (SELECT COUNT(*) FROM users) AS users,(SELECT COUNT(*) FROM chats) AS chats,(SELECT COUNT(*) FROM messages) AS messages').get();
        const hasArtifacts = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_artifacts'").get();
        const createdAt = new Date(clock()).toISOString();
        res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="APIRouter-chats-${createdAt.replace(/[:.]/g, '-')}.zip"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        archive = archiver('zip', { zlib: { level: 6 } });
        // Ensure stream errors never become uncaught events. Each entry also
        // listens for the same error and releases its own waiters.
        archive.on('error', () => { closed = true; if (!res.destroyed) res.destroy(); });
        archive.pipe(res);
        const append = (source, name) => new Promise((resolveEntry, rejectEntry) => {
          let settled = false;
          const finish = error => {
            if (settled) return;
            settled = true;
            archive.off('entry', entry); archive.off('error', failed); res.off('close', disconnected);
            if (source instanceof Readable) { source.off('error', failed); if (error) source.destroy(); }
            error ? rejectEntry(error) : resolveEntry();
          };
          const entry = value => { if (value.name === name) finish(); };
          const failed = error => finish(error);
          const disconnected = () => finish(new Error('Export disconnected'));
          if (closed || res.destroyed) return rejectEntry(new Error('Export disconnected'));
          archive.on('entry', entry); archive.on('error', failed); res.on('close', disconnected);
          if (source instanceof Readable) source.once('error', failed);
          archive.append(source, { name });
        });
        await append(json({ schemaVersion: 1, createdAt, format, ...counts, includesArchived: true, includesReasoning: true, includesAttachmentContent: false,
          note: '一致性快照；生成中的消息包含导出时已保存内容。包含用户信息、聊天正文、独立思考字段和附件元数据；不含附件二进制、账号密码或服务配置凭据。用户自行写入聊天的内容会原样保留。' }), 'manifest.json');
        for (const user of db.prepare('SELECT id,name,email,role,disabled,created_at FROM users ORDER BY created_at,id').iterate()) {
          if (closed) break;
          const directory = `users/user-${safeId(user.id)}`;
          await append(json({ id: user.id, name: user.name, email: user.email, role: user.role, disabled: !!user.disabled, createdAt: user.created_at }), `${directory}/user.json`);
          for (const chat of db.prepare('SELECT * FROM chats WHERE user_id=? ORDER BY created_at,id').iterate(user.id)) {
            if (closed) break;
            const content = format === 'json' ? jsonChat(db, chat, hasArtifacts) : markdownChat(db, chat, hasArtifacts);
            await append(Readable.from(content), `${directory}/chats/chat-${safeId(chat.id)}.${format === 'json' ? 'json' : 'md'}`);
          }
        }
        if (!closed) await Promise.race([archive.finalize(), disconnected]);
      } catch (error) {
        archive?.abort();
        if (!res.destroyed && !closed) {
          if (res.headersSent) res.destroy();
          else { res.removeHeader('Content-Disposition'); res.status(500).type('json').json({ error: '聊天记录导出失败，请重试。' }); }
        }
      } finally {
        res.off('close', cancelled);
        try { db?.close(); } catch { /* interrupted readers are already released */ }
        activeExports.delete(ticket);
      }
    });
  }
  return { registerRoutes };
}
