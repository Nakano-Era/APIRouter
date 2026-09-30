import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import { Download, FileUp, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, Upload, X } from 'lucide-react';
import { api, errorText, post } from '../../api';
import type { Provider } from '../../types';
import type { RunAction } from './ProvidersPanel';
import './provider-tools.css';

type Protocol = Provider['protocol'];
interface ImportProvider { name: string; baseUrl: string; apiKey: string; protocol: Protocol; runtime: 'api' | 'claude-code'; authMode: 'auto' | 'bearer' | 'x-api-key'; models?: unknown[]; [key: string]: unknown }
interface ParseResult { providers: ImportProvider[]; warnings: string[] }
type Adapter = 'none' | 'newapi' | 'openai-compatible';
interface Balance { available: boolean; message: string; checkedAt: string; remaining?: number | null; used?: number; granted?: number; unit?: string; unlimited?: boolean; expiresAt?: string | null; modelLimits?: string[] }
interface BalanceState { adapter: Adapter; balance: Balance | null }
const protocolOptions = <><option value="openai-chat">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option></>;

export default function ProviderTools({ run, busy, count }: { run: RunAction; busy: string; count: number }) {
  const [panel, setPanel] = useState<'import' | 'export' | null>(null);
  const [input, setInput] = useState(''), [password, setPassword] = useState(''), [currentPassword, setCurrentPassword] = useState('');
  const [format, setFormat] = useState<'encrypted' | 'plain'>('encrypted');
  const [preview, setPreview] = useState<ParseResult | null>(null), [localBusy, setLocalBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState('');
  const revision = useRef(0), fileRef = useRef<HTMLInputElement>(null);
  const close = () => { revision.current++; setPanel(null); setInput(''); setPassword(''); setCurrentPassword(''); setPreview(null); setError(''); setLocalBusy(false); };
  async function recognize(value = input, secret = password) {
    const version = ++revision.current; setLocalBusy(true); setError(''); setPreview(null);
    try { const parsed = await post<ParseResult>('/admin/providers/parse', { text: value, password: secret || undefined }); if (revision.current === version) setPreview(parsed); }
    catch (cause) { if (revision.current === version) setError(errorText(cause)); }
    finally { if (revision.current === version) setLocalBusy(false); }
  }
  function loadText(value: string) {
    revision.current++; setInput(value); setPreview(null); setError('');
    try { if (JSON.parse(value)?.encrypted === true) { setResult('检测到加密备份，请填写备份密码后点击识别。'); return; } } catch { /* Plain environment text is supported too. */ }
    setResult(''); void recognize(value);
  }
  function paste(event: ClipboardEvent<HTMLTextAreaElement>) { event.preventDefault(); loadText(event.clipboardData.getData('text')); }
  function update(index: number, values: Partial<ImportProvider>) { setPreview(value => value ? { ...value, providers: value.providers.map((provider, item) => item === index ? { ...provider, ...values } : provider) } : null); }
  async function saveImport() {
    if (!preview) return;
    let counts: { added: number; skipped: number; modelsAdded: number } | undefined;
    const ok = await run('providers-import', async () => { counts = await post('/admin/providers/import', { providers: preview.providers }); });
    if (ok && counts) { close(); setResult(`已添加 ${counts.added} 个连接，跳过 ${counts.skipped} 个重复连接，恢复 ${counts.modelsAdded} 个模型映射。接下来同步并测试模型。`); }
  }
  async function download() {
    setLocalBusy(true); setError('');
    try {
      const document = await post<Record<string, unknown>>('/admin/providers/export', { format, currentPassword, ...(format === 'encrypted' ? { password } : {}) });
      const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
      const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = `apirouter-apis-${new Date().toISOString().slice(0, 10)}${format === 'encrypted' ? '.encrypted' : ''}.json`;
      window.document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      close(); setResult(`已下载 ${format === 'encrypted' ? '加密' : '明文'} API 备份，可通过“导入连接”恢复。`);
    } catch (cause) { setError(errorText(cause)); }
    finally { setLocalBusy(false); }
  }
  return <div className="provider-tools">
    <div className="provider-tools-toolbar"><button type="button" className="button small" onClick={() => { close(); setResult(''); setPanel('import'); }}><Upload size={15}/>粘贴 / 导入连接</button><button type="button" className="button small" disabled={!count} onClick={() => { close(); setResult(''); setPanel('export'); }}><Download size={15}/>保存全部 API 到本地</button></div>
    {result && <p className="provider-tools-result" role="status">{result}</p>}
    {panel && <div className="settings-card stack provider-tools-panel"><div className="card-heading"><strong>{panel === 'import' ? '识别并导入 API 连接' : `导出全部 ${count} 个 API 连接`}</strong><button type="button" className="icon-button" aria-label="关闭 API 工具" disabled={localBusy && panel === 'export'} onClick={close}><X size={16}/></button></div>
      {panel === 'import' ? <>
        <p className="field-help">粘贴 New API 连接 JSON、Claude Code / OpenAI 环境变量，或本站备份。识别后可核对和修改，点击保存才会添加连接。</p>
        <label>连接配置<textarea value={input} onChange={event => { revision.current++; setInput(event.target.value); setPreview(null); setLocalBusy(false); }} onPaste={paste} rows={5} maxLength={2 * 1024 * 1024} spellCheck={false} autoComplete="off" placeholder={'{"_type":"newapi_channel_conn","key":"sk-XXX","url":"https://xxx.com"}'}/></label>
        <div className="provider-tools-file"><input ref={fileRef} type="file" accept=".json,.txt,.env,application/json,text/plain" hidden onChange={async event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 2 * 1024 * 1024) { setError('文件不能超过 2 MB。'); return; } loadText(await file.text()); event.target.value = ''; }}/><button className="button small" type="button" onClick={() => fileRef.current?.click()}><FileUp size={15}/>选择备份文件</button><small className="muted">配置只发给本站解析，不会测试或请求上游。</small></div>
        <label>备份密码（仅加密文件需要）<input type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} maxLength={1024}/></label>
        <button type="button" className="button" disabled={localBusy || !input.trim()} onClick={() => void recognize()}>{localBusy ? <LoaderCircle size={15} className="spin"/> : <KeyRound size={15}/>}识别配置</button>
        {preview && <div className="provider-import-preview"><strong>已识别 {preview.providers.length} 个连接</strong>{preview.warnings.map(warning => <p className="field-help" key={warning}>{warning}</p>)}{preview.providers.map((provider, index) => <div className="provider-import-item stack" key={index}><div className="form-grid"><label>连接名称<input value={provider.name} maxLength={80} onChange={event => update(index, { name: event.target.value })}/></label><label>API 地址<input value={provider.baseUrl} type="url" onChange={event => update(index, { baseUrl: event.target.value })}/></label></div><label>API Key<input type="password" autoComplete="new-password" value={provider.apiKey} onChange={event => update(index, { apiKey: event.target.value })}/></label><div className="form-grid"><label>运行方式<select value={provider.runtime} onChange={event => update(index, { runtime: event.target.value as ImportProvider['runtime'], ...(event.target.value === 'claude-code' ? { protocol: 'anthropic' } : {}) })}><option value="api">直接 API</option><option value="claude-code">Claude Code</option></select></label><label>接口协议<select value={provider.protocol} disabled={provider.runtime === 'claude-code'} onChange={event => update(index, { protocol: event.target.value as Protocol })}>{protocolOptions}</select></label></div><label>认证方式<select value={provider.authMode} onChange={event => update(index, { authMode: event.target.value as ImportProvider['authMode'] })}><option value="auto">自动（按协议）</option><option value="bearer">Authorization: Bearer</option><option value="x-api-key">x-api-key</option></select></label>{!!provider.models?.length && <small className="muted">同时恢复 {provider.models.length} 个模型映射；测试状态将重新验证。</small>}</div>)}<div className="form-actions"><button type="button" className="button primary" disabled={!!busy || localBusy} onClick={() => void saveImport()}><Upload size={15}/>保存 {preview.providers.length} 个连接</button></div></div>}
      </> : <form className="stack" onSubmit={event => { event.preventDefault(); void download(); }}>
        <p className="field-help">包含全部渠道设置、完整 API Key 和模型映射。下载后可在另一台服务器导入。</p>
        <label>保存格式<select value={format} onChange={event => setFormat(event.target.value as typeof format)}><option value="encrypted">加密备份（推荐）</option><option value="plain">明文 JSON</option></select></label>
        {format === 'plain' ? <div className="alert error">明文文件包含完整 API Key，持有文件的人可以使用这些密钥。请保存在私人位置。</div> : <label>设置备份密码<input type="password" required minLength={12} maxLength={1024} autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)}/><span className="field-help">至少 12 个字符。请单独保存密码，丢失后无法解密。</span></label>}
        <label>当前管理员账户密码<input type="password" required maxLength={1024} autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)}/><span className="field-help">导出会读取所有完整密钥，需要验证当前账户。</span></label>
        <div className="form-actions"><button className="button primary" disabled={localBusy}>{localBusy ? <LoaderCircle size={15} className="spin"/> : format === 'encrypted' ? <LockKeyhole size={15}/> : <Download size={15}/>}下载全部 API</button></div>
      </form>}
      {error && <div className="alert error" role="alert">{error}</div>}
    </div>}
  </div>;
}

