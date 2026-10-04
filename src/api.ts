import type { Session, StreamEvent } from './types';

let csrfToken = '';
export function setSessionToken(session: Session) { csrfToken = session.csrfToken || ''; }
const publicAuthPaths = new Set(['/auth/session', '/auth/setup', '/auth/login', '/auth/invite', '/auth/invite/accept']);
export class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  if (options.method && options.method !== 'GET' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
  const response = await fetch(`/api${path}`, { ...options, headers, credentials: 'same-origin' });
  let data;
  try { data = await response.json(); } catch { throw new ApiError('服务器未返回有效数据，请稍后重试。', response.status); }
  if (!response.ok) { if (response.status === 401 && csrfToken && !publicAuthPaths.has(path.split('?')[0])) window.dispatchEvent(new Event('session-expired')); throw new ApiError(data.error || '请求失败，请稍后重试。', response.status); }
  return data as T;
}
export function post<T>(path: string, body?: unknown) { return api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }); }
export function patch<T>(path: string, body: unknown) { return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) }); }
export function remove<T = { ok: boolean }>(path: string) { return api<T>(path, { method: 'DELETE' }); }
export async function stream(path: string, body: unknown, signal: AbortSignal, onEvent: (event: string, data: StreamEvent) => void) {
  const response = await fetch(`/api${path}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify(body), signal });
  if (!response.ok) {
    if (response.status === 401 && csrfToken) window.dispatchEvent(new Event('session-expired'));
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error || `请求失败 (${response.status})`, response.status);
  }
  if (!response.body) throw new Error('此浏览器不支持流式响应。');
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let completed = false;
  const dispatch = (block: string) => {
    let event = 'message'; const lines: string[] = [];
    for (const line of block.split('\n')) { if (line.startsWith('event:')) event = line.slice(6).trim(); if (line.startsWith('data:')) lines.push(line.slice(5).trimStart()); }
    if (!lines.length) return;
    let data: StreamEvent;
    try { data = JSON.parse(lines.join('\n')); } catch { throw new Error('服务返回了无法读取的响应。'); }
    if (event === 'done' || event === 'error') completed = true;
    onEvent(event, data);
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) { dispatch(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); }
      if (done) break;
    }
    if (buffer.trim()) dispatch(buffer);
    if (!completed && !signal.aborted) throw new Error('连接提前结束。已收到的内容会保留，可点击“继续生成”接着输出。');
  } finally { reader.releaseLock(); }
}
export function errorText(error: unknown) { return error instanceof Error ? error.message : '操作未完成，请重试。'; }
