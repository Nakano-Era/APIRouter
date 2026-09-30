import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import { classifyAddress } from '../server/net.mjs';
import { fault } from './protocol.mjs';

export async function safePublicRequest(raw, { method = 'GET', headers = {}, body, signal, timeoutMs = 30_000 } = {}) {
  let url;
  try { url = new URL(raw); } catch { throw fault('请输入有效的公网 HTTPS 地址。'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || /[\u0000-\u0020\\]/.test(raw) || (!host.includes('.') && !isIP(host))) throw fault('仅支持不含账号密码的公网 HTTPS 地址。');
  const effective = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise((_, reject) => { if (effective.aborted) reject(effective.reason); else effective.addEventListener('abort', () => reject(effective.reason), { once: true }); }),
  ]);
  if (!addresses.length || addresses.some(entry => classifyAddress(entry.address) !== 'public')) throw fault('已拒绝访问本机、内网或保留地址。');
  const dispatcher = new Agent({ connect: { timeout: 15_000, lookup: (_host, options, callback) => options?.all ? callback(null, addresses) : callback(null, addresses.find(entry => !options?.family || entry.family === options.family)?.address ?? addresses[0].address, addresses.find(entry => !options?.family || entry.family === options.family)?.family ?? addresses[0].family) } });
  let response;
  try {
    response = await fetch(url, { method, headers, body, signal: effective, redirect: 'manual', dispatcher });
    if (response.status >= 300 && response.status < 400) throw fault('地址发生重定向，请填写最终 HTTPS 地址。', 502);
    return { response, signal: effective, cleanup: async () => { try { await response.body?.cancel(); } catch {} await dispatcher.destroy(); } };
  } catch (error) { await dispatcher.destroy(); throw error; }
}

export async function boundedBody(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) throw fault('响应文件超过大小限制。', 502);
  let length = 0;
  const chunks = [];
  for await (const chunk of response.body ?? []) {
    length += chunk.length;
    if (length > limit) throw fault('响应文件超过大小限制。', 502);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function redactCredentials(raw, secrets = []) {
  let result = String(raw);
  for (const value of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const secret of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) result = result.split(secret).join('[REDACTED]');
  }
  return result.replace(/\b(?:Bearer|Basic)\s+[^\s,"']+/gi, '[REDACTED]').replace(/\b(?:sk|rk|whsec|sess)[-_][\w.-]+/gi, '[REDACTED]');
}
