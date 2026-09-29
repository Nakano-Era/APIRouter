import path from 'node:path';
import { fork } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

// Bounds are deliberately independent of the browser-provided MIME type.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 30 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
const MAX_TEXT_CHARS = 200_000;
const MAX_PDF_PAGES = 100;
const PARSE_TIMEOUT_MS = 20_000;
const MAX_ACTIVE_PARSERS = 2;
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.log',
  '.yaml', '.yml', '.xml', '.html', '.htm', '.css', '.scss', '.less', '.js',
  '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.ipynb', '.rb', '.rs', '.go',
  '.java', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.sql', '.toml',
  '.ini', '.conf', '.vue', '.svelte', '.r', '.tex', '.dockerfile',
]);
const DOCUMENT_MIMES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const IMAGE_EXTENSIONS = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
};
let activeParsers = 0;

function uploadError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeName(originalname) {
  // Multipart filenames from browsers may be decoded as Latin-1 by Busboy.
  // Recover UTF-8 only when it is a valid round trip; direct Unicode stays intact.
  let displayName = String(originalname || '附件');
  if ([...displayName].every(char => char.charCodeAt(0) <= 255)) {
    try { displayName = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(displayName, 'latin1')); } catch {}
  }
  // The name is only a display value; callers must use their own storage ID.
  const name = displayName.replace(/\\/g, '/').split('/').pop()
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069<>:"|?*]/g, '')
    .replace(/^\.+|[. ]+$/g, '').trim();
  if (!name) return '附件';
  const extension = path.extname(name).slice(0, 20);
  return name.length > 180 ? `${name.slice(0, 180 - extension.length)}${extension}` : name;
}

function checkDimensions(width, height) {
  if (!width || !height || width > 12_000 || height > 12_000 || width * height > 20_000_000) {
    throw uploadError('图片尺寸过大或无效，最多支持 2000 万像素、单边 12000 像素。', 413);
  }
}

function sniffImage(buffer) {
  if (buffer.length >= 33 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') {
      throw uploadError('PNG 图片结构无效。');
    }
    checkDimensions(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
    return 'image/png';
  }
  if (buffer.length >= 13 && /^(GIF87a|GIF89a)$/.test(buffer.toString('ascii', 0, 6))) {
    checkDimensions(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
    return 'image/gif';
  }
  if (buffer.length >= 12 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset++] !== 0xff) break;
      while (buffer[offset] === 0xff) offset++;
      const marker = buffer[offset++];
      if (marker === 0xd9 || marker === 0xda || offset + 2 > buffer.length) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) break;
        checkDimensions(buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
        return 'image/jpeg';
      }
      offset += length;
    }
    throw uploadError('JPEG 图片结构无效。');
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    if (buffer.readUInt32LE(4) + 8 !== buffer.length) throw uploadError('WebP 图片结构无效。');
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X' && buffer.readUInt32LE(16) === 10) {
      checkDimensions(buffer.readUIntLE(24, 3) + 1, buffer.readUIntLE(27, 3) + 1);
    } else if (chunk === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      checkDimensions(buffer.readUInt16LE(26) & 0x3fff, buffer.readUInt16LE(28) & 0x3fff);
    } else if (chunk === 'VP8L' && buffer[20] === 0x2f) {
      const bits = buffer.readUInt32LE(21);
      checkDimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else {
      throw uploadError('WebP 图片结构无效。');
    }
    return 'image/webp';
  }
  return null;
}

function boundedText(text) {
  if (text.length > MAX_TEXT_CHARS) {
    throw uploadError('提取的文字超过 20 万字符，请拆分文件后上传。', 413);
  }
  return text;
}

function decodeText(buffer) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw uploadError('文本文件必须使用 UTF-8 编码，不能包含二进制内容。');
  }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) {
    throw uploadError('文件包含二进制内容，不能作为文本上传。');
  }
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) {
    throw uploadError('暂不支持 SVG，请转换为 PNG 或 JPEG。');
  }
  return boundedText(text);
}

