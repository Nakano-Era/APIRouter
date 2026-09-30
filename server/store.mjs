import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const now = () => new Date().toISOString();
export const id = () => randomBytes(16).toString('hex');
export const digest = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64);
  return `${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password, hash) {
  const [salt, expected] = hash.split(':');
  const actual = await derive(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, 'hex');
  return expectedBuffer.length === actual.length && timingSafeEqual(expectedBuffer, actual);
}
export function createStore(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, 'files'), { recursive: true, mode: 0o700 });
  const keyPath = join(dataDir, 'master.key');
  let masterKey;
  if (process.env.MASTER_KEY) {
    if (!/^[a-fA-F0-9]{64}$/.test(process.env.MASTER_KEY)) throw new Error('MASTER_KEY must contain 64 hex characters');
    masterKey = Buffer.from(process.env.MASTER_KEY, 'hex');
  } else {
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    masterKey = readFileSync(keyPath);
    if (masterKey.length !== 32) throw new Error('Invalid data/master.key');
  }
  const db = new DatabaseSync(resolve(dataDir, 'app.sqlite'));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, daily_limit INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, protocol TEXT NOT NULL, encrypted_key TEXT NOT NULL, key_hint TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, last_synced_at TEXT, last_sync_error TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE, model_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, vision INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 1, manual INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'untested', last_checked_at TEXT, error TEXT, UNIQUE(provider_id, model_id));
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, model_id TEXT, pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, model_id TEXT, status TEXT NOT NULL DEFAULT 'complete', attachment_ids TEXT NOT NULL DEFAULT '[]', error TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL, text_content TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT, expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), model_id TEXT, status TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);`);
  const addColumns = (table, columns) => {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    for (const [name, definition] of Object.entries(columns)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  addColumns('providers', { priority: 'INTEGER NOT NULL DEFAULT 0', failure_threshold: 'INTEGER NOT NULL DEFAULT 3', cooldown_seconds: 'INTEGER NOT NULL DEFAULT 60', auth_mode: "TEXT NOT NULL DEFAULT 'auto'", runtime: "TEXT NOT NULL DEFAULT 'api'" });
  addColumns('models', { route_key: "TEXT NOT NULL DEFAULT ''", failure_count: 'INTEGER NOT NULL DEFAULT 0', cooldown_until: 'TEXT', failure_epoch: 'INTEGER NOT NULL DEFAULT 0', reasoning_efforts: "TEXT NOT NULL DEFAULT '[]'", context_window: 'INTEGER', max_output_tokens: 'INTEGER' });
  addColumns('providers', { responses_profile: "TEXT NOT NULL DEFAULT 'auto'" });
  addColumns('chats', { mode: "TEXT NOT NULL DEFAULT 'chat'", effort: "TEXT NOT NULL DEFAULT 'auto'", skill_ids: "TEXT NOT NULL DEFAULT '[]'", web_search: 'INTEGER NOT NULL DEFAULT 0' });
  addColumns('messages', { source_provider: 'TEXT', source_model: 'TEXT', reasoning: "TEXT NOT NULL DEFAULT ''" });
  db.exec('CREATE TABLE IF NOT EXISTS message_chunks (seq INTEGER PRIMARY KEY AUTOINCREMENT,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,content TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_message_chunks ON message_chunks(message_id,seq);');
  addColumns('message_chunks', { kind: "TEXT NOT NULL DEFAULT 'content'" });
  // Every displayed delta has first been committed here. Recover it even after
  // an unclean process exit, before turning the old streaming row into an error.
  db.exec("UPDATE messages SET content=content || COALESCE((SELECT group_concat(content,'') FROM (SELECT content FROM message_chunks WHERE message_id=messages.id AND kind='content' ORDER BY seq)),''), reasoning=reasoning || COALESCE((SELECT group_concat(content,'') FROM (SELECT content FROM message_chunks WHERE message_id=messages.id AND kind='reasoning' ORDER BY seq)),'') WHERE EXISTS (SELECT 1 FROM message_chunks WHERE message_id=messages.id); DELETE FROM message_chunks;");
  db.exec("UPDATE models SET route_key=model_id WHERE route_key=''; CREATE INDEX IF NOT EXISTS idx_models_route ON models(route_key);");
  db.exec(`CREATE TABLE IF NOT EXISTS route_attempts (id TEXT PRIMARY KEY, request_id TEXT, provider_id TEXT, model_id TEXT, outcome TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_attempts_request ON route_attempts(request_id,created_at);`);
  addColumns('route_attempts', { encrypted_detail: 'TEXT' });
  db.prepare("UPDATE messages SET status='error', error='服务重启导致回复中断，已保存的内容可以继续生成。' WHERE status='streaming'").run();
  db.prepare("UPDATE requests SET status='interrupted' WHERE status='running'").run();
  db.prepare("UPDATE route_attempts SET outcome='stopped', error='服务重启导致尝试中断。' WHERE outcome='running'").run();
  const defaults = { siteName: 'APIRouter', systemPrompt: '你是一个认真、可靠的 AI 助手。使用用户的语言回答。明确区分已经执行的操作与建议，不要声称使用了未提供的工具。', defaultModelId: null, dailyLimit: 100, maxOutputTokens: 4096, routingMaxAttempts: 6, retriesPerChannel: 1 };
  for (const [key, value] of Object.entries(defaults)) db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)').run(key, JSON.stringify(value));
  if (!db.prepare("SELECT 1 FROM settings WHERE key='reasoningOptionsMigrated'").get()) {
    for (const model of db.prepare('SELECT id,model_id FROM models').all()) {
      if (/^claude-(?:opus|sonnet)-5(?:-|$)|^gpt-6(?:-|$)/.test(model.model_id)) db.prepare("UPDATE models SET reasoning_efforts=? WHERE id=? AND reasoning_efforts='[]'").run(JSON.stringify(['low','medium','high','xhigh','max']), model.id);
    }
    db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run('reasoningOptionsMigrated', 'true');
  }
  return {
    db, dataDir,
    all: (sql, ...params) => db.prepare(sql).all(...params),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    run: (sql, ...params) => db.prepare(sql).run(...params),
    transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } },
    settings() { return Object.fromEntries(db.prepare('SELECT * FROM settings').all().map(row => [row.key, JSON.parse(row.value)])); },
    setSetting(key, value) { db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); },
    encrypt(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', masterKey, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), data].map(v => v.toString('base64')).join('.'); },
    decrypt(value) { const [iv, tag, data] = value.split('.').map(v => Buffer.from(v, 'base64')); const cipher = createDecipheriv('aes-256-gcm', masterKey, iv); cipher.setAuthTag(tag); return Buffer.concat([cipher.update(data), cipher.final()]).toString('utf8'); },
    close() { db.close(); }
  };
}
