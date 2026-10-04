import { useState, type FormEvent } from 'react';
import { Check, Eye, EyeOff, KeyRound, Link, Pencil, Plus, RefreshCw, Search, Server, Trash2, X } from 'lucide-react';
import type { Provider } from '../../types';
import { patch, post, remove } from '../../api';
import ProviderTools, { ProviderBalance } from './ProviderTools';
import ResponsesProfileField from './ResponsesProfileField';
import { orderedProviders } from './upstream-model-options';
export type RunAction = (key: string, action: () => Promise<unknown>, success?: string) => Promise<boolean>;
export default function ProvidersPanel({ providers, run, busy }: { providers: Provider[]; run: RunAction; busy: string }) {
  const [editing, setEditing] = useState<Provider | 'new' | null>(null), [reveal, setReveal] = useState(false), [deleting, setDeleting] = useState<string | null>(null), [search, setSearch] = useState('');
  const [failureProtectionEnabled, setFailureProtectionEnabled] = useState(true);
  const [responsesProfile, setResponsesProfile] = useState<NonNullable<Provider['responsesProfile']>>('auto');
  const [runtime, setRuntime] = useState<'api' | 'claude-code'>('api'), [protocol, setProtocol] = useState<Provider['protocol']>('openai-chat');
  const item = editing && editing !== 'new' ? editing : undefined;
  function edit(value: Provider | 'new') { setEditing(value); setReveal(false); setFailureProtectionEnabled(value === 'new' ? true : value.failureProtectionEnabled !== false); setResponsesProfile(value === 'new' ? 'auto' : value.responsesProfile || 'auto'); setRuntime(value === 'new' ? 'api' : value.runtime ?? 'api'); setProtocol(value === 'new' ? 'openai-chat' : value.protocol); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const body = { name: String(data.get('name')), baseUrl: String(data.get('baseUrl')), protocol, runtime, responsesProfile, apiKey: String(data.get('apiKey')), enabled: data.get('enabled') === 'on', priority: Number(data.get('priority')), failureProtectionEnabled, failureThreshold: Number(data.get('failureThreshold') ?? item?.failureThreshold ?? 3), cooldownSeconds: data.get('cooldownMinutes') == null ? item?.cooldownSeconds ?? 60 : Math.round(Number(data.get('cooldownMinutes')) * 60), authMode: data.get('authMode') };
    const ok = await run('provider-save', () => item ? patch(`/admin/providers/${item.id}`, body) : post('/admin/providers', body), '连接设置已保存。现在可以同步并测试模型。');
    if (ok) { setEditing(null); setReveal(false); }
  }
  const visible = orderedProviders(providers).filter(provider => `${provider.name} ${provider.baseUrl}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="admin-section">
    <div className="section-title"><div><h3>API 连接</h3><p>集中管理渠道和密钥，普通用户只看到统一模型。</p></div><button className="button primary small" onClick={() => edit('new')}><Plus size={15}/>添加连接</button></div>
    <p className="provider-workflow"><span>① 添加或导入连接</span><span>→</span><span>② 同步模型</span><span>→</span><span>③ 在模型页测试并启用</span></p>
    <ProviderTools run={run} busy={busy} count={providers.length}/>
    {editing && <form className="settings-card stack" onSubmit={submit} key={item?.id || 'new'}>
      <div className="card-heading"><strong>{item ? '编辑连接' : '添加 API 连接'}</strong><button type="button" className="icon-button" aria-label="关闭编辑" onClick={() => setEditing(null)}><X size={16}/></button></div>
      <label>连接名称<input name="name" defaultValue={item?.name} placeholder="例如 AnyRouter" required maxLength={80}/></label>
      <label>API 地址<input name="baseUrl" type="url" defaultValue={item?.baseUrl} placeholder="https://your-api.example.com/v1" required/><span className="field-help">填写服务商提供的 API Base URL，可包含 /v1 路径。</span></label>
      <div className="form-grid"><label>运行方式<select value={runtime} onChange={event => { const next = event.target.value as typeof runtime; setRuntime(next); if (next === 'claude-code') setProtocol('anthropic'); }}><option value="api">直接 API（Chat / Work）</option><option value="claude-code">Claude Code（可选）</option></select></label><label>接口协议<select value={protocol} disabled={runtime === 'claude-code'} onChange={event => setProtocol(event.target.value as typeof protocol)}><option value="openai-chat">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic">Anthropic Messages</option></select></label></div>
      {protocol === 'openai-responses' && <ResponsesProfileField value={responsesProfile} onChange={setResponsesProfile}/>}
      {runtime === 'api' && <p className="field-help provider-runtime-note">Chat 直接调用模型；Work 在 Docker 沙箱中执行工具操作，无需配置 Claude Code。模型需支持所选协议的工具调用。</p>}{runtime === 'claude-code' && <p className="field-help provider-runtime-note">由服务器内的 Claude Code 执行，使用 Anthropic 协议和允许 Claude Code 接入的密钥。GPT / Responses 模型请单独添加直接 API 渠道。需要已启用 Docker 运行环境。</p>}
      <label>API Key<div className="secret-input"><input name="apiKey" type={reveal ? 'text' : 'password'} required={!item} autoComplete="new-password" placeholder={item?.hasKey ? `已保存 ${item.keyHint || '••••'}；留空保留原密钥` : '输入你的 API Key'}/><button type="button" className="icon-button" onClick={() => setReveal(!reveal)} aria-label={reveal ? '隐藏密钥' : '显示密钥'}>{reveal ? <EyeOff size={16}/> : <Eye size={16}/>}</button></div><span className="field-help">密钥在服务器加密保存。普通成员无法读取，完整导出需要验证管理员密码。</span></label>
      <label>密钥认证方式<select name="authMode" defaultValue={item?.authMode || 'auto'}><option value="auto">自动（按接口协议）</option><option value="bearer">Authorization: Bearer</option><option value="x-api-key">x-api-key</option></select><span className="field-help">使用 ANTHROPIC_AUTH_TOKEN 的服务商一般选择 Bearer。</span></label>
      <details><summary>失败切换与渠道优先级</summary><div className="stack"><div className="form-grid"><label>渠道优先级<input name="priority" type="number" min="0" max="1000" defaultValue={item?.priority ?? 0} required/><span className="field-help">同一统一模型下，数值越高越先尝试。</span></label><label>连续失败次数<input name="failureThreshold" type="number" min="1" max="1000" defaultValue={item?.failureThreshold ?? 3} required disabled={!failureProtectionEnabled}/></label></div><label className="checkbox-label"><input type="checkbox" checked={failureProtectionEnabled} onChange={event => setFailureProtectionEnabled(event.target.checked)}/>启用失败自动冷却</label><label>冷却时间（分钟）<input name="cooldownMinutes" type="number" min={1 / 60} max="43200" step="any" defaultValue={(item?.cooldownSeconds ?? 60) / 60} required disabled={!failureProtectionEnabled}/><span className="field-help">连续失败达到阈值后暂时跳过，冷却结束允许重新尝试。</span></label></div></details>
      <label className="checkbox-label"><input type="checkbox" name="enabled" defaultChecked={item?.enabled ?? true}/>启用此连接</label>
      <div className="form-actions"><button type="button" className="button" onClick={() => setEditing(null)}>取消</button><button className="button primary" disabled={!!busy}><Check size={15}/>保存连接</button></div>
    </form>}
    {providers.length > 3 && <label className="provider-search"><span><Search size={14}/> 搜索连接</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="按名称或地址查找"/></label>}
    {providers.length === 0 && !editing && <div className="settings-empty"><div className="empty-icon"><Server size={27}/></div><h4>连接你的第一个 API</h4><p>粘贴连接配置，或手动填写地址和密钥。<br/>同步并测试后，再启用要使用的模型。</p><button className="button" onClick={() => edit('new')}><Plus size={16}/>添加 API 连接</button></div>}
    {providers.length > 0 && !visible.length && <p className="muted">没有匹配的连接。</p>}
    {visible.map(provider => <div className="settings-card provider-card" key={provider.id}>
      <div className="provider-heading"><span className="provider-icon"><Server size={19}/></span><div><strong>{provider.name}</strong><span className="provider-protocol">{provider.runtime === 'claude-code' ? 'Claude Code · ' : ''}{provider.protocol === 'anthropic' ? 'Anthropic Messages' : provider.protocol === 'openai-responses' ? 'OpenAI Responses' : 'OpenAI Chat Completions'}</span></div><span className={`status-pill ${provider.enabled ? 'success' : ''}`}>{provider.enabled ? '已启用' : '已停用'}</span></div>
      <p className="provider-detail"><Link size={13}/><span>{provider.baseUrl}</span></p><p className="provider-detail"><KeyRound size={13}/>{provider.hasKey ? provider.keyHint || '密钥已保存' : '未配置密钥'}</p>
      <div className="provider-routing-summary"><span>优先级 {provider.priority ?? 0}</span><span>{provider.failureProtectionEnabled === false ? '自动冷却已关闭' : `失败 ${provider.failureThreshold ?? 3} 次后冷却 ${((provider.cooldownSeconds ?? 60) / 60).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 分钟`}</span><span>{provider.authMode === 'bearer' ? 'Bearer 认证' : provider.authMode === 'x-api-key' ? 'API Key 认证' : '自动认证'}</span></div>
      {provider.lastSyncError && <div className="alert error">同步失败：{provider.lastSyncError}</div>}
      <div className="provider-footer"><small className="muted">{provider.lastSyncedAt ? `同步于 ${new Date(provider.lastSyncedAt).toLocaleString('zh-CN')}` : '下一步：同步模型'}</small><div className="button-group"><button className="button small" disabled={!!busy} onClick={() => void run(`sync-${provider.id}`, () => post(`/admin/providers/${provider.id}/sync`), '模型列表已同步。请在“模型”中测试并启用需要的模型。')}><RefreshCw size={14} className={busy === `sync-${provider.id}` ? 'spin' : ''}/>同步模型</button><button className="icon-button" title="编辑连接" aria-label={`编辑 ${provider.name}`} onClick={() => edit(provider)} disabled={!!busy}><Pencil size={15}/></button><button className="icon-button danger-text" title="删除连接" aria-label={`删除 ${provider.name}`} onClick={() => setDeleting(provider.id)} disabled={!!busy}><Trash2 size={15}/></button></div></div>
      <ProviderBalance provider={provider}/>
      {deleting === provider.id && <div className="inline-confirm"><p>删除此连接及关联模型？现有聊天记录会保留。</p><div className="button-group"><button className="button small" onClick={() => setDeleting(null)}>取消</button><button className="button danger small" disabled={!!busy} onClick={async () => { if (await run('provider-delete', () => remove(`/admin/providers/${provider.id}`), '连接已删除。')) setDeleting(null); }}>确认删除</button></div></div>}
    </div>)}
  </div>;
}