// Never pass an unchecked ZIP to a document library. Verify the directory and
// each local header, then independently inflate with a hard output bound. This
// catches archives whose claimed uncompressed sizes have been forged.
function validateOfficeArchive(buffer, extension) {
  const invalid = () => uploadError('Office 文件结构无效或包含不安全的压缩内容。');
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw invalid();
  let end = -1;
  for (let position = buffer.length - 22; position >= Math.max(0, buffer.length - 65_557); position--) {
    if (buffer.readUInt32LE(position) === 0x06054b50 && position + 22 + buffer.readUInt16LE(position + 20) === buffer.length) {
      end = position;
      break;
    }
  }
  if (end < 0) throw invalid();
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  const centralStart = buffer.readUInt32LE(end + 16);
  if (count > MAX_ZIP_ENTRIES) throw uploadError('Office 文件内部条目过多，请精简后上传。', 413);
  if (!count || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)
      || buffer.readUInt16LE(end + 8) !== count || centralStart + centralSize !== end) throw invalid();
  let cursor = centralStart;
  let expandedTotal = 0;
  const names = new Set();
  const ranges = [];
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const expanded = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localStart = buffer.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > end || !nameLength || (flags & ~0x080e) || ![0, 8].includes(method)
        || buffer.readUInt16LE(cursor + 34) !== 0 || ((buffer.readUInt32LE(cursor + 38) >>> 16) & 0xf000) === 0xa000) throw invalid();
    let name;
    const nameBytes = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes); } catch { throw invalid(); }
    if (/[\\:\u0000-\u001f\u007f]/.test(name) || name.startsWith('/')
        || name.split('/').some((part) => part === '..' || part === '.') || names.has(name.toLowerCase())) throw invalid();
    names.add(name.toLowerCase());
    if (/vbaproject|(^|\/)embeddings\/|(^|\/)externallinks\//i.test(name)) {
      throw uploadError('暂不支持包含宏、嵌入对象或外部数据连接的 Office 文件。');
    }
    expandedTotal += expanded;
    if (expandedTotal > MAX_EXPANDED_BYTES) throw uploadError('Office 文件解压后超过 30MB，请精简后上传。', 413);
    if (localStart + 30 > centralStart || buffer.readUInt32LE(localStart) !== 0x04034b50) throw invalid();
    const localNameLength = buffer.readUInt16LE(localStart + 26);
    const localExtraLength = buffer.readUInt16LE(localStart + 28);
    const dataStart = localStart + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressed;
    if (dataEnd > centralStart || buffer.readUInt16LE(localStart + 6) !== flags
        || buffer.readUInt16LE(localStart + 8) !== method || localNameLength !== nameLength
        || !buffer.subarray(localStart + 30, localStart + 30 + localNameLength).equals(nameBytes)) throw invalid();
    if (!(flags & 8) && (buffer.readUInt32LE(localStart + 18) !== compressed || buffer.readUInt32LE(localStart + 22) !== expanded)) throw invalid();
    ranges.push([localStart, dataEnd]);
    entries.push({ name, method, expanded, dataStart, dataEnd });
    cursor = recordEnd;
  }
  if (cursor !== end || !names.has('[content_types].xml')
      || !names.has(extension === '.docx' ? 'word/document.xml' : 'xl/workbook.xml')) throw invalid();
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw invalid();
  for (const entry of entries) {
    let data;
    try {
      const compressed = buffer.subarray(entry.dataStart, entry.dataEnd);
      data = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.expanded + 1) });
    } catch { throw invalid(); }
    if (data.length !== entry.expanded) throw invalid();
    if (/\.(xml|rels)$/i.test(entry.name)) {
      const xml = data.toString('utf8');
      if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(xml) || data.includes(0)) throw invalid();
    }
  }
}

async function extractDocument(buffer, extension) {
  if (extension === '.pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({
      data: new Uint8Array(buffer), verbosity: 0, isEvalSupported: false,
      useWasm: false, useSystemFonts: false, disableFontFace: true,
      maxImageSize: 0, useWorkerFetch: false,
    });
    try {
      const info = await parser.getInfo();
      if (info.total > MAX_PDF_PAGES) throw uploadError('PDF 超过 100 页，请拆分后上传。', 413);
      let text = '';
      for (let page = 1; page <= info.total; page++) {
        const result = await parser.getText({ partial: [page], parseHyperlinks: false, pageJoiner: '' });
        text += result.text;
        boundedText(text);
      }
      if (!text.trim()) throw uploadError('PDF 中没有可提取的文字，暂不支持扫描件 OCR。');
      return text.trim();
    } finally {
      await parser.destroy();
    }
  }
  validateOfficeArchive(buffer, extension);
  if (extension === '.docx') {
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    if (!result.value.trim()) throw uploadError('Word 文件中没有可提取的文字。');
    return boundedText(result.value.trim());
  }
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer, { ignoreNodes: [
    'picture', 'drawing', 'extLst', 'conditionalFormatting', 'dataValidations',
    'hyperlinks', 'mergeCells', 'cols', 'sheetViews', 'sheetProtection',
  ] });
  if (workbook.worksheets.length > 100) throw uploadError('表格超过 100 个工作表，请拆分后上传。', 413);
  let text = '说明：下列为工作表中的文字及已缓存的公式结果，未重新计算公式，也未提取图片或图表。\n';
  let cellCount = 0;
  let rowCount = 0;
  for (const sheet of workbook.worksheets) {
    text += `\n工作表：${sheet.name}\n`;
    sheet.eachRow((row, rowNumber) => {
      if (++rowCount > 10_000) throw uploadError('表格超过 10000 行，请拆分后上传。', 413);
      const cells = [];
      row.eachCell((cell, columnNumber) => {
        if (++cellCount > 50_000 || columnNumber > 1000) throw uploadError('表格单元格过多或列跨度过大，请拆分后上传。', 413);
        // Cell references preserve sparse columns without allocating a giant row.
        const value = (cell.formula && cell.result === undefined)
          ? `[公式未缓存结果：${cell.formula}]` : cell.text;
        cells.push(`${cell.address}=${String(value).replace(/[\r\n\t]/g, ' ')}`);
      });
      text += `第 ${rowNumber} 行\t${cells.join('\t')}\n`;
      boundedText(text);
    });
  }
  if (!cellCount) throw uploadError('表格中没有可提取的单元格内容。');
  return boundedText(text.trim());
}

