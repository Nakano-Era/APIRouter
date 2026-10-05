import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createApp } from '../server/app.mjs';
import { createConfigTransfer, decryptConfigExport, encryptConfigExport } from '../server/config-transfer.mjs';
import { hashPassword, now } from '../server/store.mjs';
import { modelRouteId } from '../server/model-catalog.mjs';

const currentPassword = 'configuration-regression-password';
const backupPassword = 'configuration-regression-backup';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'apirouter-config-regression-'));
  const app = createApp({ dataDir: directory, logger: { error() {} } });
  app.store.run('INSERT INTO users(id,name,email,password,role,created_at) VALUES(?,?,?,?,?,?)', 'admin', 'Admin', 'admin@example.com', await hashPassword(currentPassword), 'admin', now());
  const transfer = createConfigTransfer({ store: app.store });
  t.after(() => {
    transfer.close(); app.close();
    const safe = realpathSync(directory);
    assert.ok(safe.startsWith(realpathSync(tmpdir()) + sep) && safe.includes('apirouter-config-regression-'));
    rmSync(safe, { recursive: true, force: true });
  });
  return { ...app, transfer };
}

test('a default model removed with its upstream provider does not make an otherwise valid configuration unimportable', async t => {
  const source = await fixture(t), target = await fixture(t);
  const { store } = source;
  store.run('INSERT INTO providers(id,name,base_url,protocol,encrypted_key,key_hint,created_at) VALUES(?,?,?,?,?,?,?)', 'provider', 'Fixture provider', 'https://example.com/v1', 'openai-chat', store.encrypt('sk-fixture-only'), 'only', now());
  store.run('INSERT INTO models(id,provider_id,model_id,name,route_key) VALUES(?,?,?,?,?)', 'model', 'provider', 'upstream-model', 'Display model', 'Display model');
  store.setSetting('defaultModelId', modelRouteId('Display model'));
  // This is the same cascade used by DELETE /api/admin/providers/:id.
  store.run('DELETE FROM providers WHERE id=?', 'provider');
  const document = await source.transfer.exportConfig({ currentPassword, password: backupPassword }, 'admin');
  const plaintext = await decryptConfigExport(document, backupPassword);
  assert.equal(JSON.parse(plaintext.tables.settings.find(row => row.key === 'defaultModelId').value), null);
  assert.equal(store.settings().defaultModelId, modelRouteId('Display model'));
  const preview = await target.transfer.previewConfig({ currentPassword, password: backupPassword, document }, 'admin');
  await target.transfer.importConfig({ currentPassword, fingerprint: preview.fingerprint, confirmation: preview.confirmation }, 'admin');
  assert.equal(target.store.settings().defaultModelId, null);
});

test('older exported configuration with a stale default is imported with a clear preview warning', async t => {
  const source = await fixture(t), target = await fixture(t);
  const exported = await source.transfer.exportConfig({ currentPassword, password: backupPassword }, 'admin');
  const plaintext = await decryptConfigExport(exported, backupPassword);
  plaintext.tables.settings.find(row => row.key === 'defaultModelId').value = JSON.stringify(modelRouteId('Deleted upstream'));
  const document = await encryptConfigExport(plaintext, backupPassword);
  const preview = await target.transfer.previewConfig({ currentPassword, password: backupPassword, document }, 'admin');
  assert.ok(preview.warnings.some(value => value.includes('默认模型已不存在')));
  await target.transfer.importConfig({ currentPassword, fingerprint: preview.fingerprint, confirmation: preview.confirmation }, 'admin');
  assert.equal(target.store.settings().defaultModelId, null);
});
