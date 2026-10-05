import express from 'express';
import rateLimit from 'express-rate-limit';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { id, digest, now } from './store.mjs';
import { openUpstream, UpstreamError, redactDiagnosticObject } from './net.mjs';

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const invalidKey = () => fail(401, 'API Key 无效、已停用或已撤销。', 'invalid_api_key');
const bounded = (n, min, max, fallback) => Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fallback;
const selection = `SELECT m.*,p.base_url,p.protocol,p.encrypted_key,p.auth_mode,p.runtime,p.priority,
  p.failure_threshold,p.cooldown_seconds,p.failure_protection_enabled AS provider_protection
  FROM models m JOIN providers p ON p.id=m.provider_id
  WHERE m.enabled=1 AND m.available=1 AND p.enabled=1 AND p.runtime='api'`;
const endpoints = { '/chat/completions': 'openai-chat', '/responses': 'openai-responses', '/messages': 'anthropic' };
const errorJSON = (message, code = 'api_error') => ({ error: { message, type: code, code } });

function values(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['name', 'modelIds', 'enabled'].includes(key))) throw fail(400, 'API Key 配置无效。');
  const name = input.name === undefined ? previous?.name : input.name;
  const enabled = input.enabled === undefined ? previous ? !!previous.enabled : true : input.enabled;
  const modelIds = input.modelIds === undefined ? previous ? JSON.parse(previous.model_ids) : undefined : input.modelIds;
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw fail(400, '名称不能为空，且最多 80 个字符。');
  if (typeof enabled !== 'boolean') throw fail(400, '启用状态必须是布尔值。');
  if (!Array.isArray(modelIds) || !modelIds.length || modelIds.some(value => typeof value !== 'string' || !value || value.length > 200)) throw fail(400, '请至少选择一个渠道中的 API 模型。');
  return { name: name.trim(), enabled, modelIds: [...new Set(modelIds)] };
}

// Keep the provider credential out of even a misbehaving upstream's successful
// response, including secrets split over network chunks. All other bytes pass
// through unchanged (no protocol conversion, tool parsing, or token rewriting).
function secretFilter(secret) {
  const needles = [...new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString('base64')])].filter(Boolean).map(value => Buffer.from(value)).sort((a, b) => b.length - a.length);
  const hold = Math.max(...needles.map(value => value.length)) - 1;
  let pending = Buffer.alloc(0);
  return (chunk, final = false) => {
    pending = Buffer.concat([pending, chunk]);
    const output = [];
    // A credential cannot contain LF; a complete SSE line is therefore a safe
    // flush boundary. In particular, deliver terminal events immediately even
    // when the provider keeps its HTTP connection open after the last frame.
    let offset = 0, end = final ? pending.length : Math.max(0, pending.length - hold, pending.lastIndexOf(10) + 1);
    while (offset < end) {
      let found = end, match;
      for (const needle of needles) { const index = pending.indexOf(needle, offset); if (index >= offset && index < found) { found = index; match = needle; } }
      output.push(pending.subarray(offset, found));
      if (!match) { offset = end; break; }
      output.push(Buffer.from('[REDACTED]')); offset = found + match.length;
    }
    pending = pending.subarray(offset);
    return Buffer.concat(output);
  };
}

function inspectNativePayload(payload, raw) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new UpstreamError('上游没有返回有效的响应对象。', 'INVALID_UPSTREAM_RESPONSE');
  const type = payload.type;
  const failed = payload.error || payload.response?.error || type === 'error' || ['response.failed', 'response.incomplete', 'response.cancelled'].includes(type) || ['failed', 'incomplete', 'cancelled'].includes(payload.status) || ['failed', 'incomplete', 'cancelled'].includes(payload.response?.status);
  const incomplete = payload.choices?.some?.(choice => choice.finish_reason === 'length') || payload.stop_reason === 'max_tokens' || payload.delta?.stop_reason === 'max_tokens';
  if (failed || incomplete) {
    const error = new UpstreamError(incomplete ? '上游输出未完成。' : '上游返回了失败响应。', incomplete ? 'INCOMPLETE_UPSTREAM_OUTPUT' : 'UPSTREAM_RESPONSE_ERROR');
    error.rawDiagnostic = { responseFormat: 'native', body: raw.slice(0, 1024 * 1024), truncated: raw.length > 1024 * 1024 };
    throw error;
  }
}

