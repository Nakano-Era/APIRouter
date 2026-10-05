import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, lstat, realpath, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { claudeArguments, validateJob, validateSkill, safeRelativePath, MAX_ARTIFACTS, MAX_ARTIFACT_BYTES, MAX_ARTIFACT_TOTAL, MAX_JOB_BYTES, artifactPolicy, parseClaudeEvent } from './protocol.mjs';

export async function collectArtifacts(directory, limits = {}) {
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return [];
  const root = await realpath(directory);
  const files = [];
  let total = 0;
  const countLimit = limits.count ?? MAX_ARTIFACTS, totalLimit = limits.total ?? MAX_ARTIFACT_TOTAL;
  const skip = reason => { if (typeof limits.onSkip === 'function') limits.onSkip(reason); };
  const walk = async (relative = '', depth = 0) => {
    if (depth > 6) { skip('depth'); return; }
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      if (countLimit && files.length >= countLimit) { skip('count'); return; }
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      try { safeRelativePath(name); } catch { continue; }
      const target = join(root, name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) continue;
      const actual = await realpath(target);
      if (!actual.startsWith(root + sep)) continue;
      if (stat.isDirectory()) { await walk(name, depth + 1); continue; }
      if (!stat.isFile() || stat.nlink !== 1) continue;
      if (stat.size > (limits.bytes ?? MAX_ARTIFACT_BYTES)) { skip('size'); continue; }
      if (totalLimit && total + stat.size > totalLimit) { skip('total'); continue; }
      // O_NOFOLLOW plus fstat protects against a symlink swap while a background
      // process is still exiting. Exact size bounds prevent unbounded reads.
      let file;
      try {
        file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const checked = await file.stat();
        if (!checked.isFile() || checked.nlink !== 1 || checked.size !== stat.size || checked.ino !== stat.ino) continue;
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
          const result = await file.read(buffer, offset, buffer.length - offset, offset);
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        if (offset !== buffer.length) continue;
        total += buffer.length;
        files.push({ path: name, data: buffer.toString('base64') });
      } finally { await file?.close(); }
    }
  };
  await walk();
  return files;
}

