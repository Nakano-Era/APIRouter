import type { WorkArtifact } from '../types';

export type ArtifactTarget = { kind: 'file' | 'archive'; url: string; name: string } | { kind: 'missing' } | { kind: 'external'; url: string };
const safeId = /^[A-Za-z0-9_-]{1,128}$/;
const safePath = (path: string) => !!path && path.length <= 240 && !/[\\\u0000-\u001f\u007f:<>"|?*]/.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.startsWith('.'));

export function artifactDownloadUrl(file: WorkArtifact): string | null {
  if (!safeId.test(file.id)) return null;
  if (file.chatId && safeId.test(file.chatId)) return `/api/work/chats/${file.chatId}/artifacts/${file.id}/download`;
  const legacy = `/api/work/artifacts/${file.id}/download`;
  return file.downloadUrl === legacy ? legacy : null;
}

export function artifactArchiveUrl(artifacts: WorkArtifact[], prefix = ''): string | null {
  const chatId = artifacts[0]?.chatId;
  if (!chatId || !safeId.test(chatId) || artifacts.some(file => file.chatId !== chatId) || (prefix && !safePath(prefix))) return null;
  return `/api/work/chats/${chatId}/artifacts/download${prefix ? `?path=${encodeURIComponent(prefix)}` : ''}`;
}

/** Resolve only against this conversation's server-issued artifact list. Never
 * turn an arbitrary model-written API URL into an authenticated request. */
export function resolveArtifactLink(href: string | undefined, artifacts: WorkArtifact[], origin = typeof window === 'undefined' ? '' : window.location.origin): ArtifactTarget {
  if (!href || href.length > 2048) return { kind: 'missing' };
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.origin === origin && /^\/api(?:\/|$)/i.test(decodeURIComponent(url.pathname))) return resolveArtifactLink(`${url.pathname}${url.search}`, artifacts, origin);
    } catch { return { kind: 'missing' }; }
    return { kind: 'external', url: href };
  }
  if (/^mailto:/i.test(href)) return { kind: 'external', url: href };
  const exact = artifacts.find(file => href === file.downloadUrl || href === artifactDownloadUrl(file));
  if (exact) { const url = artifactDownloadUrl(exact); if (url) return { kind: 'file', url, name: exact.name }; }
  if (/^\/api\//i.test(href) || href.startsWith('//')) return { kind: 'missing' };
  let path: string;
  try { path = decodeURIComponent(href.split(/[?#]/, 1)[0]); } catch { return { kind: 'missing' }; }
  path = path.replace(/^sandbox:/i, '').replace(/^\.\//, '');
  path = path.replace(/^(?:\/workspace\/output\/|\/mnt\/data\/(?:output\/)?|output\/)/, '').replace(/\/$/, '');
  if (!safePath(path)) return { kind: 'missing' };
  const files = artifacts.filter(file => (file.path ?? file.name) === path);
  if (files.length === 1) {
    const url = artifactDownloadUrl(files[0]);
    if (url) return { kind: 'file', url, name: files[0].name };
  }
  if (artifacts.some(file => file.path?.startsWith(`${path}/`))) {
    const url = artifactArchiveUrl(artifacts, path);
    if (url) return { kind: 'archive', url, name: `${path.split('/').at(-1)}.zip` };
  }
  return { kind: 'missing' };
}

export async function fetchArtifactDownload(url: string, fetcher: typeof fetch = fetch): Promise<Blob> {
  if (!/^\/api\/work\/(?:artifacts\/[A-Za-z0-9_-]+\/download|chats\/[A-Za-z0-9_-]+\/artifacts\/(?:[A-Za-z0-9_-]+\/download|download(?:\?path=[^#]*)?))$/.test(url)) throw new Error('下载地址无效。');
  const response = await fetcher(url, { credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(response.status === 401 ? '登录已过期，请重新登录后下载。' : error.error || '文件下载失败，请稍后重试。');
  }
  if (!/^attachment(?:;|$)/i.test(response.headers.get('content-disposition') || '') || !response.body) throw new Error('服务器未返回可下载文件，请刷新页面或检查部署版本。');
  const limit = 32 * 1024 * 1024, reader = response.body.getReader(), parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('下载超过 32 MB，请分开下载或在沙箱中生成压缩包。');
      parts.push(new Uint8Array(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return new Blob(parts, { type: response.headers.get('content-type') || 'application/octet-stream' });
}

export async function downloadArtifact(url: string, name: string) {
  const blob = await fetchArtifactDownload(url), objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl; anchor.download = name.replace(/[\\/\u0000-\u001f]/g, '_');
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
