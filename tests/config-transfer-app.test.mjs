import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createApp } from '../server/app.mjs';
import { digest, hashPassword } from '../server/store.mjs';
import { MAX_SKILL_BYTES } from '../runner/protocol.mjs';

const password = 'existing-admin-fixture-password', backupPassword = 'portable-large-config-passphrase';
const stamp = '2026-10-01T00:00:00.000Z';
async function serverFixture(t, name) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-config-http-'));
  const priorMaster = process.env.MASTER_KEY; delete process.env.MASTER_KEY;
  let instance;
  try { instance = createApp({ dataDir: directory, logger: { error() {} } }); }
  finally { if (priorMaster !== undefined) process.env.MASTER_KEY = priorMaster; }
  const { store } = instance, sessions = {};
  for (const role of ['admin', 'user']) {
    const token = randomBytes(32).toString('base64url'), userId = `${name}-${role}`;
    store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', userId, `${name} ${role}`, `${role}@example.com`, await hashPassword(password), role, stamp);
    store.run('INSERT INTO sessions(token,user_id,csrf,expires_at,persistent) VALUES(?,?,?,?,?)', digest(token), userId, `${name}-csrf`, '2099-01-01T00:00:00.000Z', 1);
    sessions[role] = token;
  }
  const server = createServer(instance.app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    instance.abortAll(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); instance.close();
    const path = realpathSync(directory); assert.ok(path.startsWith(realpathSync(tmpdir()) + sep) && path.includes('apirouter-config-http-')); rmSync(path, { recursive: true, force: true });
  });
  const request = (path, { method = 'GET', body, role = 'admin', csrf = true, headers = {} } = {}) => fetch(origin + path, { method, headers: {
    ...(sessions[role] ? { Cookie: `apirouter_session=${sessions[role]}` } : {}), ...(csrf ? { 'X-CSRF-Token': `${name}-csrf` } : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { store, directory, request, name };
}

test('real app imports authenticated configuration beyond the global 1 MiB parser without replacing sessions or colliding record IDs', async t => {
  const source = await serverFixture(t, 'large-source'), target = await serverFixture(t, 'large-target');
  assert.notDeepEqual(readFileSync(join(source.directory, 'master.key')), readFileSync(join(target.directory, 'master.key')));
  for (let index = 0; index < 22; index++) {
    const content = `# Skill ${index}\n\n${randomBytes(44000).toString('base64')}\n`;
    assert.ok(Buffer.byteLength(content) < MAX_SKILL_BYTES);
    source.store.run('INSERT INTO work_skills(id,name,description,content,created_at,updated_at) VALUES(?,?,?,?,?,?)', `source-skill-${index}`, `large-skill-${index}`, 'Large legal configuration fixture', content, stamp, stamp);
  }
  for (const f of [source, target]) {
    const key = `${f.name}-provider-private-key`;
    f.store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,created_at) VALUES(?,?,?,?,?,?,?)', 'same-provider-id', `${f.name} provider`, 'https://api.example.com/v1', 'openai-chat', f.store.encrypt(key), 'hint', stamp);
    f.store.run('INSERT INTO models(id,provider_id,model_id,name,route_key) VALUES(?,?,?,?,?)', 'same-model-id', 'same-provider-id', `${f.name}-native-model`, `${f.name} model`, `${f.name} route`);
    f.store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', 'same-user-id', `${f.name} separate user`, `${f.name}@example.com`, await hashPassword(`${f.name}-user-password`), 'user', stamp);
  }
  const exportedKey = `ar_sk_${randomBytes(32).toString('base64url')}`;
  source.store.run('INSERT INTO api_export_keys(id,name,token_hash,key_hint,enabled,model_ids,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', 'source-api-key', 'Portable API', digest(exportedKey), 'fixture', 1, '["same-model-id"]', 'large-source-admin', stamp);
  const preserved = {
    administrator: target.store.get('SELECT * FROM users WHERE id=?', 'large-target-admin'),
    user: target.store.get('SELECT * FROM users WHERE id=?', 'same-user-id'),
    provider: target.store.get('SELECT * FROM providers WHERE id=?', 'same-provider-id'),
    model: target.store.get('SELECT * FROM models WHERE id=?', 'same-model-id'),
    sessionTokens: target.store.all('SELECT token,user_id,csrf FROM sessions ORDER BY token'),
  };
  const exportResponse = await source.request('/api/admin/config/export', { method: 'POST', body: { currentPassword: password, password: backupPassword } });
  assert.equal(exportResponse.status, 200, await exportResponse.clone().text()); assert.match(exportResponse.headers.get('content-disposition') || '', /attachment/);
  const document = await exportResponse.json();
  const previewBody = { currentPassword: password, password: backupPassword, document };
  assert.ok(Buffer.byteLength(JSON.stringify(previewBody)) > 1024 * 1024, 'fixture must exceed the ordinary global JSON limit');
  for (const options of [{ role: '', expected: 401 }, { role: 'user', expected: 403 }, { csrf: false, expected: 403 }]) {
    const response = await target.request('/api/admin/config/preview', { method: 'POST', body: previewBody, ...options });
    assert.equal(response.status, options.expected, 'guards must run before accepting a large preview body');
  }
  const previewResponse = await target.request('/api/admin/config/preview', { method: 'POST', body: previewBody });
  assert.equal(previewResponse.status, 200, await previewResponse.clone().text()); const preview = await previewResponse.json();
  const imported = await target.request('/api/admin/config/import', { method: 'POST', body: { currentPassword: password, fingerprint: preview.fingerprint, confirmation: preview.confirmation } });
  assert.equal(imported.status, 200, await imported.clone().text()); assert.equal((await imported.json()).ok, true);
  assert.equal(target.store.get('SELECT COUNT(*) count FROM work_skills').count, 22);
  assert.deepEqual(target.store.get('SELECT * FROM users WHERE id=?', 'same-user-id'), preserved.user);
  assert.deepEqual(target.store.get('SELECT * FROM providers WHERE id=?', 'same-provider-id'), preserved.provider);
  assert.deepEqual(target.store.get('SELECT * FROM models WHERE id=?', 'same-model-id'), preserved.model);
  const admin = target.store.get('SELECT * FROM users WHERE id=?', 'large-target-admin');
  for (const key of ['id', 'password', 'role', 'disabled']) assert.equal(admin[key], preserved.administrator[key]);
  assert.deepEqual(target.store.all('SELECT token,user_id,csrf FROM sessions ORDER BY token'), preserved.sessionTokens);
  const sessionResponse = await target.request('/api/auth/session'); assert.equal(sessionResponse.status, 200); assert.equal((await sessionResponse.json()).user.id, 'large-target-admin');
  const sourceProvider = target.store.get('SELECT * FROM providers WHERE name=?', 'large-source provider'); assert.notEqual(sourceProvider.id, 'same-provider-id');
  assert.equal(target.store.decrypt(sourceProvider.encrypted_key), 'large-source-provider-private-key');
  const apiResponse = await target.request('/v1/models', { role: '', csrf: false, headers: { Authorization: `Bearer ${exportedKey}` } });
  assert.equal(apiResponse.status, 200); assert.deepEqual((await apiResponse.json()).data.map(row => row.id), ['large-source-native-model']);
  const copiedUser = target.store.get('SELECT * FROM users WHERE email=?', 'large-source@example.com'); assert.ok(copiedUser); assert.notEqual(copiedUser.id, 'same-user-id');
  const login = await target.request('/api/auth/login', { method: 'POST', role: '', csrf: false, body: { email: 'large-source@example.com', password: 'large-source-user-password' } });
  assert.equal(login.status, 200, await login.clone().text()); assert.equal((await login.json()).user.id, copiedUser.id);
});
