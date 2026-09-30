import path from 'node:path';

export const DEFAULT_LIMITS = Object.freeze({ enabled: true, maxTurns: 20, timeoutSeconds: 600, memoryMb: 768, cpus: 1, maxBudgetUsd: 2, maxConcurrentJobs: 2 });
export const LIMIT_BOUNDS = Object.freeze({ maxTurns: [1, 80], timeoutSeconds: [30, 1800], memoryMb: [512, 4096], cpus: [0.25, 4], maxBudgetUsd: [0.1, 20], maxConcurrentJobs: [1, 4] });
export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACT_TOTAL = 30 * 1024 * 1024;
export const MAX_ARTIFACTS = 30;
export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_CHECKPOINT_BYTES = 32 * 1024 * 1024;
export const PROTOCOLS = new Set(['anthropic', 'openai-chat', 'openai-responses']);
export const EFFORTS = new Set(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
export const fault = (message, status = 400, code = 'INVALID_WORK_REQUEST') => Object.assign(new Error(message), { status, code });

export function validateLimits(input = {}, base = DEFAULT_LIMITS) {
  const result = { ...base };
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_LIMITS)) throw fault(`不支持的沙箱设置：${key}`);
    const value = input[key];
    if (key === 'enabled') { if (typeof value !== 'boolean') throw fault('enabled 必须为布尔值。'); }
    else {
      const [min, max] = LIMIT_BOUNDS[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (!['cpus', 'maxBudgetUsd'].includes(key) && !Number.isInteger(value))) throw fault(`${key} 必须在 ${min}–${max} 之间。`);
    }
    result[key] = value;
  }
  return result;
}

export function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.length > 240 || /[\\\u0000-\u001f\u007f:]/.test(value) || path.posix.isAbsolute(value)) throw fault('工作区文件路径无效。');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[<>"|?*]/.test(part))) throw fault('工作区文件路径无效。');
  return parts.join('/');
}