export function ProviderBalance({ provider }: { provider: Provider }) {
  const [state, setState] = useState<BalanceState>({ adapter: 'none', balance: null }), [adapter, setAdapter] = useState<Adapter>('none'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [open, setOpen] = useState(false);
  useEffect(() => { let active = true; void api<BalanceState>(`/admin/providers/${provider.id}/balance`).then(value => { if (active) { setState(value); setAdapter(value.adapter); } }).catch(cause => { if (active) setError(errorText(cause)); }); return () => { active = false; }; }, [provider.id, provider.baseUrl, provider.keyHint]);
  async function refresh() { setBusy(true); setError(''); try { const value = await post<BalanceState>(`/admin/providers/${provider.id}/balance`, { adapter, refresh: adapter !== 'none' }); setState(value); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  const balance = state.balance, value = balance?.available ? balance.unlimited ? '令牌额度不限' : `${balance.remaining?.toLocaleString('zh-CN', { maximumFractionDigits: 4 }) ?? '未知'} ${balance.unit === 'USD' ? 'USD' : '额度'}` : '尚无可用余额信息';
  return <div className="provider-balance"><button type="button" className="provider-balance-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><span>余额 / 额度</span><strong>{value}</strong><span className="muted">{open ? '收起' : '查询设置'}</span></button>{open && <div className="provider-balance-details stack"><label>服务商余额接口<select value={adapter} onChange={event => setAdapter(event.target.value as Adapter)}><option value="none">未设置 / 服务商不支持</option><option value="newapi">New API 令牌额度</option><option value="openai-compatible">旧版 OpenAI 兼容账单</option></select><span className="field-help">按服务商说明选择。只查询本连接所在站点，不自动尝试其他接口。</span></label><button type="button" className="button small" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} className={busy ? 'spin' : ''}/>{adapter === 'none' ? '保存设置' : '保存并查询'}</button>{balance && <><p className="field-help">{balance.message}</p>{balance.available && <div className="provider-balance-values"><span>已用 {balance.used?.toLocaleString()}</span><span>总额 {balance.granted?.toLocaleString()}</span>{balance.expiresAt && <span>到期 {new Date(balance.expiresAt).toLocaleDateString()}</span>}</div>}{!!balance.modelLimits?.length && <p className="field-help">限用模型：{balance.modelLimits.join('、')}</p>}<small className="muted">查询于 {new Date(balance.checkedAt).toLocaleString()}</small></>}{error && <p className="alert error" role="alert">{error}</p>}</div>}</div>;
}
