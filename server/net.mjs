import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import ipaddr from 'ipaddr.js';

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

// Only fixed administrator probes opt in. Never collect arbitrary chat error bodies.
async function adminErrorDetail(response, apiKey, signal) {
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) return;
  const limit = 64 * 1024;
  if (Number(response.headers.get('content-length')) > limit || !response.body) return;
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(), 2000);
  timer.unref?.();
  const readSignal = AbortSignal.any([signal, budget.signal]);
  const reader = response.body.getReader();
  try {
    let length = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await raceAbort(reader.read(), readSignal);
      if (done) break;
      length += value.byteLength;
      if (length > limit) return;
      chunks.push(value);
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const error = parsed.error;
    const fields = error && typeof error === 'object' && !Array.isArray(error)
      ? [error.type, error.code, error.message]
      : [parsed.type, parsed.code, typeof error === 'string' ? error : parsed.message];
    let detail = [...new Set(fields.filter(value => typeof value === 'string' && value.trim()))].join(' · ');
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
  } catch {
    // Diagnostics are best effort; the original HTTP error must keep its routing semantics.
    return;
  } finally {
    clearTimeout(timer);
    try { await reader.cancel(); } catch { /* The connection may already be closed. */ }
    reader.releaseLock();
  }
}

export async function openUpstream(provider, endpoint, { signal, body, query, timeoutMs, diagnostics = false } = {}) {
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
  const timer = setTimeout(() => controller.abort(new UpstreamError('上游响应超时，请稍后重试。', 'UPSTREAM_TIMEOUT', 504)), duration);
  timer.unref?.();
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
    const headers = { Accept: body ? 'text/event-stream, application/json' : 'application/json' };
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
      if (diagnostics) error.adminDetail = await adminErrorDetail(response, provider.apiKey, effectiveSignal);
      throw error;
    }
    return { response, signal: effectiveSignal, cleanup };
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
    throw new UpstreamError('上游未返回有效的 JSON，请检查所选 API 协议。', 'INVALID_UPSTREAM_RESPONSE');
  }
}