export function validateSkill(input, previous) {
  if (!input || typeof input !== 'object') throw fault('请输入技能内容。');
  const name = String(input.name ?? previous?.name ?? '').trim();
  const description = String(input.description ?? previous?.description ?? '').trim();
  let content = input.content ?? previous?.content;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw fault('技能名称使用 1–64 个小写英文字母、数字和连字符。');
  if (!description || description.length > 500 || /[\u0000-\u001f]/.test(description)) throw fault('技能说明需要 1–500 个字符。');
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content) > MAX_SKILL_BYTES || content.includes('\0')) throw fault('SKILL.md 不能为空，最多 64 KB。');
  // Only markdown instructions are imported. Rebuild metadata to prevent a pasted
  // skill from installing hooks, MCP servers, executable substitutions or agents.
  content = content.replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
  if (/!`[^`]*`/.test(content)) throw fault('当前技能导入不接受 !`命令` 动态执行语法，请改为普通操作说明。');
  return { name, description, content: `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}\n` };
}

export function skillMetadata(content) {
  const front = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? '';
  const field = key => {
    const value = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front)?.[1]?.trim();
    if (!value) return undefined;
    if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return value; } }
    return value.replace(/^'|'$/g, '');
  };
  return { name: field('name'), description: field('description') };
}

export function validateJob(job) {
  if (!job || !['chat', 'work'].includes(job.mode) || !EFFORTS.has(job.effort ?? 'auto')) throw fault('请选择有效的模式及思考强度。');
  const engine = job.engine ?? 'native', protocol = job.protocol ?? 'anthropic';
  if (!['native', 'claude-code'].includes(engine) || !PROTOCOLS.has(protocol) || (engine === 'claude-code' && protocol !== 'anthropic')) throw fault('工作引擎或接口协议无效。');
  if (!job.model || typeof job.model !== 'string' || !job.model.trim() || job.model.length > 512 || /[\u0000-\u0020\u007f]/.test(job.model) || job.model.startsWith('-')) throw fault('上游模型 ID 无效。');
  if (typeof job.prompt !== 'string' || !job.prompt.trim() || Buffer.byteLength(job.prompt) > 32 * 1024 * 1024) throw fault('工作上下文为空或超过 32 MB。');
  for (const [key, maximum] of [['contextWindow', 10_000_000], ['maxOutputTokens', 1_000_000]]) if (job[key] != null && (!Number.isInteger(job[key]) || job[key] < 1 || job[key] > maximum)) throw fault('模型上下文或输出长度设置无效。');
  if (job.resumeState != null) validateCheckpoint(job.resumeState, { model: job.model, protocol });
  if (typeof job.systemPrompt !== 'string' || job.systemPrompt.length > 100_000) throw fault('系统提示词无效。');
  if (typeof job.webSearch !== 'boolean') throw fault('网络搜索选项无效。');
  if (!Array.isArray(job.skills) || job.skills.length > 10) throw fault('一次最多使用 10 项技能。');
  for (const skill of job.skills) validateSkill(skill);
  if (!Array.isArray(job.files) || job.files.length > MAX_ARTIFACTS + 5) throw fault('工作文件数量超过限制。');
  let size = 0;
  const paths = new Set();
  for (const file of job.files) {
    safeRelativePath(file.path);
    if (paths.has(file.path)) throw fault('工作文件路径重复。');
    paths.add(file.path);
    if (typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) || file.data.length > Math.ceil(MAX_ARTIFACT_BYTES * 4 / 3) + 4) throw fault('工作文件格式或大小无效。');
    size += Buffer.from(file.data, 'base64').length;
  }
  if (size > MAX_ARTIFACT_TOTAL) throw fault('工作文件总大小超过 30 MB。');
  if (job.images !== undefined && (!Array.isArray(job.images) || job.images.length > 5)) throw fault('一次最多发送 5 张图片。');
  for (const image of job.images ?? []) {
    if (image?.type !== 'image' || image.source?.type !== 'base64' || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(image.source.media_type) || typeof image.source.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.source.data) || image.source.data.length > 14 * 1024 * 1024) throw fault('图片输入无效。');
    size += Buffer.from(image.source.data, 'base64').length;
  }
  if (size > MAX_ARTIFACT_TOTAL) throw fault('工作文件与图片总大小超过 30 MB。');
  return { ...job, engine, protocol, maxOutputTokens: job.maxOutputTokens ?? 16384, effort: job.effort ?? 'auto', limits: validateLimits(job.limits) };
}

export function validateCheckpoint(state, { model, protocol }) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || state.version !== 1 || state.model !== model || state.protocol !== protocol || Buffer.byteLength(JSON.stringify(state)) > MAX_CHECKPOINT_BYTES) throw fault('工作恢复记录与当前模型不匹配或超过大小限制。', 409, 'WORK_CHECKPOINT_INVALID');
  return state;
}

export function claudeArguments(job) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--no-session-persistence', '--model', job.model,
    '--max-turns', String(job.mode === 'chat' ? 1 : job.limits.maxTurns), '--max-budget-usd', String(job.limits.maxBudgetUsd),
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project',
    '--settings', '{"disableAllHooks":true,"enableAllProjectMcpServers":false,"autoMemoryEnabled":false}',
    '--append-system-prompt', `${job.systemPrompt}\n${job.mode === 'work' ? 'You can execute tools inside this isolated workspace. Save final deliverables under /workspace/output. Do not claim a file exists before creating it. Files in output are offered as downloads. The workspace has no unrestricted Internet; use WebSearch only when available. Never expose credentials or internal gateway information.' : 'Chat mode has no tools. Answer the user directly. Do not claim to execute code or create files.'}`];
  if (job.effort !== 'auto') args.push('--effort', job.effort);
  if (job.mode === 'work') {
    const tools = ['Agent', 'Skill', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', ...(job.webSearch ? ['WebSearch'] : [])].join(',');
    args.push('--tools', tools, '--allowedTools', tools, '--dangerously-skip-permissions', '--agents', JSON.stringify({ researcher: { description: 'Delegate a bounded research or file preparation subtask.', prompt: 'Complete only your assigned subtask. Use the workspace tools and report files you actually created. Never claim actions that did not run.', model: 'inherit' } }));
  } else args.push('--tools', '', '--disable-slash-commands');
  return args;
}

export function dockerArguments({ id, network, image, limits }) {
  if (!/^[a-f0-9]{32}$/.test(id) || !/^ar-work-[a-f0-9]{32}$/.test(network) || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(image)) throw fault('沙箱运行配置无效。');
  limits = validateLimits(limits);
  return ['create', '-i', '--name', `ar-work-${id}`, '--label', 'apirouter.work.managed=1', '--network', network,
    '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`, '--cpus', String(limits.cpus), '--ulimit', 'nofile=1024:1024', '--user', '1000:1000', '--init',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000', '--tmpfs', '/home/node:rw,nosuid,size=64m,uid=1000,gid=1000',
    '--tmpfs', '/workspace:rw,nosuid,size=256m,uid=1000,gid=1000', '--workdir', '/workspace', image, 'node', '/opt/apirouter/worker.mjs'];
}

export function parseClaudeEvent(row, state) {
  const events = [];
  if (row.type === 'stream_event' && !row.parent_tool_use_id && row.event?.delta?.type === 'text_delta') {
    state.streamed = true;
    events.push({ type: 'delta', text: String(row.event.delta.text ?? '') });
  }
  const block = row.event?.type === 'content_block_start' ? row.event.content_block : null;
  const blocks = block ? [block] : row.type === 'assistant' ? row.message?.content ?? [] : [];
  for (const item of blocks) if (item.type === 'tool_use' && !state.tools.has(item.id)) {
    state.tools.add(item.id);
    events.push({ type: 'activity', committed: true, label: ({ Agent: '正在分派子任务', Task: '正在分派子任务', Skill: '正在使用技能', Write: '正在写入文件', Edit: '正在修改文件', Read: '正在读取文件', Bash: '正在沙箱中执行', WebSearch: '正在搜索网络', Glob: '正在查找文件', Grep: '正在搜索内容' })[item.name] ?? '正在执行任务工具' });
  }
  if (row.type === 'result') {
    state.finished = true;
    if (row.is_error || row.subtype !== 'success') {
      events.push({ type: 'error', code: 'CLAUDE_EXECUTION_FAILED', error: 'Claude Code 执行未完成，请管理员检查原始日志。', diagnostic: { rawBody: JSON.stringify(row), source: 'claude-code' } });
    } else if (!state.streamed && typeof row.result === 'string') events.push({ type: 'delta', text: row.result });
    events.push({ type: 'usage', inputTokens: Number(row.usage?.input_tokens ?? 0) + Number(row.usage?.cache_read_input_tokens ?? 0) + Number(row.usage?.cache_creation_input_tokens ?? 0), outputTokens: Number(row.usage?.output_tokens ?? 0) });
  }
  return events;
}
