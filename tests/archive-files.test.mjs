import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { extractUpload } from '../server/files.mjs';

const Zip = createRequire(import.meta.resolve('exceljs'))('jszip');
const upload = (buffer, name) => extractUpload({ buffer, originalname: name });
async function zip(entries) { const z = new Zip(); for (const [name, data, options] of entries) z.file(name, data, options); return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); }
function tar(name, body, type = '0', link = '') {
  body = Buffer.from(body); const header = Buffer.alloc(512);
  header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136); header.fill(32, 148, 156);
  header.write(type, 156); header.write(link, 157, 100); header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((n, byte) => n + byte, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512 + 1024)]);
}

test('ZIP source preview preserves Unicode paths, source text, binary inventory and original bytes', async () => {
  const source = await zip([['项目/main.py', 'print("hello")'], ['nested/config.json', '{"enabled":true}'], ['image.bin', Buffer.from([0, 255, 1])]]);
  const result = await upload(source, '项目源码.ZIP');
  assert.equal(result.kind, 'archive'); assert.equal(result.mime, 'application/zip'); assert.equal(result.buffer, source);
  assert.match(result.text, /项目\/main.py/); assert.match(result.text, /print\("hello"\)/); assert.match(result.text, /enabled/); assert.match(result.text, /image.bin/);
});

test('TAR, TAR.GZ, TGZ, GZ and Zstandard previews read regular text without writing host files', async () => {
  const source = tar('folder/a.txt', 'hello archive');
  for (const [name, data] of [['a.tar', source], ['a.tar.gz', gzipSync(source)], ['a.tgz', gzipSync(source)], ['a.tar.zst', zstdCompressSync(source)], ['a.tzst', zstdCompressSync(source)], ['plain.txt.gz', gzipSync(Buffer.from('hello archive'))], ['plain.txt.zst', zstdCompressSync(Buffer.from('hello archive'))]]) {
    const result = await upload(data, name); assert.equal(result.kind, 'archive', name); assert.match(result.text, /hello archive/, name);
  }
});

test('large textual entries get bounded, explicit previews while the original remains available', async () => {
  const entries = Array.from({ length: 12 }, (_, i) => [`src/${i}.js`, 'const example=1;\n'.repeat(6000)]);
  const result = await upload(await zip(entries), 'large-source.zip');
  assert.ok(result.text.length <= 200_000); assert.match(result.text, /截断|限制/); assert.equal(result.kind, 'archive');
});

test('archive signature mismatch, traversal and expansion bombs are rejected; links are never followed', async () => {
  await assert.rejects(upload(Buffer.from('fake'), 'fake.zip'), /签名/);
  await assert.rejects(upload(tar('../outside.txt', 'danger'), 'traversal.tar'), /不安全/);
  assert.match((await upload(tar('link', '', '2', '/etc/passwd'), 'link.tar')).text, /未读取或解压/);
  assert.match((await upload(tar('hardlink', '', '1', 'other'), 'hardlink.tar')).text, /未读取或解压/);
  await assert.rejects(upload(await zip([['bomb.txt', 'x'.repeat(31 * 1024 * 1024)]]), 'bomb.zip'), error => error.status === 413);
  await assert.rejects(upload(gzipSync(Buffer.alloc(31 * 1024 * 1024)), 'bomb.gz'), error => error.status === 413);
});

test('generic binary files and SVG source can upload without being rendered as active images', async () => {
  const binary = Buffer.from([0, 255, 1, 2]);
  for (const name of ['data.sqlite', 'presentation.pptx', 'music.mp3', 'custom.blob']) {
    const result = await upload(binary, name); assert.equal(result.kind, 'file'); assert.equal(result.buffer, binary); assert.match(result.text, /无法直接读取二进制/);
  }
  const svg = await upload(Buffer.from('<svg onload="alert(1)"></svg>'), 'diagram.svg');
  assert.equal(svg.kind, 'text'); assert.equal(svg.mime, 'text/plain'); assert.match(svg.text, /<svg/);
  const text = await upload(Buffer.from('some useful content'), 'custom.unknown'); assert.equal(text.kind, 'text');
});

for (const name of ['a.tar.bz2', 'a.tar.xz', 'lzma2.7z', 'v4.rar', 'v5.rar']) test(`${name} previews actual archive text and retains binary original`, async () => {
  const source = readFileSync(new URL(`./fixtures/archives/${name}`, import.meta.url));
  const result = await upload(source, name);
  assert.equal(result.kind, 'archive'); assert.equal(result.buffer, source);
  assert.match(result.text, /# example/); assert.match(result.text, /README.md/);
});

for (const name of ['v4-encrypted.rar', 'deflate-encrypted.zip']) test(`${name} preserves an encrypted original with an explicit preview limitation`, async () => {
  const source = readFileSync(new URL(`./fixtures/archives/${name}`, import.meta.url));
  const result = await upload(source, name);
  assert.equal(result.kind, 'archive'); assert.equal(result.buffer, source); assert.match(result.text, /加密/);
});
