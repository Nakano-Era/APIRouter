import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { extractUpload } from '../server/files.mjs';

// ExcelJS's declared ZIP dependency builds real OOXML fixtures, without adding
// another application dependency just for test data.
const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX2QAAAAASUVORK5CYII=', 'base64');
const upload = (buffer, originalname, mimetype = 'application/octet-stream') => extractUpload({ buffer, originalname, mimetype });

async function docx(text = '你好，文件助手') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip;
}

async function zipBuffer(zip) {
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function centralRecords(buffer) {
  const records = [];
  for (let offset = 0; offset + 46 < buffer.length; offset++) {
    if (buffer.readUInt32LE(offset) === 0x02014b50) records.push(offset);
  }
  return records;
}

function pdfFixture(text = 'A readable PDF') {
  const content = text ? `BT /F1 18 Tf 40 160 Td (${text}) Tj ET` : '';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(output));
    output += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const start = Buffer.byteLength(output);
  output += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(output);
}

test('UTF-8 content, display filename sanitization and original bytes are preserved', async () => {
  const buffer = Buffer.from('\uFEFF你好，世界\nprint("hello")');
  const result = await upload(buffer, '..\\private\\\u202E报告\u0000.py');
  assert.equal(result.name, '报告.py');
  assert.equal(result.text, '你好，世界\nprint("hello")');
  assert.equal(result.mime, 'text/plain');
  assert.equal(result.kind, 'text');
  assert.equal(result.buffer, buffer);
});

test('rejects empty files, oversized raw inputs and excess extracted text', async () => {
  await assert.rejects(upload(Buffer.alloc(0), 'empty.txt'), /空文件/);
  await assert.rejects(upload(Buffer.alloc(10 * 1024 * 1024 + 1), 'huge.txt'), (e) => e.status === 413 && /10MB/.test(e.message));
  await assert.rejects(upload(Buffer.from('a'.repeat(200_001)), 'long.txt'), (e) => e.status === 413 && /20 万/.test(e.message));
});

test('rejects binary masquerading, invalid UTF-8, and unsupported active formats', async () => {
  await assert.rejects(upload(Buffer.from([0x4d, 0x5a, 0, 1, 2]), 'safe.txt'), /二进制/);
  await assert.rejects(upload(Buffer.from([0x66, 0x80, 0x6f]), 'invalid.txt'), /UTF-8/);
  await assert.rejects(upload(pdfFixture(), 'disguised.txt'), /二进制文档/);
  await assert.rejects(upload(Buffer.from('not really a pdf'), 'fake.pdf'), /PDF 文件签名/);
  await assert.rejects(upload(Buffer.from('some program'), 'program.exe'), /暂不支持此文件类型/);
  await assert.rejects(upload(Buffer.from('<svg onload="alert(1)"></svg>'), 'picture.svg'), /SVG/);
  await assert.rejects(upload(Buffer.from('<svg onload="alert(1)"></svg>'), 'picture.txt'), /SVG/);
});

test('uses actual image signatures and dimensions instead of declared MIME', async () => {
  const result = await upload(PNG, 'tiny.png', 'application/octet-stream');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.kind, 'image');
  await assert.rejects(upload(Buffer.from('<html><script>alert(1)</script>'), 'fake.png', 'image/png'), /签名无效/);
  await assert.rejects(upload(PNG, 'fake.jpg', 'image/jpeg'), /扩展名/);
  await assert.rejects(upload(PNG, 'fake.txt'), /扩展名/);
  const gigantic = Buffer.from(PNG);
  gigantic.writeUInt32BE(100_000, 16);
  await assert.rejects(upload(gigantic, 'huge.png'), (e) => e.status === 413 && /图片尺寸/.test(e.message));
});

test('extracts real DOCX as plain text in an isolated parser', async () => {
  const result = await upload(await zipBuffer(await docx()), '报告.docx');
  assert.equal(result.text, '你好，文件助手');
  assert.equal(result.kind, 'text');
  assert.equal(result.mime, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});

test('extracts XLSX sheets with sparse coordinates and cached formula results', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('费用');
  sheet.addRow(['项目', '金额']);
  sheet.addRow(['服务器', 120]);
  sheet.getCell('D3').value = { formula: 'B2*2', result: 240 };
  sheet.getCell('D4').value = { formula: 'B2*3' };
  const result = await upload(Buffer.from(await workbook.xlsx.writeBuffer()), '预算.xlsx');
  assert.match(result.text, /工作表：费用/);
  assert.match(result.text, /A2=服务器\tB2=120/);
  assert.match(result.text, /D3=240/);
  assert.match(result.text, /D4=\[公式未缓存结果：B2\*3\]/);
  assert.match(result.text, /未重新计算公式/);
});

test('extracts PDF text and explicitly rejects files needing OCR', async () => {
  const result = await upload(pdfFixture(), 'readable.pdf');
  assert.match(result.text, /A readable PDF/);
  await assert.rejects(upload(pdfFixture(''), 'scan.pdf'), /OCR/);
});

test('rejects ZIP bombs declared in the directory before document parsing', async () => {
  const buffer = await zipBuffer(await docx());
  const position = centralRecords(buffer)[0];
  buffer.writeUInt32LE(31 * 1024 * 1024, position + 24);
  await assert.rejects(upload(buffer, 'bomb.docx'), (e) => e.status === 413 && /30MB/.test(e.message));
});

test('rejects forged smaller ZIP sizes using bounded actual inflation', async () => {
  const buffer = await zipBuffer(await docx('x'.repeat(100_000)));
  const position = centralRecords(buffer).find((offset) => {
    const length = buffer.readUInt16LE(offset + 28);
    return buffer.toString('utf8', offset + 46, offset + 46 + length) === 'word/document.xml';
  });
  const local = buffer.readUInt32LE(position + 42);
  buffer.writeUInt32LE(100, position + 24);
  buffer.writeUInt32LE(100, local + 22);
  await assert.rejects(upload(buffer, 'forged.docx'), /不安全的压缩内容/);
});

test('rejects archive traversal, macro payloads and XML entities', async () => {
  const traversal = await docx();
  traversal.file('../escape.txt', 'no', { createFolders: false });
  await assert.rejects(upload(await zipBuffer(traversal), 'traversal.docx'), /不安全的压缩内容/);
  const macros = await docx();
  macros.file('word/vbaProject.bin', 'payload');
  await assert.rejects(upload(await zipBuffer(macros), 'macro.docx'), /宏/);
  const entities = await docx();
  entities.file('word/document.xml', '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>');
  await assert.rejects(upload(await zipBuffer(entities), 'entity.docx'), /不安全的压缩内容/);
});

test('rejects office archives with too many entries and wrong container content', async () => {
  const many = await docx();
  for (let i = 0; i < 2000; i++) many.file(`extra${i}.txt`, '');
  await assert.rejects(upload(await zipBuffer(many), 'many.docx'), (e) => e.status === 413 && /条目过多/.test(e.message));
  await assert.rejects(upload(await zipBuffer(await docx()), 'renamed.xlsx'), /结构无效/);
});

test('rejects overlong extracted document text instead of silently truncating it', async () => {
  await assert.rejects(upload(await zipBuffer(await docx('a'.repeat(200_001))), 'long.docx'), (e) => e.status === 413 && /20 万/.test(e.message));
});
