import { useState, type FormEvent } from 'react';
import { Box, Check, ChevronDown, ChevronRight, Plus, Search, Trash2, X } from 'lucide-react';
import { api, remove } from '../../api';
import type { AdminModel, ModelGroup, Provider } from '../../types';
import type { RunAction } from './ProvidersPanel';
import './model-management.css';

interface DraftVariant { key: string; name: string; modelIds: string[]; retries?: string }
export default function ModelGroupsPanel({ groups, models, providers, busy, run }: { groups: ModelGroup[]; models: AdminModel[]; providers: Provider[]; busy: string; run: RunAction }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [variants, setVariants] = useState<DraftVariant[]>([]);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  function open(group?: ModelGroup) {
    setEditing(group?.name || ''); setName(group?.name || ''); setQuery(''); setError(''); setDeleting(false);
    setVariants((group?.variants || [{ name: '', modelIds: [] }]).map((variant, index) => {
      const values = new Set(variant.modelIds.map(id => models.find(model => model.id === id)?.retries ?? null));
      const value = values.size === 1 ? [...values][0] : undefined;
      return { ...variant, modelIds: [...variant.modelIds], key: `${index}-${Date.now()}`, ...(value !== undefined ? { retries: value === null ? '' : String(value) } : {}) };
    }));
  }
  function update(key: string, values: Partial<DraftVariant>) { setVariants(current => current.map(variant => variant.key === key ? { ...variant, ...values } : variant)); }
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!name.trim()) { setError('请填写用户看到的模型名称。'); return; }
    if (groups.some(group => group.name === name.trim() && group.name !== editing)) { setError('此模型名称已存在，请使用其他名称；如需调整已有模型，请关闭表单后选择该模型的“配置”。'); return; }
    const names = variants.map(variant => variant.name.trim());
    if (new Set(names).size !== names.length) { setError('同一模型中的版本名称不能重复；默认版本只能有一个。'); return; }
    const payload = { ...(editing ? { originalName: editing } : {}), name: name.trim(), variants: variants.map(variant => ({ name: variant.name.trim(), modelIds: variant.modelIds, ...(variant.retries !== undefined ? { retries: variant.retries === '' ? null : Number(variant.retries) } : {}) })) };
    if (await run('model-group-save', () => api('/admin/model-groups', { method: 'PUT', body: JSON.stringify(payload) }), '模型与版本已保存，所选渠道映射已更新。')) setEditing(null);
  }
  const providerName = (model: AdminModel) => model.providerName || providers.find(provider => provider.id === model.providerId)?.name || '已删除渠道';
  const visibleModels = models.filter(model => `${model.modelId} ${providerName(model)}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="admin-section">
    <div className="section-title"><div><h3>模型与版本</h3><p>先定义模型名称，再为各版本选择渠道中的上游模型。</p></div><button className="button small" onClick={() => open()} disabled={!!busy}><Plus size={15}/>新建模型</button></div>
    {editing !== null && <form className="settings-card stack" onSubmit={save}>
      <div className="card-heading"><strong>{editing ? `配置 ${editing}` : '新建模型'}</strong><button className="icon-button" type="button" onClick={() => setEditing(null)} aria-label="关闭模型配置"><X size={16}/></button></div>
      <label>模型名称<input value={name} onChange={event => setName(event.target.value)} required maxLength={300} placeholder="例如 GPT 或 Claude"/><span className="field-help">用户先选择此名称，再选择版本。已有模型可以直接改名，改名会保留已有设置。</span></label>
      <p className="field-help">版本名称由你定义，例如高智商、普通、降智；留空表示默认版本。一个上游记录只能绑定到一个版本。保存会启用选中记录，移出的记录会停用并保留；仅改模型名称时，保留原绑定的启用状态。</p>
      <label className="search-input bordered"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} aria-label="筛选可绑定的渠道模型" placeholder="筛选渠道或上游模型 ID"/></label>
      <div className="catalog-variant-list">{variants.map(variant => <fieldset className="catalog-variant" key={variant.key}>
        <div className="catalog-variant-title"><label>版本名称<input value={variant.name} onChange={event => update(variant.key, { name: event.target.value })} maxLength={100} placeholder="默认版本"/></label><button type="button" className="icon-button danger-text" aria-label={`移除版本 ${variant.name || '默认'}`} title="移除版本；保存后生效" onClick={() => setVariants(current => current.filter(item => item.key !== variant.key))}><Trash2 size={16}/></button></div>
        <div className="catalog-binding-list">{visibleModels.map(model => {
          const checked = variant.modelIds.includes(model.id);
          const assignedHere = variants.some(other => other.key !== variant.key && other.modelIds.includes(model.id));
          const provider = providers.find(item => item.id === model.providerId);
          return <label className={`catalog-binding ${model.available === false ? 'unavailable' : ''}`} key={model.id}><input type="checkbox" checked={checked} disabled={!!busy || assignedHere || (!checked && variant.modelIds.length >= 500)} onChange={event => update(variant.key, { modelIds: event.target.checked ? [...variant.modelIds, model.id] : variant.modelIds.filter(id => id !== model.id) })}/><span><strong>{providerName(model)}</strong><small>{model.modelId}</small><small>{assignedHere ? '已绑定到本模型的其他版本' : model.routeKey && model.routeKey !== (editing || name.trim()) ? `当前属于 ${model.routeKey}${model.variantName ? ` / ${model.variantName}` : ''}，选择后会转移` : model.available === false ? '上游不可用，保存后仍不会向用户显示' : provider?.enabled === false ? '渠道已停用' : checked ? '已选中' : '可绑定'}</small></span></label>;
        })}{!visibleModels.length && <p className="field-help">没有匹配的上游模型。请先在 API 连接中同步模型。</p>}</div>
        <p className="field-help">已选择 {variant.modelIds.length}/500 个渠道模型；同一版本内按渠道优先级切换。</p>
        <label>此版本各渠道的额外重试次数<input type="number" min={0} max={100} step={1} value={variant.retries ?? ''} onChange={event => update(variant.key, { retries: event.target.value })} placeholder="未修改，保留各渠道现有设置"/><span className="field-help">填写 5 表示每个渠道最多尝试 6 次；0 为只请求一次。独立配置优先于站点默认次数，当前请求会完成设定的重试后再切换渠道。清空已修改的输入可恢复继承。</span><span className="field-help">当前：{variant.modelIds.map(id => models.find(model => model.id === id)).filter((model): model is AdminModel => !!model).map(model => `${providerName(model)} ${model.retries == null ? '继承站点' : `最多 ${model.retries + 1} 次`}`).join('；') || '未绑定渠道'}</span></label>
      </fieldset>)}</div>
      <button type="button" className="button" disabled={!!busy || variants.length >= 100} onClick={() => setVariants(current => [...current, { key: `${Date.now()}-${current.length}`, name: '', modelIds: [] }])}><Plus size={15}/>添加版本</button>
      {!variants.length && <p className="field-help">当前只有模型名称，可保存为目录草稿。配置版本和可用渠道后才会向用户显示。</p>}
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="form-actions">{editing && <button className="button danger-text" type="button" disabled={!!busy} onClick={() => setDeleting(true)}><Trash2 size={15}/>删除模型</button>}<button className="button" type="button" onClick={() => setEditing(null)}>取消</button><button className="button primary" disabled={!!busy}><Check size={15}/>保存模型与版本</button></div>
      {deleting && editing && <div className="inline-confirm"><p>删除“{editing}”及其版本？绑定的上游模型会停用并保留，聊天记录保留。引用此模型的专属路由和套餐需要重新配置。</p><div className="button-group"><button type="button" className="button small" disabled={!!busy} onClick={() => setDeleting(false)}>取消删除</button><button type="button" className="button danger small" disabled={!!busy} onClick={async () => { if (await run('model-group-delete', () => remove(`/admin/model-groups/${encodeURIComponent(editing)}`), '模型已删除，上游记录已停用并保留。')) { setEditing(null); setDeleting(false); } }}>确认删除模型</button></div></div>}
    </form>}
    {!groups.length && editing === null && <div className="settings-empty"><Box size={27}/><h4>建立你的模型目录</h4><p>同一个模型可提供多个版本，每个版本对应一个或多个 API 渠道。</p><button className="button" onClick={() => open()}><Plus size={15}/>新建模型</button></div>}
    <div className="model-group-list">{groups.map(group => <section className="model-group" key={group.name}>
      <div className="catalog-group-heading"><button className="model-group-heading" aria-expanded={!!expanded[group.name]} onClick={() => setExpanded(current => ({ ...current, [group.name]: !current[group.name] }))}><Box size={18}/><span className="model-group-name"><strong>{group.name}</strong><small>{group.variants.length} 个版本</small></span>{expanded[group.name] ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}</button><button className="button small" onClick={() => open(group)} disabled={!!busy}>配置</button></div>
      {expanded[group.name] && <div className="catalog-version-summary">{group.variants.map(variant => <div key={variant.name}><strong>{variant.name || '默认版本'}</strong><span>{variant.modelIds.length ? `${variant.modelIds.length} 个渠道模型` : '草稿 · 未绑定渠道'}</span></div>)}{!group.variants.length && <p className="field-help">目录草稿，尚未配置版本。</p>}</div>}
    </section>)}</div>
  </div>;
}
