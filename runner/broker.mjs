import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { apiUrl, validateBaseUrl } from '../server/net.mjs';
import { validateJob, dockerArguments, fault } from './protocol.mjs';
import { safePublicRequest, redactCredentials } from './network.mjs';

const execute = promisify(execFile);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, value) => { if (!res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function bodyJSON(req, maximum = 45 * 1024 * 1024) {
  if (Number(req.headers['content-length']) > maximum) throw fault('请求超过大小限制。', 413);
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > maximum) throw fault('请求超过大小限制。', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fault('请求不是有效 JSON。'); }
}

export function gatewayEndpoint(pathname, id) {
  const base = `/proxy/${id}/v1/`;
  if (!pathname.startsWith(base)) return null;
  const endpoint = pathname.slice(base.length);
  return ['messages', 'messages/count_tokens'].includes(endpoint) ? endpoint : null;
}

export function gatewayHeaders(source, provider) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'anthropic-version': '2023-06-01' };
  for (const [key, value] of Object.entries(source)) {
    if (['anthropic-version', 'anthropic-beta', 'user-agent', 'x-app'].includes(key) || /^x-stainless-[a-z-]+$/.test(key)) {
      if (typeof value === 'string' && value.length <= 2048 && !/[\r\n]/.test(value)) headers[key] = value;
    }
  }
  if (provider.authMode === 'bearer') headers.authorization = `Bearer ${provider.apiKey}`;
  else headers['x-api-key'] = provider.apiKey;
  return headers;
}

