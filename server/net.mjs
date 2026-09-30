import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';
import { prepareResponsesRequest, responseRequestShape } from './responses-compat.mjs';

export class UpstreamError extends Error {
  constructor(message, code = 'UPSTREAM_ERROR', status = 502, upstreamStatus) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
    if (upstreamStatus !== undefined) this.upstreamStatus = upstreamStatus;
  }
}

export function sanitizeUpstreamError(error) {
  if (error instanceof UpstreamError) return error.message;
  if (error?.name === 'AbortError') return '请求已停止。';
  if (error?.name === 'TimeoutError') return '上游响应超时，请稍后重试。';
  return '上游连接失败，请检查 API 地址、协议与网络后重试。';
}

function hostName(url) { return url.hostname.replace(/^\[|\]$/g, ''); }
function allowLoopback() { return process.env.ALLOW_PRIVATE_UPSTREAM === 'true'; }

export function classifyAddress(address) {
  if (!ipaddr.isValid(address)) return 'blocked';
  const parsed = ipaddr.process(address);
  const range = parsed.range();
  if (range === 'loopback') return 'loopback';
  if (range !== 'unicast') return 'blocked';
  // Exclude protocol-assignment / transition ranges as well as private ranges.
  const denied = parsed.kind() === 'ipv4'
    ? ['0.0.0.0/8', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/3']
    : ['::/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/23', '2001:db8::/32', '2002::/16'];
  if (denied.some(cidr => parsed.match(ipaddr.parseCIDR(cidr)))) return 'blocked';
  return 'public';
}

export function validateBaseUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020\u007f\\]/.test(raw)) {
    throw new UpstreamError('请输入有效的 HTTPS API 基础地址。', 'INVALID_BASE_URL', 400);
  }
  let url;
  try { url = new URL(raw); } catch {
    throw new UpstreamError('请输入有效的 HTTPS API 基础地址。', 'INVALID_BASE_URL', 400);
  }
  if (!url.hostname || url.username || url.password || url.search || url.hash || /[?#]/.test(raw)) {
    throw new UpstreamError('API 地址不能包含账号、密码、查询参数或片段。', 'INVALID_BASE_URL', 400);
  }
  const host = hostName(url).toLowerCase().replace(/\.$/, '');
  const kind = isIP(host) ? classifyAddress(host) : null;
  const localName = host === 'localhost';
  if ((kind === 'blocked') || (kind === 'loopback' && !allowLoopback()) ||
      ((localName || host.endsWith('.localhost')) && !allowLoopback()) ||
      host.endsWith('.local') || host.endsWith('.internal') || (!host.includes('.') && !kind && !localName)) {
    throw new UpstreamError('上游地址必须指向公网服务，不能访问本机或内网。', 'BLOCKED_UPSTREAM_ADDRESS', 400);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopback() && (kind === 'loopback' || localName))) {
    throw new UpstreamError('上游必须使用 HTTPS；仅本地测试可显式允许回环 HTTP。', 'INVALID_BASE_URL', 400);
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

export function apiUrl(baseUrl, endpoint) {
  const base = validateBaseUrl(baseUrl);
  // Both https://host and https://host/prefix/v1 are valid base URLs.
  return `${base}${/\/v\d+(?:beta\d*)?$/.test(new URL(base).pathname) ? '' : '/v1'}/${endpoint}`;
}

function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function redactRawError(value, apiKey) {
  let text = typeof value === 'string' ? value : '';
  const secrets = [apiKey, encodeURIComponent(apiKey), JSON.stringify(apiKey).slice(1, -1), Buffer.from(apiKey).toString('base64')];
  for (const secret of secrets.sort((a,b) => b.length - a.length)) if (secret) text = text.split(secret).join('[API KEY REDACTED]');
  return text.replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[AUTH REDACTED]')
    .replace(/\b(?:sk|rk|pk|whsec|sess)[-_][\w.-]+/gi, '[KEY REDACTED]');
}

export function redactDiagnosticObject(value, apiKey) {
  if (typeof value === 'string') return redactRawError(value, apiKey);
  if (Array.isArray(value)) return value.map(item => redactDiagnosticObject(item, apiKey));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDiagnosticObject(item, apiKey)]));
  return value;
}

