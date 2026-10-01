import { useMemo, useState, type FormEvent } from 'react';
import { Box, Check, ChevronDown, ChevronRight, Eye, LoaderCircle, Pencil, Plus, RotateCcw, Search, Star, TestTubeDiagonal, Trash2, X } from 'lucide-react';
import { errorText, patch, post, remove } from '../../api';
import type { AdminModel, ModelGroup, Provider } from '../../types';
import ModelGroupsPanel from './ModelGroupsPanel';
import FailureOverrideFields, { failureOverrideValues } from './FailureOverrideFields';
import type { RunAction } from './ProvidersPanel';
import { effortLabels } from '../ChatControls';
import ModelTestResult, { type ModelTestReport, type ModelTestResponse } from './ModelTestResult';
function EffortFields({ values = [] }: { values?: string[] }) {
  return <fieldset className="model-effort-fields"><legend>支持的思考强度</legend><p className="field-help">自动始终可用。只勾选此模型和接口实际接受的参数，未勾选的选项不会向用户显示。</p><div className="model-effort-options">{['low', 'medium', 'high', 'xhigh', 'max'].map(value => <label className="checkbox-label compact" key={value}><input type="checkbox" name="reasoningEfforts" value={value} defaultChecked={values.includes(value)}/>{effortLabels[value]} <small>{value}</small></label>)}</div></fieldset>;
}
function CapacityFields({ model }: { model?: AdminModel }) {
  return <div className="form-grid"><label>上下文容量（tokens）<input name="contextWindow" type="number" min={1024} max={10000000} step={1} defaultValue={model?.contextWindow ?? ''} placeholder="未声明，留空"/><span className="field-help">以服务商的实际模型容量为准；留空不会猜测模型限制。</span></label><label>最大输出（tokens）<input name="maxOutputTokens" type="number" min={128} max={1000000} step={1} defaultValue={model?.maxOutputTokens ?? ''} placeholder="未设置，使用站点默认值"/><span className="field-help">单次调用的输出上限，不能超过模型实际支持的限制。</span></label></div>;
}
const capacityValues = (form: FormData) => ({ contextWindow: form.get('contextWindow') ? Number(form.get('contextWindow')) : null, maxOutputTokens: form.get('maxOutputTokens') ? Number(form.get('maxOutputTokens')) : null });
export default function ModelsPanel({ groups, ...props }: { groups: ModelGroup[]; models: AdminModel[]; providers: Provider[]; defaultModelId: string | null; run: RunAction; busy: string }) {
  const [view, setView] = useState<'catalog' | 'upstream'>('catalog');
  return <><div className="model-management-tabs" role="tablist" aria-label="模型管理"><button role="tab" aria-selected={view === 'catalog'} className={view === 'catalog' ? 'active' : ''} onClick={() => setView('catalog')}>模型与版本</button><button role="tab" aria-selected={view === 'upstream'} className={view === 'upstream' ? 'active' : ''} onClick={() => setView('upstream')}>上游模型与测试</button></div>{view === 'catalog' ? <ModelGroupsPanel groups={groups} models={props.models} providers={props.providers} busy={props.busy} run={props.run}/> : <UpstreamModelsPanel {...props}/>}</>;
}
function UpstreamModelsPanel({ models, providers, defaultModelId, run, busy }: { models: AdminModel[]; providers: Provider[]; defaultModelId: string | null; run: RunAction; busy: string }) {
  const [editing, setEditing] = useState<AdminModel | null>(null);
  const [testReport, setTestReport] = useState<ModelTestReport | null>(null);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [testing, setTesting] = useState<AdminModel | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const values = new Map<string, AdminModel[]>();
    for (const model of models) { const key = model.routeKey || model.modelId; values.set(key, [...(values.get(key) || []), model]); }
    return [...values.entries()].map(([key, channels]) => ({ key, channels, representative: channels.find(model => model.enabled && model.available !== false) || channels[0] }));
  }, [models]);
  const visible = groups.filter(group => group.channels.some(model => `${model.name} ${model.modelId} ${group.key} ${model.providerName || ''} ${providers.find(provider => provider.id === model.providerId)?.name || ''}`.toLowerCase().includes(query.toLowerCase())));
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const ok = await run('model-add', () => post('/admin/models', { providerId: form.get('providerId'), modelId: form.get('modelId'), name: form.get('name'), routeKey: form.get('routeKey') || undefined, vision: form.get('vision') === 'on', reasoningEfforts: form.getAll('reasoningEfforts'), ...capacityValues(form) }), '模型已添加。相同统一模型名的渠道已归入同一模型。');
    if (ok) setAdding(false);
  }
  async function test(model: AdminModel) {
    setTesting(null);
    await run(`test-${model.id}`, async () => {
      setTestReport(null); const started = Date.now();
      const context = { providerName: model.providerName || providers.find(provider => provider.id === model.providerId)?.name || '未知连接', modelId: model.modelId, testedAt: new Date().toISOString() };
      let result: ModelTestResponse;
      try { result = await post<ModelTestResponse>(`/admin/models/${model.id}/test`); }
      catch (error) { setTestReport({ ...context, result: { ok: false, error: errorText(error), latencyMs: Date.now() - started } }); throw error; }
      setTestReport({ ...context, result });
      if (!result.ok) throw new Error(result.error || '测试未通过。');
    }, '模型响应正常，测试通过。');
  }
  return <div className="admin-section">
    <div className="section-title"><div><h3>上游模型与测试</h3><p>测试渠道模型并调整能力；模型名称和版本请在“模型与版本”中配置。</p></div><button className="button small" onClick={() => setAdding(!adding)} disabled={!providers.length}><Plus size={15}/>添加渠道模型</button></div>
    {adding && <form className="settings-card stack" onSubmit={add}>
      <div className="card-heading"><strong>添加渠道模型</strong><button className="icon-button" type="button" aria-label="关闭" onClick={() => setAdding(false)}><X size={16}/></button></div>
      <p className="muted small-text">优先从 API 连接中同步模型；需要手动添加时，填写服务商提供的真实 ID。</p>
      <label>API 连接<select name="providerId" required>{providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name}</option>)}</select></label>
      <label>上游模型 ID<input name="modelId" placeholder="填写服务商提供的模型 ID" required/></label>
      <label>显示名称<input name="name" placeholder="可选，默认使用模型 ID"/></label>
      <label>统一模型名<input name="routeKey" placeholder="留空使用模型 ID" maxLength={120}/><span className="field-help">填写相同统一模型名的渠道会合并；失败时可以相互切换。</span></label>
      <label className="checkbox-label"><input name="vision" type="checkbox"/>支持图片输入</label><EffortFields/><CapacityFields/>
      <div className="form-actions"><button className="button primary" disabled={!!busy}>添加模型</button></div>
    </form>}
    {editing && <form className="settings-card stack" key={editing.id} onSubmit={async event => {
      event.preventDefault(); const form = new FormData(event.currentTarget);
      if (await run('model-edit', () => patch(`/admin/models/${editing.id}`, { name: form.get('name'), routeKey: form.get('routeKey'), variantName: form.get('variantName'), ...failureOverrideValues(form), reasoningEfforts: form.getAll('reasoningEfforts'), ...capacityValues(form) }), '渠道模型设置已保存。')) setEditing(null);
    }}>
      <div className="card-heading"><strong>编辑渠道模型</strong><button type="button" className="icon-button" aria-label="关闭编辑" onClick={() => setEditing(null)}><X size={16}/></button></div>
      <p className="muted small-text">{editing.providerName || providers.find(provider => provider.id === editing.providerId)?.name} · {editing.modelId}</p>
      <label>显示名称<input name="name" defaultValue={editing.name} required maxLength={120}/></label>
      <label>统一模型名<input name="routeKey" defaultValue={editing.routeKey || editing.modelId} required maxLength={120}/><span className="field-help">只合并能力相当、允许相互替代的模型。</span></label>
      <label>版本名称<input name="variantName" defaultValue={editing.variantName || ''} maxLength={100} placeholder="默认版本"/></label><EffortFields values={editing.reasoningEfforts}/><CapacityFields model={editing}/><FailureOverrideFields model={editing}/>
      <div className="form-actions"><button className="button primary" disabled={!!busy}>保存</button></div>
    </form>}
    <div className="search-input bordered"><Search size={16}/><input aria-label="搜索模型或渠道" placeholder="搜索模型或渠道" value={query} onChange={event => setQuery(event.target.value)}/><span className="muted small-text">{groups.length} 个模型</span></div>
    <p className="muted small-text" style={{ margin: '12px 0 16px' }}>成员只会看到模型名称。各渠道按优先级尝试，支持的思考强度会自动筛选匹配的渠道。</p>
    {models.length === 0 ? <div className="settings-empty"><div className="empty-icon"><Box size={26}/></div><h4>还没有模型</h4><p>先在“API 连接”中同步模型，<br/>也可以根据服务商文档手动添加。</p></div> : <div className="model-group-list">
      {!visible.length && <p className="menu-empty">没有找到匹配的模型或渠道。</p>}
      {visible.map(group => {
        const open = expanded.has(group.key) || !!query.trim();
        const enabled = group.channels.filter(model => model.enabled && model.available !== false).length;
        const isDefault = group.channels.some(model => model.id === defaultModelId);
        return <section className="model-group" key={group.key}>
          <button className="model-group-heading" aria-expanded={open} onClick={() => setExpanded(current => { const next = new Set(current); next.has(group.key) ? next.delete(group.key) : next.add(group.key); return next; })}>
            <Box size={19}/><span className="model-group-name"><strong>{group.representative.name}</strong>{isDefault && <span className="default-badge">默认</span>}<small>{group.key}</small></span><span className="model-group-count">{enabled}/{group.channels.length} 渠道启用</span>{open ? <ChevronDown size={17}/> : <ChevronRight size={17}/>}
          </button>
          {open && <div className="model-group-channels">{group.channels.map(model => {
            const providerName = model.providerName || providers.find(provider => provider.id === model.providerId)?.name || '已删除的渠道';
            return <div className={`model-admin-row ${model.available === false ? 'unavailable' : ''}`} key={model.id}>
              <div className="model-admin-main"><div><strong>{providerName}</strong><small>上游 ID：{model.modelId}</small><small>版本：{model.variantName || '默认版本'}</small><small>思考：{(model.reasoningEfforts?.length ? ['auto', ...model.reasoningEfforts.filter(value => value !== 'auto')] : ['auto']).map(value => effortLabels[value] || value).join('、')}</small></div><button className={`toggle ${model.enabled ? 'on' : ''}`} role="switch" aria-checked={model.enabled} aria-label={`启用 ${providerName} 的 ${model.modelId}`} disabled={!!busy || model.available === false} onClick={() => void run(`toggle-${model.id}`, () => patch(`/admin/models/${model.id}`, { enabled: !model.enabled }))}><span/></button></div>
              <div className="model-admin-meta"><span className={`model-status ${model.status}`}>{model.available === false ? '上游已不可用' : model.status === 'ok' ? '连接正常' : model.status === 'error' ? '测试失败' : '尚未测试'}</span>
                <label className="checkbox-label compact"><input type="checkbox" checked={model.vision} disabled={!!busy} onChange={event => void run(`vision-${model.id}`, () => patch(`/admin/models/${model.id}`, { vision: event.target.checked }))}/><Eye size={12}/>识图</label>
                <div className="model-row-actions">
                  <button className="icon-button" title="编辑名称、路由、思考强度与容量" aria-label={`编辑 ${providerName} 的模型`} disabled={!!busy} onClick={() => setEditing(model)}><Pencil size={14}/></button>
                  <button className="icon-button" title="重置失败记录和冷却状态" aria-label={`重置 ${providerName} 健康状态`} disabled={!!busy || (!model.failureCount && !model.cooldownUntil)} onClick={() => void run(`reset-${model.id}`, () => post(`/admin/models/${model.id}/reset-health`), '冷却与失败记录已重置。')}><RotateCcw size={14}/></button>
                  <button className={`icon-button ${defaultModelId === model.id ? 'star-active' : ''}`} title="设为默认模型" aria-label={`将 ${model.name} 设为默认模型`} disabled={!!busy || !model.enabled || model.available === false} onClick={() => void run(`default-${model.id}`, () => patch(`/admin/models/${model.id}`, { isDefault: true }), '默认模型已更新。')}><Star size={14}/></button>
                  <button className="icon-button" title="测试模型（消耗少量额度）" aria-label={`测试 ${providerName} 的 ${model.modelId}`} disabled={!!busy || model.available === false} onClick={() => setTesting(model)}>{busy === `test-${model.id}` ? <LoaderCircle size={14} className="spin"/> : <TestTubeDiagonal size={14}/>}</button>
                  <button className="icon-button danger-text" title="移除该渠道的模型" aria-label={`删除 ${providerName} 的模型`} disabled={!!busy} onClick={() => setDeleting(model.id)}><Trash2 size={14}/></button>
                </div>
              </div>
              {(!!model.failureCount || !!model.cooldownUntil) && <p className="model-health">连续失败 {model.failureCount || 0} 次{model.cooldownUntil && new Date(model.cooldownUntil) > new Date() ? ` · 冷却至 ${new Date(model.cooldownUntil).toLocaleTimeString('zh-CN')}` : ''}</p>}
              {model.error && <p className="model-error">{model.error}</p>}
              {deleting === model.id && <div className="inline-confirm"><span>移除此渠道的模型？其他渠道会保留。</span><div className="button-group"><button className="button small" onClick={() => setDeleting(null)}>取消</button><button className="button danger small" disabled={!!busy} onClick={async () => { if (await run('model-delete', () => remove(`/admin/models/${model.id}`))) setDeleting(null); }}>移除</button></div></div>}
            </div>;
          })}</div>}
        </section>;
      })}
    </div>}
    {testReport && <ModelTestResult report={testReport} onClose={() => setTestReport(null)}/>}
    {testing && <div className="settings-card test-confirm"><strong>测试 {testing.name}</strong><p className="muted">{testing.providerName} · {testing.modelId}</p><p className="muted">将向服务商发起一次真实的简短请求，会消耗少量 API 额度。</p><div className="form-actions"><button className="button" onClick={() => setTesting(null)}>取消</button><button className="button primary" disabled={!!busy} onClick={() => void test(testing)}><Check size={15}/>开始测试</button></div></div>}
  </div>;
}