async function parseInProcess(buffer, extension) {
  if (activeParsers >= MAX_ACTIVE_PARSERS) throw uploadError('当前正在处理其他文件，请稍后重试。', 429);
  activeParsers++;
  let parser;
  try {
    parser = fork(new URL(import.meta.url), ['--extract-upload-parser'], {
      // Native PDF dependencies can crash a worker thread's entire process.
      // A child process isolates parser crashes and has a bounded JS heap.
      // This is a resource boundary, not an OS permission sandbox.
      execArgv: ['--max-old-space-size=192', '--max-semi-space-size=16'],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      env: Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG']
        .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])),
    });
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(uploadError('文件解析超时，请拆分或简化文件后重试。', 413)), PARSE_TIMEOUT_MS);
      timeout.unref();
      const complete = (fn, value) => { clearTimeout(timeout); fn(value); };
      parser.once('message', (message) => {
        if (message.ok) complete(resolve, message.text);
        else complete(reject, uploadError(message.message, message.status));
      });
      parser.once('error', () => complete(reject, uploadError('文件解析失败或超出资源限制，请检查文件或拆分后重试。')));
      parser.once('exit', () => {
        complete(reject, uploadError('文件解析失败或超出资源限制，请拆分后重试。', 413));
      });
      parser.send({ buffer, extension }, (error) => {
        if (error) complete(reject, uploadError('文件解析进程无法启动，请稍后重试。', 503));
      });
    });
  } finally {
    if (parser && parser.exitCode === null) parser.kill('SIGKILL');
    activeParsers--;
  }
}

/** Extract an uploaded file without trusting a path or MIME supplied by a client. */
export async function extractUpload({ buffer, originalname, mimetype }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw uploadError('不能上传空文件。');
  if (buffer.length > MAX_FILE_BYTES) throw uploadError('单个文件不能超过 10MB。', 413);
  const name = safeName(originalname);
  const extension = path.extname(name).toLowerCase();
  const declaredMime = String(mimetype || '').split(';', 1)[0].trim().toLowerCase();
  if (extension === '.svg' || declaredMime === 'image/svg+xml') throw uploadError('暂不支持 SVG，请转换为 PNG 或 JPEG。');
  const imageMime = sniffImage(buffer);
  if (imageMime) {
    if (IMAGE_EXTENSIONS[extension] !== imageMime) throw uploadError('图片扩展名与实际格式不一致。');
    return { name, mime: imageMime, size: buffer.length, kind: 'image', buffer };
  }
  if (IMAGE_EXTENSIONS[extension] || declaredMime.startsWith('image/')) throw uploadError('图片格式或文件签名无效，仅支持 PNG、JPEG、WebP 和 GIF。');
  if (DOCUMENT_MIMES[extension]) {
    if (extension === '.pdf' && !/^%PDF-\d\.\d/.test(buffer.toString('ascii', 0, 8))) throw uploadError('PDF 文件签名无效。');
    const text = await parseInProcess(buffer, extension);
    return { name, mime: DOCUMENT_MIMES[extension], size: buffer.length, kind: 'text', text, buffer };
  }
  if (!TEXT_EXTENSIONS.has(extension) && !['Dockerfile', 'Makefile'].includes(name)) {
    throw uploadError('暂不支持此文件类型。请上传文本、PDF、DOCX、XLSX 或 PNG/JPEG/WebP/GIF 图片。');
  }
  if (/^%PDF-\d\.\d/.test(buffer.toString('ascii', 0, 8))
      || buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      || buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      || buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    throw uploadError('文件实际为二进制文档或程序，请使用正确的文件格式与扩展名。');
  }
  const text = decodeText(buffer);
  return { name, mime: 'text/plain', size: buffer.length, kind: 'text', text, buffer };
}

if (process.argv[2] === '--extract-upload-parser' && process.send) {
  process.once('message', async ({ buffer, extension }) => {
    let message;
    try {
      const text = await extractDocument(Buffer.from(buffer), extension);
      message = { ok: true, text };
    } catch (error) {
      message = {
        ok: false,
        message: error.status ? error.message : '文件解析失败，请确认文件完整、未加密且格式正确。',
        status: error.status || 400,
      };
    }
    process.send(message, () => process.exit(0));
  });
}
