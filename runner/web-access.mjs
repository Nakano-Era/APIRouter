import { isIP } from 'node:net';
import { classifyAddress } from '../server/net.mjs';
import { safePublicRequest, boundedBody } from './network.mjs';
import { fault } from './protocol.mjs';

const MAX_RESPONSE = 2 * 1024 * 1024;
const DEFAULT_SEARCH = 'http://work-search:8080';
const timeoutMs = 20_000;
const webFault = (message, status = 502) => fault(message, status, 'WORK_WEB_ACCESS_ERROR');
function publicUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\u0000-\u0020\\]/.test(raw)) throw webFault('请输入有效的公网 HTTPS 网页地址。', 400);
  let url; try { url = new URL(raw); } catch { throw webFault('网页地址无效。', 400); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') && !isIP(host) || /(?:^|\.)(?:localhost|local|internal)\.?$/.test(host) || isIP(host) && classifyAddress(host) !== 'public') throw webFault('网页读取仅支持公网 HTTPS 地址，不能访问本机或内网。', 400);
  url.hash = '';
  return url;
}
function searchBase(raw) {
  if (raw === DEFAULT_SEARCH || raw === DEFAULT_SEARCH + '/') return { url: new URL(DEFAULT_SEARCH), internal: true };
  const url = publicUrl(raw);
  if (url.search || new URL(raw).hash) throw webFault('搜索服务地址不能包含查询参数或片段。', 400);
  return { url, internal: false };
}
function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', copy: '©' };
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (all, value) => {
    if (value[0] !== '#') return named[value.toLowerCase()] ?? all;
    const code = value[1].toLowerCase() === 'x' ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}
function plainHtml(html) {
  return decodeEntities(html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<\/?(?:p|div|article|section|h[1-6]|li|ul|ol|table|tr|br|hr)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, ' '))
    .replace(/[\t \f\r]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const cleanText = (value, limit) => plainHtml(typeof value === 'string' ? value : '').slice(0, limit);

// Browsers and model providers are not used as a search transport. Only this
// broker-side service can reach public pages; the workspace remains isolated.
export function createWebAccess({ publicRequest = safePublicRequest, internalFetch = fetch } = {}) {
  async function search({ query, limit = 5 } = {}, { baseUrl = DEFAULT_SEARCH, signal } = {}) {
    signal?.throwIfAborted();
    if (typeof query !== 'string' || !query.trim() || query.length > 500 || /[\u0000-\u001f\u007f]/.test(query)) throw webFault('搜索词须为 1–500 个字符。', 400);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw webFault('搜索结果数量须为 1–10。', 400);
    const base = searchBase(baseUrl), url = base.url;
    url.pathname = url.pathname.replace(/\/$/, '') + '/search';
    url.search = new URLSearchParams({ q: query.trim(), format: 'json' }).toString();
    let request;
    try {
      const headers = { Accept: 'application/json' };
      if (base.internal) {
        const effective = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
        const response = await internalFetch(url.href, { method: 'GET', headers, redirect: 'manual', signal: effective });
        request = { response, cleanup: async () => { try { await response.body?.cancel(); } catch {} } };
      } else request = await publicRequest(url.href, { method: 'GET', headers, signal, timeoutMs });
      const { response } = request;
      if (!response.ok) throw webFault(`搜索服务未返回有效结果（HTTP ${response.status}），请检查搜索服务和 JSON API 是否启用。`);
      let data; try { data = JSON.parse((await boundedBody(response, MAX_RESPONSE)).toString('utf8')); } catch (error) { if (error.status) throw error; throw webFault('搜索服务返回了无法解析的结果，请检查 JSON API。'); }
      if (!Array.isArray(data.results)) throw webFault('搜索服务未返回结果列表。');
      const results = [], seen = new Set();
      for (const row of data.results) {
        let resultUrl; try { resultUrl = publicUrl(row?.url).href; } catch { continue; }
        if (seen.has(resultUrl)) continue; seen.add(resultUrl);
        results.push({ title: cleanText(row.title, 400) || resultUrl, url: resultUrl, snippet: cleanText(row.content ?? row.snippet, 1600) });
        if (results.length >= limit) break;
      }
      if (!results.length) throw webFault('搜索未找到可读取的公网 HTTPS 结果，请调整搜索词后重试。', 404);
      return { query: query.trim(), results, retrievedAt: new Date().toISOString() };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error.status) throw error;
      throw webFault('无法连接搜索服务，请检查搜索容器或公网搜索服务地址。');
    } finally { await request?.cleanup?.(); }
  }
  async function read({ url: raw } = {}, { signal } = {}) {
    signal?.throwIfAborted();
    let url = publicUrl(raw);
    const visited = new Set();
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal?.throwIfAborted();
      if (visited.has(url.href)) throw webFault('网页重定向形成循环。');
      visited.add(url.href);
      let request;
      try {
        request = await publicRequest(url.href, { method: 'GET', headers: { Accept: 'text/html, application/json, text/plain;q=0.9' }, signal, timeoutMs, allowRedirect: true });
        const response = request.response;
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location || redirects === 3) throw webFault('网页重定向次数过多或地址无效。');
          let next; try { next = new URL(location, url).href; } catch { throw webFault('网页重定向地址无效。'); }
          url = publicUrl(next); continue;
        }
        if (!response.ok) throw webFault(`网页读取失败（HTTP ${response.status}）。`);
        const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (type && !['text/html', 'application/xhtml+xml', 'text/plain', 'application/json'].includes(type) && !type.endsWith('+json')) throw webFault('此地址不是可读取的网页、JSON 或纯文本。', 415);
        const body = (await boundedBody(response, MAX_RESPONSE)).toString('utf8');
        const html = ['text/html', 'application/xhtml+xml'].includes(type) || !type && /^\s*(?:<!doctype html|<html\b)/i.test(body);
        const title = html ? cleanText(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(body)?.[1] || '', 400) : '';
        const text = html ? plainHtml(body.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ')) : body.trim();
        if (!text) throw webFault('网页没有可提取的正文，可能需要登录或依赖脚本。');
        return { url: url.href, title: title || url.hostname, text: text.slice(0, 30_000), retrievedAt: new Date().toISOString(), truncated: text.length > 30_000 };
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error.status) throw error;
        throw webFault('无法读取网页，请检查地址或换用其他来源。');
      } finally { await request?.cleanup?.(); }
    }
    throw webFault('网页重定向次数过多。');
  }
  return { search, read };
}
