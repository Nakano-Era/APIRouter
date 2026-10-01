import test from 'node:test';
import assert from 'node:assert/strict';
import { artifactArchiveUrl, artifactDownloadUrl, resolveArtifactLink, fetchArtifactDownload } from '../src/lib/artifact-downloads.ts';

const artifact = (id, path, chatId = 'this-chat') => ({ id, path, name: path.split('/').at(-1), chatId, size: 10, downloadUrl: `/api/work/chats/${chatId}/artifacts/${id}/download` });
const files = [artifact('source-id', '源码/index.js'), artifact('report-id', 'report.svg')];

test('model-written sandbox, workspace and relative links resolve to persisted conversation artifacts', () => {
  for (const prefix of ['sandbox:/mnt/data/', 'sandbox:/workspace/output/', '/workspace/output/', '/mnt/data/', 'output/', './output/', '']) {
    const resolved = resolveArtifactLink(prefix + encodeURI('源码/index.js'), files);
    assert.equal(resolved.kind, 'file'); assert.equal(resolved.url, files[0].downloadUrl); assert.equal(resolved.name, 'index.js');
  }
  assert.equal(resolveArtifactLink(files[0].downloadUrl, files).kind, 'file');
  assert.deepEqual(resolveArtifactLink('output/源码/', files), { kind: 'archive', url: '/api/work/chats/this-chat/artifacts/download?path=%E6%BA%90%E7%A0%81', name: '源码.zip' });
});

test('model links cannot fetch another conversation, escape output, or claim nonexistent files', () => {
  for (const path of ['output/missing.zip', 'sandbox:/mnt/data/missing.zip', '/api/work/chats/other-chat/artifacts/source-id/download', '/api/work/artifacts/source-id/download', 'sandbox:/mnt/data/../report.svg', 'output/%2E%2E/report.svg', 'output/a\\b', 'file:///etc/passwd', 'javascript:alert(1)', '//evil.example/report.svg', 'output/.env', 'output/a%00.svg', '/workspace/private.txt']) assert.equal(resolveArtifactLink(path, files).kind, 'missing', path);
  assert.equal(resolveArtifactLink('https://app.example/api/work/artifacts/other-id/download', files, 'https://app.example').kind, 'missing');
  assert.equal(resolveArtifactLink('https://app.example/API/work/artifacts/other-id/download', files, 'https://app.example').kind, 'missing');
  assert.equal(resolveArtifactLink(`https://app.example${files[0].downloadUrl}`, files, 'https://app.example').kind, 'file');
  assert.equal(resolveArtifactLink('https://example.com/download.zip', files).kind, 'external');
  assert.equal(artifactArchiveUrl([files[0], artifact('other', 'b.js', 'other-chat')]), null);
  assert.equal(artifactDownloadUrl({ id: 'fake', downloadUrl: '/api/admin/secrets' }), null);
});

test('same basename in different source directories never downloads the wrong file', () => {
  const duplicates = [artifact('one', 'a/index.js'), artifact('two', 'b/index.js')];
  assert.equal(resolveArtifactLink('sandbox:/mnt/data/index.js', duplicates).kind, 'missing');
  assert.equal(resolveArtifactLink('output/b/index.js', duplicates).url, duplicates[1].downloadUrl);
  const old = { id: 'legacy', name: 'source.zip', downloadUrl: '/api/work/artifacts/legacy/download' };
  assert.equal(resolveArtifactLink('sandbox:/mnt/data/source.zip', [old]).url, old.downloadUrl);
});

test('download client preserves attachment bytes and reports authentication, missing file and SPA errors', async () => {
  let init;
  const blob = await fetchArtifactDownload(files[0].downloadUrl, async (_url, options) => { init = options; return new Response('真实源码\n', { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="index.js"' } }); });
  assert.equal(await blob.text(), '真实源码\n'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.redirect, 'error');
  await assert.rejects(fetchArtifactDownload(files[0].downloadUrl, async () => Response.json({ error: '登录失效' }, { status: 401 })), /登录已过期/);
  await assert.rejects(fetchArtifactDownload(files[0].downloadUrl, async () => Response.json({ error: '文件已删除' }, { status: 404 })), /文件已删除/);
  await assert.rejects(fetchArtifactDownload(files[0].downloadUrl, async () => new Response('<html>SPA index</html>')), /未返回可下载文件/);
  await assert.rejects(fetchArtifactDownload('https://example.com/file', async () => { throw new Error('must not fetch'); }), /地址无效/);
});

test('download client stops oversized responses and never downloads a truncated archive', async () => {
  const large = new Response(new Uint8Array(32 * 1024 * 1024 + 1), { headers: { 'content-disposition': 'attachment' } });
  await assert.rejects(fetchArtifactDownload('/api/work/chats/this-chat/artifacts/download', async () => large), /超过 32 MB/);
});