// Validate frames without rewriting provider IDs, arguments or usage events.
// A TCP EOF is not a successful SSE response: each protocol has a terminal event.
function nativeStreamInspector(protocol) {
  const decoder = new TextDecoder();
  let pending = '', completed = false, payloadCount = 0;
  function frame(raw) {
    const lines = raw.split(/\r?\n/), data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') {
      if (protocol === 'openai-chat') {
        if (!payloadCount) throw new UpstreamError('上游没有返回内容。', 'EMPTY_UPSTREAM_OUTPUT');
        completed = true;
      }
      return;
    }
    let payload;
    try { payload = JSON.parse(data); } catch { throw new UpstreamError('上游流式响应包含无效 JSON。', 'INVALID_UPSTREAM_RESPONSE'); }
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim(), type = payload.type || event;
    inspectNativePayload(event && !payload.type ? { ...payload, type: event } : payload, data);
    payloadCount++;
    if (protocol === 'openai-responses' && type === 'response.completed' || protocol === 'anthropic' && type === 'message_stop') completed = true;
  }
  return {
    push(chunk, final = false) {
      pending += decoder.decode(chunk, { stream: !final });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        frame(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
      }
      if (final && pending.trim()) { frame(pending); pending = ''; }
      if (final && !completed) throw new UpstreamError('上游流式响应在完成前断开。', 'INCOMPLETE_UPSTREAM_OUTPUT');
      return completed;
    },
  };
}