export async function runWorker(input, { cwd = '/workspace', emit = event => process.stdout.write(JSON.stringify(event) + '\n'), spawnProcess = spawn, nativeRunner } = {}) {
  const job = validateJob(input);
  if (!/^http:\/\/gateway:3210\/proxy\/[a-f0-9]{32}$/.test(input.gateway) || !/^[A-Za-z0-9_-]{43}$/.test(input.jobToken)) throw new Error('Invalid per-job gateway');
  await mkdir(join(cwd, 'output'), { recursive: true });
  for (const file of job.files) {
    const target = join(cwd, safeRelativePath(file.path));
    await mkdir(resolve(target, '..'), { recursive: true });
    await writeFile(target, Buffer.from(file.data, 'base64'), { mode: 0o600, flag: 'wx' });
  }
  for (const skill of job.skills) {
    const checked = validateSkill(skill);
    const directory = join(cwd, '.claude', 'skills', checked.name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), checked.content, { mode: 0o600 });
  }
  const fileHashes = new Map();
  const warned = new Set();
  const snapshot = async () => {
    if (job.mode !== 'work') return;
    const skipped = new Set();
    for (const file of await collectArtifacts(join(cwd, 'output'), { ...artifactPolicy(job.limits), onSkip: reason => skipped.add(reason) })) {
      const hash = createHash('sha256').update(file.data).digest('hex');
      if (fileHashes.get(file.path) === hash) continue;
      await emit({ type: 'file', file }); fileHashes.set(file.path, hash);
    }
    for (const reason of skipped) if (!warned.has(reason)) {
      warned.add(reason);
      await emit({ type: 'activity', label: ({ count: `部分文件未保存：达到管理员设置的 ${job.limits.artifactMaxFiles} 个文件上限，可在 Work 设置中调整或设为 0。`, size: '部分文件未保存：单个文件超过 10 MB，请压缩或拆分。', total: `部分文件未保存：达到管理员设置的 ${job.limits.artifactTotalMb} MB 总量上限，可在 Work 设置中调整或设为 0。`, depth: '部分文件未保存：目录过深，请让 Work 将源码打成 ZIP。' })[reason] });
    }
  };
  if (job.engine === 'native') {
    const execute = nativeRunner ?? (await import('./native-agent.mjs')).runNativeAgent;
    try {
      await execute(job, { cwd, signal: AbortSignal.timeout(job.limits.timeoutSeconds * 1000), emit: async event => {
        // Save the workspace before acknowledging the corresponding tool journal.
        // A crash before this acknowledgement leaves a pending, never-replayed call.
        if (event.type === 'checkpoint') await snapshot();
        await emit(event);
      } });
    } catch (error) {
      await emit({ type: 'error', code: error.code || 'WORK_EXECUTION_FAILED', error: String(error.message || '工作任务中断，已保留进度。'),
        ...(Number.isInteger(error.status) ? { status: error.status } : {}),
        ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
        ...(error.rawDiagnostic ? { rawDiagnostic: error.rawDiagnostic } : {}),
        diagnostic: { rawBody: error.rawDiagnostic?.body || error.message, source: 'native-agent' } });
    } finally { await snapshot(); }
    await emit({ type: 'done' });
    return;
  }
  const state = { finished: false, streamed: false, tools: new Set() };
  let stderr = '';
  const child = spawnProcess('claude', claudeArguments(job), {
    cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    env: { PATH: process.env.PATH, HOME: '/home/node', LANG: 'C.UTF-8', TERM: 'dumb',
      ANTHROPIC_BASE_URL: input.gateway, ANTHROPIC_AUTH_TOKEN: input.jobToken,
      ANTHROPIC_DEFAULT_OPUS_MODEL: job.model, ANTHROPIC_DEFAULT_SONNET_MODEL: job.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: job.model, CLAUDE_CODE_SUBAGENT_MODEL: job.model,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(job.maxOutputTokens), API_TIMEOUT_MS: String(job.limits.timeoutSeconds * 1000) },
  });
  const exit = new Promise(resolveExit => { child.once('error', error => resolveExit({ code: null, error })); child.once('close', (code, signal) => resolveExit({ code, signal })); });
  const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
  const decoder = new StringDecoder('utf8'), errorDecoder = new StringDecoder('utf8');
  child.stderr.on('data', chunk => { if (stderr.length < 128 * 1024) stderr += errorDecoder.write(chunk).slice(0, 128 * 1024 - stderr.length); });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: job.prompt }, ...(job.images ?? [])] } }) + '\n');
  let buffer = '';
  try { for await (const chunk of child.stdout) {
    buffer += decoder.write(chunk);
    if (buffer.length > 4 * 1024 * 1024) throw new Error('Claude output line too large');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      for (const event of parseClaudeEvent(row, state)) await emit(event);
      if (row.type === 'user' && row.message?.content?.some?.(item => item.type === 'tool_result')) await snapshot();
    }
  } } catch (error) { killGroup(); await exit; throw error; }
  buffer += decoder.end();
  if (buffer.trim()) { try { for (const event of parseClaudeEvent(JSON.parse(buffer), state)) await emit(event); } catch {} }
  const result = await exit;
  // A task cannot leave a background child running while the file snapshot is read.
  killGroup();
  if (result.error) throw result.error;
  if (!state.finished) emit({ type: 'error', code: 'CLAUDE_EXECUTION_FAILED', error: 'Claude Code 未完成响应，请管理员检查运行日志。', diagnostic: { rawBody: stderr || `Claude exited with code ${result.code}, signal ${result.signal}`, source: 'claude-code' } });
  await snapshot();
  emit({ type: 'done' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    let input = ''; const decoder = new StringDecoder('utf8');
    for await (const chunk of process.stdin) { input += decoder.write(chunk); if (Buffer.byteLength(input) > MAX_JOB_BYTES) throw new Error('Task restore data exceeds the 512 MB transport limit'); }
    input += decoder.end();
    await runWorker(JSON.parse(input));
  } catch (error) {
    process.stdout.write(JSON.stringify({ type: 'error', code: 'WORKER_FAILED', error: '工作沙箱运行失败。', diagnostic: { rawBody: error.message, source: 'worker' } }) + '\n');
    process.exitCode = 1;
  }
}
