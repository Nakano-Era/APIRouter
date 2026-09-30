import { spawn } from 'node:child_process';
import { mkdir, lstat, realpath, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative, sep, dirname } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const string = description => ({ type: 'string', description });
export const NATIVE_TOOLS = [
  { name: 'read_file', description: 'Read a UTF-8 file inside the isolated workspace. Results are bounded; use offset and limit for large files.', parameters: object({ path: string('Relative workspace path'), offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 65536 } }, ['path']) },
  { name: 'write_file', description: 'Create or replace a UTF-8 file in the workspace. Save final downloads under output/. Only report success after this tool succeeds.', parameters: object({ path: string('Relative workspace path, for example output/report.svg'), content: string('Complete UTF-8 file contents') }, ['path', 'content']) },
  { name: 'list_files', description: 'List workspace files and sizes, including existing output files before resuming an interrupted task.', parameters: object({ path: string('Relative directory, or . for the workspace'), recursive: { type: 'boolean' } }, []) },
  { name: 'run_command', description: 'Run a shell command inside the isolated Docker workspace. Python and installed packages are available. There is no unrestricted network access. Commands and their output are bounded.', parameters: object({ command: string('Shell command to execute'), timeoutSeconds: { type: 'integer', minimum: 1, maximum: 120 } }, ['command']) },
  { name: 'use_skill', description: 'Load the instructions of one of the selected skills. Read and follow these instructions to complete the user task.', parameters: object({ name: string('Selected skill name') }, ['name']) },
  { name: 'delegate_task', description: 'Delegate a bounded subtask to another instance of the selected model sharing this sandbox. It can read and create files but cannot delegate again. Give a specific task and inspect its result.', parameters: object({ task: string('Concrete subtask with expected result') }, ['task']) },
];

function boundedInteger(value, fallback, min, max) { return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback; }
const toolError = message => Object.assign(new Error(message), { code: 'WORK_TOOL_ERROR' });

// These checks protect file tools. Shell commands are isolated by Docker, not by
// this path helper; the worker never mounts the host filesystem or Docker socket.
export async function workspacePath(cwd, name, { directory = false, missing = false } = {}) {
  if (typeof name !== 'string' || name.length > 1024 || /[\u0000-\u001f]/.test(name) || /^[a-z]:/i.test(name) || name.startsWith('/') || name.startsWith('\\')) throw toolError('Use a relative workspace path.');
  const root = await realpath(cwd), target = resolve(root, name || '.');
  if (target !== root && !target.startsWith(root + sep)) throw toolError('Path escapes the workspace.');
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    if (part === '..') throw toolError('Path escapes the workspace.');
  }
  let cursor = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, part);
    try { const stat = await lstat(cursor); if (stat.isSymbolicLink()) throw toolError('Symbolic links are not allowed for file tools.'); if (stat.isFile() && stat.nlink !== 1) throw toolError('Hard links are not allowed for file tools.'); }
    catch (error) { if (error.code === 'ENOENT' && missing) break; throw error; }
  }
  if (directory && !missing && !(await lstat(target)).isDirectory()) throw toolError('Expected a directory.');
  return target;
}

export async function runCommand(command, { cwd, signal, timeoutSeconds = 60 } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 32000 || command.includes('\0')) throw toolError('Invalid command.');
  signal?.throwIfAborted();
  const windows = process.platform === 'win32';
  const child = spawn(windows ? command : '/bin/sh', windows ? [] : ['-lc', command], {
    cwd, shell: windows, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    // Do not inherit per-job proxy credentials or application secrets.
    env: { PATH: process.env.PATH, ...(windows ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, TEMP: process.env.TEMP } : {}), HOME: cwd, LANG: 'C.UTF-8' },
  });
  const kill = () => { try { if (windows) child.kill('SIGKILL'); else process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } };
  let stdout = '', stderr = '', bytes = 0, timedOut = false, truncated = false;
  const out = new StringDecoder('utf8'), err = new StringDecoder('utf8');
  child.stdout.on('data', chunk => { bytes += chunk.length; const value = out.write(chunk); stdout += value.slice(0, Math.max(0, 65536 - stdout.length)); if (bytes > 1024 * 1024) { truncated = true; kill(); } });
  child.stderr.on('data', chunk => { bytes += chunk.length; const value = err.write(chunk); stderr += value.slice(0, Math.max(0, 65536 - stderr.length)); if (bytes > 1024 * 1024) { truncated = true; kill(); } });
  const timer = setTimeout(() => { timedOut = true; kill(); }, boundedInteger(timeoutSeconds, 60, 1, 120) * 1000);
  signal?.addEventListener('abort', kill, { once: true });
  try {
    const result = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', (exitCode, exitSignal) => resolveExit({ exitCode, signal: exitSignal })); });
    stdout += out.end(); stderr += err.end();
    signal?.throwIfAborted();
    return { ...result, stdout, stderr, timedOut, truncated: truncated || bytes > 131072 };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', kill); kill(); }
}

export async function executeNativeTool(name, args, { cwd, signal, skills = [], delegate } = {}) {
  signal?.throwIfAborted();
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw toolError('Tool arguments must be an object.');
  if (name === 'read_file') {
    const target = await workspacePath(cwd, args.path), stat = await lstat(target);
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw toolError('File is not a regular file or exceeds 10 MB.');
    const text = await readFile(target, 'utf8'), offset = boundedInteger(args.offset, 0, 0, text.length), limit = boundedInteger(args.limit, 32768, 1, 65536);
    return { path: args.path, content: text.slice(offset, offset + limit), offset, totalCharacters: text.length, truncated: offset + limit < text.length };
  }
  if (name === 'write_file') {
    if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 10 * 1024 * 1024) throw toolError('File content must be UTF-8 text of at most 10 MB.');
    const target = await workspacePath(cwd, args.path, { missing: true });
    await mkdir(dirname(target), { recursive: true });
    await workspacePath(cwd, args.path, { missing: true });
    await writeFile(target, args.content, { mode: 0o600 });
    return { path: args.path, bytes: Buffer.byteLength(args.content), written: true };
  }
  if (name === 'list_files') {
    const target = await workspacePath(cwd, args.path ?? '.', { directory: true }), entries = [];
    const walk = async (directory, prefix = '', depth = 0) => {
      if (depth > 6 || entries.length >= 1000) return;
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (entries.length >= 1000) break;
        const name = prefix + item.name;
        if (item.isSymbolicLink()) continue;
        const stat = await lstat(resolve(directory, item.name));
        entries.push({ path: name, directory: item.isDirectory(), bytes: item.isFile() ? stat.size : 0 });
        if (args.recursive && item.isDirectory()) await walk(resolve(directory, item.name), name + '/', depth + 1);
      }
    };
    await walk(target);
    return { entries, truncated: entries.length >= 1000 };
  }
  if (name === 'run_command') return runCommand(args.command, { cwd, signal, timeoutSeconds: args.timeoutSeconds });
  if (name === 'use_skill') {
    const skill = skills.find(item => item.name === args.name);
    if (!skill) throw toolError('This skill was not selected for the task.');
    return { name: skill.name, instructions: skill.content };
  }
  if (name === 'delegate_task') {
    if (!delegate) throw toolError('Delegation is unavailable inside a delegated task.');
    if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 32000) throw toolError('Provide a bounded concrete subtask.');
    return delegate(args.task);
  }
  throw toolError(`Unknown tool: ${String(name).slice(0, 100)}`);
}