function redactDiagnosticText(value, apiKey) {
    if (typeof value !== 'string') return;
    let detail = value;
    // Do not echo error pages or stack traces, even when mislabeled as JSON.
    if (!detail || /<\/?[a-z!][^>]*>|\b(?:stack\s*trace|traceback)\b|\n\s*at\s+\S+/i.test(detail)) return;
    const secrets = [apiKey, encodeURIComponent(apiKey), JSON.stringify(apiKey).slice(1, -1), Buffer.from(apiKey).toString('base64')];
    for (const secret of secrets.sort((a, b) => b.length - a.length)) if (secret) detail = detail.split(secret).join('[已隐藏]');
    detail = detail
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;"']+/gi, '[认证信息已隐藏]')
      .replace(/\b(?:sk|rk|pk|whsec|sess)[-_][\w.-]+/gi, '[密钥已隐藏]')
      .replace(/\b(?:authorization|x-api-key|api[_ -]?key|token|password|secret)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[凭据已隐藏]')
      .replace(/https?:\/\/[^\s<>"']+/gi, '[地址已隐藏]')
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱已隐藏]')
      .replace(/[A-Za-z0-9_+\/=.-]{40,}/g, '[长标识已隐藏]')
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
      .replace(/\s+/g, ' ').trim();
    return detail.length > 600 ? `${detail.slice(0, 600)}…` : detail || undefined;
}

function jsonErrorFields(parsed) {
  if (typeof parsed === 'string') return parsed;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
  const error = parsed.error;
  const fields = error && typeof error === 'object' && !Array.isArray(error)
    ? [error.type, error.code, error.message, error.msg, error.detail, error.error_description]
    : [parsed.type, parsed.code, typeof error === 'string' ? error : null, parsed.message, parsed.msg, parsed.detail, parsed.error_description];
  return [...new Set(fields.filter(value => typeof value === 'string' && value.trim()))].join(' · ');
}

function describeErrorBody(raw, contentType, apiKey) {
  const text = raw.trim();
  if (!text) return { responseFormat: 'empty', note: '上游错误响应没有正文，未提供具体原因。' };
  // Classify browser challenges; never run their scripts or echo their contents.
  if (contentType.includes('text/html') || /^<(?:!doctype|html|head|body|script)\b/i.test(text)) {
    const challenge = /acw_sc__v2|cf-chl-|challenge-platform|captcha|document\.cookie/i.test(text);
    return { responseFormat: 'html', note: challenge
      ? '上游返回浏览器验证页面，未返回 API 错误说明。请向服务商确认允许服务器直接调用的 API 入口或放行方式。'
      : '上游返回 HTML 错误页，未返回 API 错误说明。请核对 API 入口及服务商网关状态。' };
  }
  let fields;
  let responseFormat = 'json';
  try { fields = jsonErrorFields(JSON.parse(text)); }
  catch {
    if (contentType.includes('text/event-stream') || /(?:^|\n)data:/.test(text)) {
      responseFormat = 'sse';
      const frames = text.split(/\r?\n\r?\n/);
      for (const frame of frames) {
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        try { fields = jsonErrorFields(JSON.parse(data)); } catch { continue; }
        if (fields) break;
      }
    } else if (contentType.includes('json') || /^[{[]/.test(text)) {
      return { responseFormat: 'invalid-json', note: '上游返回的错误正文不是有效 JSON，无法提取错误说明。' };
    } else if (!contentType || contentType.startsWith('text/plain')) {
      responseFormat = 'text';
      fields = text;
    } else return { responseFormat: 'unknown', note: '上游错误响应使用了未支持的格式，未显示原始内容。' };
  }
  const detail = redactDiagnosticText(fields, apiKey);
  return { responseFormat, ...(detail ? { detail } : {}), note: detail
    ? '以下为上游返回的说明，已脱敏并限制长度。'
    : '错误正文没有可显示的说明字段，或包含已隐藏的页面、堆栈内容。' };
}

// The full bounded response is retained only for encrypted administrator audit logs.
async function adminErrorDetail(response, apiKey, signal, rawTarget) {
  const limit = 1024 * 1024;
  if (!response.body) return { responseFormat: 'empty', note: '上游错误响应没有正文，未提供具体原因。' };
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), 2000);
  timer.unref?.();
  const readSignal = AbortSignal.any([signal, budget.signal]);
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let readNote = '';
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await raceAbort(reader.read(), readSignal);
      if (done) break;
      if (length + value.byteLength > limit) {
        chunks.push(value.slice(0, limit - length));
        truncated = true; readNote = '原始错误超过 1 MB，已截断。';
        return { responseFormat: 'too-large', note: readNote };
      }
      length += value.byteLength;
      chunks.push(value);
      // Error SSE streams may stay open after the first complete error frame.
      if (contentType.includes('text/event-stream')) {
        const raw = Buffer.concat(chunks).toString('utf8');
        const boundary = /\r?\n\r?\n/.exec(raw);
        if (boundary) {
          const result = describeErrorBody(raw.slice(0, raw.lastIndexOf(boundary[0]) + boundary[0].length), contentType, apiKey);
          if (result.detail) { truncated = true; readNote = '保留首个完整错误事件；事件流随后已关闭。'; return result; }
        }
      }
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    // Structured preview is shorter than the original body retained for administrators.
    if (length > 64 * 1024) return { responseFormat: 'too-large', note: '错误正文超过 64 KB，请查看原始报错信息。' };
    return describeErrorBody(raw, contentType, apiKey);
  } catch {
    // Diagnostics are best effort; the original HTTP error must keep its routing semantics.
    truncated = true;
    readNote = budget.signal.aborted ? '读取上游错误正文超时（2 秒），保留已收到的内容及 HTTP 状态。' : '上游错误正文读取中断，保留已收到的内容。';
    return { responseFormat: budget.signal.aborted ? 'timeout' : 'unreadable', note: readNote };
  } finally {
    if (rawTarget) Object.assign(rawTarget, { body: redactRawError(Buffer.concat(chunks).toString('utf8'), apiKey), truncated, readNote,
      headers: Object.fromEntries(['content-type', 'x-request-id', 'request-id', 'server'].map(key => [key, redactRawError(response.headers.get(key) || '', apiKey)]).filter(([,value]) => value)) });
    clearTimeout(timer);
    try { await reader.cancel(); } catch { /* The connection may already be closed. */ }
    reader.releaseLock();
  }
}

export async function openUpstream(provider, endpoint, { signal, body, query, timeoutMs, diagnostics = false, idleTimeout = false, sessionId } = {}) {
  const compatible = endpoint === 'responses' && body ? prepareResponsesRequest(provider, body, { sessionId }) : null;
  if (compatible) body = compatible.body;
  if (!['openai-chat', 'openai-responses', 'anthropic'].includes(provider.protocol)) {
    throw new UpstreamError('请选择受支持的 API 协议。', 'INVALID_PROTOCOL', 400);
  }
  if (typeof provider.apiKey !== 'string' || !provider.apiKey.trim() || /[\r\n]/.test(provider.apiKey)) {
    throw new UpstreamError('请先配置有效的 API Key。', 'MISSING_API_KEY', 400);
  }
  const authMode = provider.authMode ?? 'auto';
  if (!['auto', 'bearer', 'x-api-key'].includes(authMode)) {
    throw new UpstreamError('请选择有效的 API 认证方式。', 'INVALID_AUTH_MODE', 400);
  }
  const url = new URL(apiUrl(provider.baseUrl, endpoint));
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const effectiveSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const configured = Number(process.env.UPSTREAM_TIMEOUT_MS);
  const duration = timeoutMs ?? (Number.isFinite(configured) && configured > 0 ? Math.max(100, Math.min(configured, 600_000)) : 180_000);
  let timer;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new UpstreamError('上游响应超时，已保存的内容可以继续生成。', 'UPSTREAM_TIMEOUT', 504)), duration); timer.unref?.(); };
  touch();
  let dispatcher;
  let response;
  const cleanup = async () => {
    clearTimeout(timer);
    try { await response?.body?.cancel(); } catch { /* Already consumed or reader owns it. */ }
    await dispatcher?.destroy();
  };
  try {
    effectiveSignal.throwIfAborted();
    const host = hostName(url);
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await raceAbort(dnsLookup(host, { all: true, verbatim: true }), effectiveSignal);
    if (!addresses.length || addresses.some(({ address }) => {
      const type = classifyAddress(address);
      return type !== 'public' && !(type === 'loopback' && allowLoopback());
    })) throw new UpstreamError('上游域名解析到了受限地址，已拒绝连接。', 'BLOCKED_UPSTREAM_ADDRESS', 400);
    if (url.protocol === 'http:' && addresses.some(({ address }) => classifyAddress(address) !== 'loopback')) {
      throw new UpstreamError('HTTP 测试地址必须解析到本机回环地址。', 'BLOCKED_UPSTREAM_ADDRESS', 400);
    }
    dispatcher = new Agent({
      connect: {
        timeout: Math.min(duration, 15_000),
        // Use the checked addresses for the actual connection, preventing DNS rebinding.
        lookup: (_hostname, options, callback) => {
          if (options?.all) callback(null, addresses);
          else {
            const selected = addresses.find(a => !options?.family || a.family === options.family) ?? addresses[0];
            callback(null, selected.address, selected.family);
          }
        },
      },
    });
    const headers = { accept: body ? 'text/event-stream, application/json' : 'application/json', ...compatible?.headers };
    if (authMode === 'x-api-key' || (authMode === 'auto' && provider.protocol === 'anthropic')) headers['x-api-key'] = provider.apiKey;
    else headers.Authorization = `Bearer ${provider.apiKey}`;
    if (provider.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
    if (body) headers['Content-Type'] = 'application/json';
    response = await fetch(url, {
      method: body ? 'POST' : 'GET', headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: effectiveSignal, redirect: 'manual', dispatcher,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new UpstreamError('上游返回重定向；为保护 API Key，已停止请求。请填写最终 API 地址。', 'UPSTREAM_REDIRECT', 502, response.status);
    }
    if (!response.ok) {
      const detail = response.status === 400 || response.status === 422 ? '请求参数被上游拒绝，请检查模型 ID、接口协议及参数；管理员可在“模型”页测试以查看具体原因。'
        : response.status === 401 || response.status === 403 ? '请检查 API Key、账号权限和协议。'
        : response.status === 404 ? '请检查 API 基础地址、协议和模型名称。'
          : response.status === 429 ? '额度不足或请求过多，请稍后重试。' : '请稍后重试或检查服务商状态。';
      const error = new UpstreamError(`上游请求失败（HTTP ${response.status}）。${detail}`, 'UPSTREAM_HTTP_ERROR', 502, response.status);
      const raw = { status: response.status, method: body ? 'POST' : 'GET', url: redactRawError(url.toString(), provider.apiKey),
        protocol: provider.protocol, modelId: body?.model || '', body: '', headers: {}, truncated: false, readNote: '',
        ...(compatible ? { requestShape: responseRequestShape(body, compatible.profile) } : {}) };
      const description = await adminErrorDetail(response, provider.apiKey, effectiveSignal, raw);
      if (/invalid codex request|invalid claude code request/i.test(raw.body)) {
        description.note = `上游拒绝了客户端请求格式。当前使用${compatible?.profile === 'codex' ? ' Codex 兼容格式' : '标准 API 格式'}；请核对令牌允许的客户端和分组。Claude Code 专属连接使用 Anthropic + Claude Code，GPT 使用 Responses；兼容格式仍被拒绝时需由服务商确认准入条件。`;
        raw.readNote = [raw.readNote, description.note].filter(Boolean).join(' ');
      }
      error.rawDiagnostic = raw;
      if (diagnostics) {
        error.adminDetail = description.detail;
        error.adminDiagnostic = {
          version: 2, protocol: provider.protocol,
          authMode: authMode === 'auto' ? provider.protocol === 'anthropic' ? 'x-api-key' : 'bearer' : authMode,
          method: body ? 'POST' : 'GET', path: redactDiagnosticText(url.pathname, provider.apiKey) || '[路径已隐藏]',
          modelId: redactDiagnosticText(body?.model, provider.apiKey) || '', upstreamStatus: response.status,
          ...description,
          requestId: redactDiagnosticText(response.headers.get('x-request-id') || response.headers.get('request-id'), provider.apiKey),
        };
      }
      throw error;
    }
    return { response, signal: effectiveSignal, cleanup, touch: idleTimeout ? touch : () => {} };
  } catch (error) {
    await cleanup();
    if (effectiveSignal.aborted) throw effectiveSignal.reason;
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError('无法连接上游，请检查 API 地址、网络和 HTTPS 证书。', 'UPSTREAM_CONNECTION_ERROR');
  }
}

export async function readJson(response, maxBytes = 4 * 1024 * 1024) {
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw new UpstreamError('上游响应过大，已停止读取。', 'UPSTREAM_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    const error = new UpstreamError('上游未返回有效的 JSON，请检查所选 API 协议。', 'INVALID_UPSTREAM_RESPONSE');
    error.rawDiagnostic = { status: response.status, body: Buffer.concat(chunks).subarray(0, 1024 * 1024).toString('utf8'), truncated: length > 1024 * 1024, readNote: '上游未返回有效 JSON。' };
    throw error;
  }
}