export function createBroker({ token = process.env.WORK_RUNNER_TOKEN, image = process.env.WORK_WORKER_IMAGE || 'apirouter-work:local', self = process.env.HOSTNAME, docker = async args => (await execute('docker', args, { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim(), spawnDocker = args => spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }), publicRequest = safePublicRequest } = {}) {
  if (!token || token.length < 32) throw new Error('WORK_RUNNER_TOKEN must be at least 32 characters');
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(self ?? '')) throw new Error('Broker container hostname is required');
  const jobs = new Map();
  let closing = false, healthCache;
  const health = async () => {
    if (healthCache && Date.now() - healthCache.at < 5000) return healthCache.value;
    let value;
    try { await docker(['version', '--format', '{{.Server.Version}}']); await docker(['image', 'inspect', image, '--format', '{{.Id}}']); value = { available: !closing, runtime: 'claude-code', reason: closing ? '工作执行器正在停止。' : null }; }
    catch { value = { available: false, runtime: 'claude-code', reason: 'Docker 或 Claude Code 工作镜像未就绪，请运行 Work 部署脚本。' }; }
    healthCache = { at: Date.now(), value }; return value;
  };
  const cleanup = async job => {
    if (job.cleaning) return job.cleaning;
    job.cleaning = (async () => {
      job.controller.abort();
      try { await docker(['rm', '-f', `ar-work-${job.id}`]); } catch {}
      try { await docker(['network', 'disconnect', '-f', job.network, self]); } catch {}
      try { await docker(['network', 'rm', job.network]); } catch {}
      jobs.delete(job.id);
    })();
    return job.cleaning;
  };

  async function proxy(req, res, url) {
    const id = /^\/proxy\/([a-f0-9]{32})\//.exec(url.pathname)?.[1];
    const job = jobs.get(id);
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') || req.headers['x-api-key'];
    if (!job || !same(bearer, job.jobToken)) return json(res, 401, { error: { type: 'authentication_error', message: 'Job credential expired or invalid' } });
    const endpoint = gatewayEndpoint(url.pathname, id);
    if (req.method !== 'POST' || !endpoint || [...url.searchParams.keys()].some(key => key !== 'beta')) return json(res, 403, { error: { type: 'permission_error', message: 'Endpoint is not enabled for this job' } });
    if (++job.calls > 160) return json(res, 429, { error: { type: 'rate_limit_error', message: 'Per-job request limit reached' } });
    const body = await bodyJSON(req, 20 * 1024 * 1024);
    if (body.model !== job.config.model) return json(res, 400, { error: { type: 'invalid_request_error', message: 'This job can use only its selected model' } });
    if (endpoint === 'messages' && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 32768)) return json(res, 400, { error: { type: 'invalid_request_error', message: 'max_tokens must be 1–32768' } });
    if (job.config.mode === 'chat' && Array.isArray(body.tools) && body.tools.length) return json(res, 403, { error: { type: 'permission_error', message: 'Tools are disabled in Chat mode' } });
    if (!job.config.webSearch && body.tools?.some(tool => /web_search|web_fetch/.test(tool.type ?? ''))) return json(res, 403, { error: { type: 'permission_error', message: 'Network search is disabled for this job' } });
    const upstreamUrl = apiUrl(job.provider.baseUrl, endpoint) + url.search;
    const request = await publicRequest(upstreamUrl, { method: 'POST', headers: gatewayHeaders(req.headers, job.provider), body: JSON.stringify(body), signal: job.controller.signal, timeoutMs: Math.min(180_000, job.config.limits.timeoutSeconds * 1000) });
    try {
      const headers = { 'content-type': request.response.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' };
      for (const name of ['request-id', 'x-request-id', 'retry-after']) { const value = request.response.headers.get(name); if (value) headers[name] = value; }
      res.writeHead(request.response.status, headers);
      if (!request.response.ok) {
        let length = 0, truncated = false; const chunks = [];
        for await (const chunk of request.response.body ?? []) {
          const remaining = 128 * 1024 - length;
          if (remaining <= 0) { truncated = true; break; }
          chunks.push(Buffer.from(chunk).subarray(0, remaining)); length += Math.min(chunk.length, remaining);
          if (chunk.length > remaining) { truncated = true; break; }
        }
        const raw = redactCredentials(Buffer.concat(chunks).toString(), [job.provider.apiKey, job.jobToken]);
        job.lastDiagnostic = { source: 'upstream-http', status: request.response.status, method: 'POST', url: upstreamUrl, protocol: 'anthropic', modelId: body.model, headers, body: raw, truncated, readNote: 'Claude Code 网关捕获的上游原始错误响应；认证凭据已隐藏。' };
        res.end(raw); return;
      }
      job.lastDiagnostic = null;
      for await (const chunk of request.response.body ?? []) {
        if (res.destroyed) break;
        if (!res.write(chunk)) await new Promise(resolveDrain => { res.once('drain', resolveDrain); res.once('close', resolveDrain); });
      }
      res.end();
    } finally { await request.cleanup(); }
  }

  async function startJob(req, res) {
    if (closing) throw fault('工作执行器正在停止。', 503);
    const input = await bodyJSON(req);
    const config = validateJob(input);
    if (jobs.size >= config.limits.maxConcurrentJobs || jobs.size >= 4) throw fault('工作沙箱已满，请稍后重试。', 429, 'WORK_BUSY');
    const provider = input.provider;
    if (provider?.protocol !== 'anthropic' || typeof provider.apiKey !== 'string' || !provider.apiKey || provider.apiKey.length > 8192 || /[\r\n]/.test(provider.apiKey) || !['auto', 'bearer', 'x-api-key'].includes(provider.authMode ?? 'auto')) throw fault('Claude Code 运行需要有效的 Anthropic API 配置。');
    validateBaseUrl(provider.baseUrl);
    const id = randomBytes(16).toString('hex');
    const job = { id, network: `ar-work-${id}`, jobToken: randomBytes(32).toString('base64url'), config, provider, controller: new AbortController(), calls: 0 };
    jobs.set(id, job);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const send = event => {
      if (!res.destroyed) res.write(JSON.stringify(event) + '\n');
    };
    const stopJob = () => { job.controller.abort(); docker(['rm', '-f', `ar-work-${job.id}`]).catch(() => {}); };
    const onClose = () => { if (!res.writableEnded) stopJob(); };
    res.once('close', onClose);
    const timer = setTimeout(() => { send({ type: 'error', code: 'WORK_TIMEOUT', error: '任务达到沙箱时限，已停止。' }); stopJob(); res.end(); }, config.limits.timeoutSeconds * 1000);
    timer.unref();
    try {
      send({ type: 'activity', label: '正在启动隔离工作区', committed: false });
      await docker(['network', 'create', '--internal', '--label', 'apirouter.work.managed=1', job.network]);
      job.controller.signal.throwIfAborted();
      await docker(['network', 'connect', '--alias', 'gateway', job.network, self]);
      job.controller.signal.throwIfAborted();
      await docker(dockerArguments({ id, network: job.network, image, limits: config.limits }));
      job.controller.signal.throwIfAborted();
      const child = spawnDocker(['start', '-a', '-i', `ar-work-${id}`]);
      const exited = new Promise(resolveExit => { child.once('error', error => resolveExit({ error })); child.once('close', code => resolveExit({ code })); });
      // Explicit allowlist: provider credentials never enter the worker, its
      // process environment, the Docker command line or the model context.
      const workerInput = { mode: config.mode, model: config.model, effort: config.effort, prompt: config.prompt, systemPrompt: config.systemPrompt, skills: config.skills, files: config.files, images: config.images ?? [], webSearch: config.webSearch, limits: config.limits, gateway: `http://gateway:3210/proxy/${id}`, jobToken: job.jobToken };
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(workerInput));
      let buffer = '', stderr = '', done = false, outputBytes = 0;
      const decoder = new StringDecoder('utf8'), errorDecoder = new StringDecoder('utf8');
      child.stderr.on('data', chunk => { stderr += errorDecoder.write(chunk).slice(0, Math.max(0, 128 * 1024 - stderr.length)); });
      for await (const chunk of child.stdout) {
        outputBytes += chunk.length;
        if (outputBytes > 50 * 1024 * 1024) throw fault('任务输出超过大小限制。', 502);
        buffer += decoder.write(chunk);
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let event; try { event = JSON.parse(line); } catch { continue; }
          if (!['delta', 'activity', 'usage', 'file', 'error', 'done'].includes(event.type)) continue;
          if (event.type === 'error') event = { type: 'error', code: event.code, error: event.error, rawDiagnostic: job.lastDiagnostic ?? { status: null, protocol: 'claude-code', modelId: config.model, body: redactCredentials(event.diagnostic?.rawBody || event.error, [job.provider.apiKey, job.jobToken]), truncated: false } };
          if (event.type === 'delta') event.text = redactCredentials(event.text, [job.provider.apiKey, job.jobToken]);
          if (event.type === 'done') done = true;
          send(event);
        }
      }
      const outcome = await exited;
      if (!done) send({ type: 'error', code: 'WORKER_FAILED', error: '工作执行器异常退出，请管理员检查原始日志。', rawDiagnostic: job.lastDiagnostic ?? { status: null, protocol: 'claude-code', modelId: config.model, body: redactCredentials(stderr || outcome.error?.message || `Worker exit code ${outcome.code}`, [provider.apiKey, job.jobToken]), truncated: false } });
    } catch (error) {
      send({ type: 'error', code: error.code || 'WORKER_FAILED', error: '无法完成沙箱任务，请管理员检查运行配置。', rawDiagnostic: { body: redactCredentials(error.message, [provider.apiKey, job.jobToken]), protocol: 'claude-code', modelId: config.model, truncated: false } });
    } finally { clearTimeout(timer); await cleanup(job); res.end(); }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://broker');
      if (url.pathname.startsWith('/proxy/')) return await proxy(req, res, url);
      if (!same(req.headers.authorization, `Bearer ${token}`)) return json(res, 401, { error: 'Unauthorized' });
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, await health());
      if (url.pathname === '/jobs' && req.method === 'POST') return await startJob(req, res);
      return json(res, 404, { error: 'Not found' });
    } catch (error) { if (!res.headersSent) json(res, error.status || 502, { error: redactCredentials(error.message, [token]) }); else res.end(); }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return { server, jobs, health, async cleanupOrphans() {
    for (const container of (await docker(['ps', '-a', '--filter', 'label=apirouter.work.managed=1', '--format', '{{.Names}}'])).split('\n')) if (/^ar-work-[a-f0-9]{32}$/.test(container)) { try { await docker(['rm', '-f', container]); } catch {} }
    for (const network of (await docker(['network', 'ls', '--filter', 'label=apirouter.work.managed=1', '--format', '{{.Name}}'])).split('\n')) if (/^ar-work-[a-f0-9]{32}$/.test(network)) { try { await docker(['network', 'disconnect', '-f', network, self]); } catch {} try { await docker(['network', 'rm', network]); } catch {} }
  }, async close() { closing = true; await Promise.all([...jobs.values()].map(cleanup)); server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const broker = createBroker();
  await broker.cleanupOrphans();
  broker.server.listen(3210, '0.0.0.0');
  process.once('SIGTERM', () => broker.close().finally(() => process.exit(0)));
  process.once('SIGINT', () => broker.close().finally(() => process.exit(0)));
}