export function createApiExports({ store, upstream = openUpstream, maxResponseBytes = 64 * 1024 * 1024, requestLimit = '32mb', totalTimeoutMs = 3600_000, keepAliveMs = 15_000 } = {}) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS api_export_keys (
    id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,key_hint TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,model_ids TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TEXT NOT NULL,last_used_at TEXT
  )`);
  const active = new Map(), probes = new Set();
  function publicKey(row) { return { id: row.id, name: row.name, enabled: !!row.enabled, modelIds: JSON.parse(row.model_ids), keyHint: row.key_hint, createdAt: row.created_at, lastUsedAt: row.last_used_at }; }
  function keyById(keyId) { return store.get('SELECT k.* FROM api_export_keys k JOIN users u ON u.id=k.created_by WHERE k.id=? AND k.enabled=1 AND u.disabled=0 AND u.role=?', keyId, 'admin'); }
  function allowed(keyId) { const key = keyById(keyId); if (!key) throw invalidKey(); return new Set(JSON.parse(key.model_ids)); }
  function models(keyId, modelId, protocol) {
    const ids = allowed(keyId);
    return store.all(selection + (modelId === undefined ? '' : ' AND m.model_id=? AND p.protocol=?') + ' ORDER BY p.priority DESC,m.id', ...(modelId === undefined ? [] : [modelId, protocol])).filter(row => ids.has(row.id));
  }
  function validateModels(modelIds, previousIds = []) {
    for (const modelId of modelIds) {
      const model = store.get('SELECT p.runtime FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?', modelId);
      if ((!model || model.runtime !== 'api') && !previousIds.includes(modelId)) throw fail(400, '所选模型不存在或属于 Claude Code 渠道；导出 API 仅支持 API 渠道。');
    }
  }
  function abortKey(keyId) { for (const job of active.values()) if (job.keyId === keyId) job.controller.abort(invalidKey()); }
  function authenticate(req, res, next) {
    const auth = req.get('authorization'), alternate = req.get('x-api-key');
    const bearer = auth?.match(/^Bearer ([A-Za-z0-9_-]+)$/i)?.[1];
    const token = bearer || alternate;
    if (auth && !bearer || bearer && alternate && bearer !== alternate || typeof token !== 'string' || !/^ar_sk_[A-Za-z0-9_-]{43}$/.test(token)) return next(invalidKey());
    const row = store.get('SELECT id FROM api_export_keys WHERE token_hash=?', digest(token));
    if (!row || !keyById(row.id)) return next(invalidKey());
    req.apiExportKeyId = row.id;
    store.run('UPDATE api_export_keys SET last_used_at=? WHERE id=?', now(), row.id);
    res.set('Cache-Control', 'no-store'); next();
  }
  function cooling(row) { return (row.failure_protection_enabled ?? row.provider_protection) !== 0 && !!row.cooldown_until && (!Number.isFinite(Date.parse(row.cooldown_until)) || Date.parse(row.cooldown_until) > Date.now()); }
  function recordFailure(row) {
    const enabled = (row.failure_protection_enabled ?? row.provider_protection) !== 0;
    const threshold = row.cooldown_until ? 1 : bounded(row.failure_threshold_override ?? row.failure_threshold, 1, 1000, 3);
    const seconds = bounded(row.cooldown_seconds_override ?? row.cooldown_seconds, 1, 2592000, 60);
    return store.run(`UPDATE models SET failure_count=failure_count+1,status='error',error='导出 API 上游请求失败。',last_checked_at=?,
      cooldown_until=CASE WHEN ?=0 THEN NULL WHEN failure_count+1>=? THEN ? ELSE cooldown_until END,
      failure_epoch=failure_epoch+CASE WHEN ?=1 AND failure_count+1>=? THEN 1 ELSE 0 END WHERE id=? AND failure_epoch=?`,
    now(), enabled ? 1 : 0, threshold, new Date(Date.now() + seconds * 1000).toISOString(), enabled ? 1 : 0, threshold, row.id, row.failure_epoch);
  }
  function disposition(error) {
    // Local validation, access revocation and resource limits do not become
    // upstream retries. Once dispatched, every upstream failure uses the budget.
    const local = ['INVALID_BASE_URL', 'BLOCKED_UPSTREAM_ADDRESS', 'INVALID_PROTOCOL', 'MISSING_API_KEY', 'INVALID_AUTH_MODE', 'invalid_api_key', 'model_access_revoked', 'response_too_large'].includes(error?.code);
    return { switch: !local, retry: !local };
  }
  function auditEnd(auditId, outcome, error, apiKey) {
    const message = error ? `导出 API 上游请求失败${error.upstreamStatus ? `（HTTP ${error.upstreamStatus}）` : ''}。` : null;
    store.run('UPDATE route_attempts SET outcome=?,error=?,encrypted_detail=? WHERE id=?', outcome, message,
      error?.rawDiagnostic ? store.encrypt(JSON.stringify(redactDiagnosticObject(error.rawDiagnostic, apiKey))) : null, auditId);
    store.run("DELETE FROM route_attempts WHERE outcome<>'running' AND rowid NOT IN (SELECT rowid FROM route_attempts ORDER BY rowid DESC LIMIT 200)");
  }
  async function proxy(req, res) {
    const body = req.body, protocol = endpoints[req.path];
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string' || !body.model || body.model.length > 300) throw fail(400, '请提供准确的上游 model ID。', 'invalid_request_error');
    const candidates = models(req.apiExportKeyId, body.model, protocol);
    if (!candidates.length) throw fail(404, '此 API Key 没有可用于该接口的授权模型。', 'model_not_found');
    if ([...active.values()].filter(job => job.keyId === req.apiExportKeyId).length >= 10) throw fail(429, '此 API Key 同时进行的请求过多。', 'rate_limit_error');
    const requestId = id(), controller = new AbortController(), signal = controller.signal;
    active.set(requestId, { keyId: req.apiExportKeyId, controller });
    const disconnected = () => { if (!res.writableEnded) controller.abort(new DOMException('Client disconnected', 'AbortError')); };
    req.on('aborted', disconnected); res.on('close', disconnected);
    let written = false, inheritedAttempts = 0, lastError;
    const settings = store.settings(), attemptLimit = bounded(settings.routingMaxAttempts, 1, 100, 6);
    // Native APIs may deliver executable tool calls. Hold retryable attempts
    // until completion, rather than replaying partial native event sequences.
    const atomicResponse = candidates.length > 1 || candidates.some(row => bounded(row.retries_override, 0, 100, bounded(settings.retriesPerChannel, 0, 3, 1)) > 0);
    let heartbeat;
    if (body.stream === true && atomicResponse) {
      heartbeat = setInterval(() => {
        if (res.destroyed || res.writableEnded || written || res.writableNeedDrain) return;
        if (!res.headersSent) res.status(200).set({ 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store' });
        res.write(': apirouter waiting for upstream\n\n');
      }, keepAliveMs);
      heartbeat.unref?.();
    }
    try {
      for (const initial of candidates) {
        let row = models(req.apiExportKeyId, body.model, protocol).find(item => item.id === initial.id);
        if (!row || cooling(row) || probes.has(row.id)) continue;
        const explicitRetries = row.retries_override != null;
        if (!explicitRetries && inheritedAttempts >= attemptLimit) continue;
        let ownFailureEpoch = null;
        const halfOpen = !!row.cooldown_until && (row.failure_protection_enabled ?? row.provider_protection) !== 0;
        if (halfOpen) probes.add(row.id);
        try {
          const retries = halfOpen && !explicitRetries ? 0 : bounded(row.retries_override, 0, 100, bounded(settings.retriesPerChannel, 0, 3, 1));
          for (let retry = 0; retry <= retries && (explicitRetries || inheritedAttempts < attemptLimit); retry++) {
            signal.throwIfAborted();
            row = models(req.apiExportKeyId, body.model, protocol).find(item => item.id === initial.id);
            if (!row || (cooling(row) && !(explicitRetries && ownFailureEpoch !== null && row.failure_epoch === ownFailureEpoch))) break;
            const provider = { baseUrl: row.base_url, protocol: row.protocol, authMode: row.auth_mode, apiKey: store.decrypt(row.encrypted_key) };
            let opened, reader, bytes = 0;
            const attemptController = new AbortController();
            const attemptSignal = AbortSignal.any([signal, attemptController.signal]);
            const attemptTimer = setTimeout(() => attemptController.abort(new UpstreamError('上游 API 响应超时。', 'UPSTREAM_TIMEOUT', 504)), totalTimeoutMs); attemptTimer.unref?.();
            const auditId = id();
            store.run('INSERT INTO route_attempts(id,request_id,provider_id,model_id,outcome,created_at,execution_route_key,execution_variant_name,execution_effort) VALUES(?,?,?,?,?,?,?,?,?)',
              auditId, `api-export-${requestId}`, row.provider_id, row.id, 'running', now(), row.route_key, row.variant_name || '', typeof body.reasoning?.effort === 'string' ? body.reasoning.effort.slice(0, 100) : null);
            if (!explicitRetries) inheritedAttempts++;
            try {
              opened = await upstream(provider, req.path.slice(1), { signal: attemptSignal, body, idleTimeout: true, nativePassthrough: true, requestHeaders: req.headers });
              const response = opened.response, contentType = response.headers.get('content-type') || '';
              if (!/^(?:application\/(?:[\w.-]+\+)?json|text\/event-stream)(?:;|$)/i.test(contentType) || !response.body) throw new UpstreamError('上游返回了不受支持的响应。', 'INVALID_UPSTREAM_RESPONSE');
              const streaming = /^text\/event-stream(?:;|$)/i.test(contentType);
              if (res.headersSent && !streaming) throw new UpstreamError('上游未返回所请求的流式响应。', 'INVALID_UPSTREAM_RESPONSE');
              reader = response.body.getReader();
              const filter = secretFilter(provider.apiKey);
              const inspector = streaming ? nativeStreamInspector(protocol) : null;
              const buffered = [], holdOutput = atomicResponse || !streaming;
              async function write(chunk) {
                if (!chunk.length) return;
                if (!written) {
                  if (!res.headersSent) { res.status(response.status); res.set({ 'Content-Type': contentType, 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store' }); }
                  written = true;
                }
                if (!res.write(chunk)) await once(res, 'drain', { signal: opened.signal || attemptSignal });
              }
              while (true) {
                attemptSignal.throwIfAborted();
                const { value, done } = await reader.read();
                // A key/model/provider disabled during an in-flight stream must
                // not keep delivering data. Recheck after the awaited read.
                attemptSignal.throwIfAborted();
                if (!models(req.apiExportKeyId, body.model, protocol).some(item => item.id === row.id)) throw fail(403, '模型授权或渠道状态已变更。', 'model_access_revoked');
                if (done) {
                  inspector?.push(new Uint8Array(), true);
                  if (!streaming) {
                    const raw = Buffer.concat(buffered).toString('utf8');
                    let payload;
                    try { payload = JSON.parse(raw); } catch { throw new UpstreamError('上游没有返回有效的 JSON。', 'INVALID_UPSTREAM_RESPONSE'); }
                    inspectNativePayload(payload, raw);
                  }
                  if (holdOutput) for (const chunk of buffered) await write(filter(chunk));
                  await write(filter(Buffer.alloc(0), true)); break;
                }
                bytes += value.byteLength;
                if (bytes > maxResponseBytes) throw fail(502, '上游响应超过大小限制。', 'response_too_large');
                opened.touch?.();
                const complete = inspector?.push(value);
                if (holdOutput) buffered.push(Buffer.from(value));
                else await write(filter(Buffer.from(value)));
                // Do not wait for TCP EOF after an explicit terminal event;
                // all preceding frames, including usage, are already buffered.
                if (complete) {
                  if (holdOutput) for (const chunk of buffered) await write(filter(chunk));
                  await write(filter(Buffer.alloc(0), true)); break;
                }
              }
              if (!bytes) throw new UpstreamError('上游没有返回内容。', 'EMPTY_UPSTREAM_OUTPUT');
              store.run("UPDATE models SET failure_count=0,cooldown_until=NULL,status='ok',error=NULL,last_checked_at=?,failure_epoch=failure_epoch+1 WHERE id=? AND failure_epoch=?", now(), row.id, row.failure_epoch);
              auditEnd(auditId, 'complete');
              res.end(); return;
            } catch (error) {
              // fetch/read may surface a plain AbortError for its own idle
              // timer. Retain that controller's timeout reason for failover.
              if (opened?.signal?.aborted && !signal.aborted) error = opened.signal.reason || error;
              if (attemptSignal.aborted && !signal.aborted) error = attemptSignal.reason || error;
              lastError = error;
              auditEnd(auditId, signal.aborted ? 'stopped' : 'error', signal.aborted ? null : error, provider.apiKey);
              if (signal.aborted) throw signal.reason;
              const action = disposition(error);
              if (action.switch) { const recorded = recordFailure(row); ownFailureEpoch = recorded?.changes ? store.get('SELECT failure_epoch FROM models WHERE id=?', row.id)?.failure_epoch ?? null : null; }
              // Keepalive comments commit HTTP headers, not native model data.
              // Failed buffered attempts can therefore still be discarded.
              if (written || !action.switch) throw error;
              if (!action.retry) break;
            } finally { clearTimeout(attemptTimer); try { await reader?.cancel(); } catch { /* upstream closed */ } reader?.releaseLock(); await opened?.cleanup?.(); }
          }
        } finally { probes.delete(initial.id); }
      }
      throw lastError || fail(503, '授权模型的渠道正在冷却或暂时不可用。', 'model_unavailable');
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        if (!res.destroyed) {
          const reason = signal.aborted ? signal.reason : error;
          if (!written) {
            const stopped = signal.aborted || !disposition(reason).retry;
            const message = stopped ? reason?.code === 'response_too_large' ? '上游响应超过大小限制，请求已停止。' : '请求已停止或授权状态已变更。' : `上游 API 请求失败${reason?.upstreamStatus ? `（HTTP ${reason.upstreamStatus}）` : ''}。已用完本次可用重试次数。`;
            const code = stopped ? reason?.code || 'request_stopped' : 'upstream_error';
            const payload = protocol === 'anthropic' ? { type: 'error', error: { type: 'api_error', message } } : protocol === 'openai-responses' ? { type: 'error', code, message } : errorJSON(message, code);
            res.end(`${protocol === 'openai-chat' ? '' : 'event: error\n'}data: ${JSON.stringify(payload)}\n\n`);
          } else res.destroy();
        }
        return;
      }
      throw signal.aborted ? signal.reason : error;
    } finally { clearInterval(heartbeat); req.off('aborted', disconnected); res.off('close', disconnected); active.delete(requestId); }
  }
  function mountPublic(app) {
    const api = express.Router();
    api.use(rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false, message: errorJSON('请求过于频繁，请稍后重试。', 'rate_limit_error') }));
    api.use(authenticate);
    api.get('/models', (req, res) => res.json({ object: 'list', data: [...new Set(models(req.apiExportKeyId).map(row => row.model_id))].sort().map(model => ({ id: model, object: 'model', created: 0, owned_by: 'apirouter' })) }));
    api.use(express.json({ limit: requestLimit }));
    for (const path of Object.keys(endpoints)) api.post(path, proxy);
    api.use((_req, _res, next) => next(fail(404, 'API 接口不存在。', 'not_found')));
    api.use((error, _req, res, _next) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : error instanceof UpstreamError ? [400, 413, 422, 429].includes(error.upstreamStatus) ? error.upstreamStatus : error.code === 'UPSTREAM_TIMEOUT' ? 504 : 502 : bounded(error.status, 400, 599, 500);
      const code = error instanceof UpstreamError ? 'upstream_error' : error.type?.startsWith('entity.') ? 'invalid_request_error' : error.code || 'api_error';
      const message = error instanceof UpstreamError ? `上游 API 请求失败${error.upstreamStatus ? `（HTTP ${error.upstreamStatus}）` : ''}。请检查模型、原生接口及请求参数后重试。` : status === 413 ? '请求内容过大。' : error.type === 'entity.parse.failed' ? '请求不是有效 JSON。' : status === 500 ? 'API 服务暂时不可用。' : error.message;
      res.status(status).json(errorJSON(message, code));
    });
    app.use('/v1', api);
  }
  function registerRoutes(app, { auth, admin, csrf }) {
    const guards = [auth, admin, csrf], path = '/api/admin/api-keys';
    app.get(path, ...guards, (_req, res) => res.json({ keys: store.all('SELECT * FROM api_export_keys ORDER BY created_at DESC,id').map(publicKey) }));
    app.post(path, ...guards, (req, res) => {
      const input = values(req.body); validateModels(input.modelIds);
      const keyId = id(), raw = `ar_sk_${randomBytes(32).toString('base64url')}`;
      store.run('INSERT INTO api_export_keys(id,name,token_hash,key_hint,enabled,model_ids,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)', keyId, input.name, digest(raw), `${raw.slice(0, 10)}…${raw.slice(-4)}`, input.enabled ? 1 : 0, JSON.stringify(input.modelIds), req.user.id, now());
      res.status(201).json({ key: publicKey(store.get('SELECT * FROM api_export_keys WHERE id=?', keyId)), apiKey: raw });
    });
    app.patch(`${path}/:id`, ...guards, (req, res) => {
      const old = store.get('SELECT * FROM api_export_keys WHERE id=?', req.params.id); if (!old) throw fail(404, 'API Key 不存在。');
      const input = values(req.body, old); validateModels(input.modelIds, JSON.parse(old.model_ids));
      store.run('UPDATE api_export_keys SET name=?,model_ids=?,enabled=? WHERE id=?', input.name, JSON.stringify(input.modelIds), input.enabled ? 1 : 0, old.id);
      if (!input.enabled || JSON.stringify(input.modelIds) !== old.model_ids) abortKey(old.id);
      res.json({ key: publicKey(store.get('SELECT * FROM api_export_keys WHERE id=?', old.id)) });
    });
    app.delete(`${path}/:id`, ...guards, (req, res) => {
      if (!store.get('SELECT id FROM api_export_keys WHERE id=?', req.params.id)) throw fail(404, 'API Key 不存在。');
      store.run('DELETE FROM api_export_keys WHERE id=?', req.params.id); abortKey(req.params.id); res.json({ ok: true });
    });
  }
  const abortAll = () => { for (const job of active.values()) job.controller.abort(new DOMException('Server stopping', 'AbortError')); };
  return { mountPublic, registerRoutes, abortAll, ensureIdle() { if (active.size) throw fail(409, '对外 API 正在处理请求，请等待完成后导入配置。'); }, close: abortAll };
}
