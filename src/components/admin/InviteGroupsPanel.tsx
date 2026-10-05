import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Check, Plus, Trash2 } from 'lucide-react';
import { api, errorText, patch, post, remove } from '../../api';
import type { AdminModel, ModelGroup, Provider, UserModelRoutingRule, UserModelRoutingTarget } from '../../types';
import type { BillingPlan } from '../../billingTypes';
import './invite-groups.css';

export interface InviteGroup { id: string; name: string; enabled: boolean; planId: string | null; duration: 'period' | 'permanent' | 'until'; activeUntil: string | null; rules: UserModelRoutingRule[]; createdAt: string; updatedAt: string }
type Draft = Pick<InviteGroup, 'name' | 'enabled' | 'planId' | 'duration' | 'activeUntil' | 'rules'>;
const empty = (): Draft => ({ name: '', enabled: true, planId: null, duration: 'period', activeUntil: null, rules: [] });
const efforts = [{ value: 'auto', label: '自动' }, { value: 'low', label: '轻量' }, { value: 'medium', label: '标准' }, { value: 'high', label: '深入' }, { value: 'xhigh', label: '更深入' }, { value: 'max', label: '最大' }];
const localTime = (value: string | null) => { if (!value) return ''; const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export default function InviteGroupsPanel({ groups, models, providers, onGroupsChange }: { groups: ModelGroup[]; models: AdminModel[]; providers: Provider[]; onGroupsChange: (groups: InviteGroup[]) => void }) {
  const [items, setItems] = useState<InviteGroup[]>([]), [plans, setPlans] = useState<BillingPlan[]>([]);
  const [editing, setEditing] = useState<string | null>(null), [draft, setDraft] = useState<Draft>(empty), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [retry, setRetry] = useState(0);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [removing, setRemoving] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all([api<{ groups: InviteGroup[] }>('/admin/invite-groups'), api<{ plans: BillingPlan[] }>('/admin/plans')])
      .then(([result, billing]) => { if (live) { setItems(result.groups); onGroupsChange(result.groups); setPlans(billing.plans); setLoaded(true); setError(''); } })
      .catch(cause => { if (live) setError(errorText(cause)); });
    return () => { live = false; };
  }, [onGroupsChange, retry]);
  const versions = groups.flatMap(group => group.variants.map(variant => ({ key: JSON.stringify([group.name, variant.name]), route: group.name, variant: variant.name, modelIds: variant.modelIds })));
  const activeModels = (route: string, variant: string) => models.filter(model => versions.find(item => item.route === route && item.variant === variant)?.modelIds.includes(model.id) && model.enabled && model.available !== false && providers.some(provider => provider.id === model.providerId && provider.enabled));
  const updateRule = (index: number, value: Partial<UserModelRoutingRule>) => setDraft(current => ({ ...current, rules: current.rules.map((rule, position) => position === index ? { ...rule, ...value } : rule) }));
  async function refresh() { const result = await api<{ groups: InviteGroup[] }>('/admin/invite-groups'); setItems(result.groups); onGroupsChange(result.groups); }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setNotice('');
    try {
      const body = { ...draft, activeUntil: draft.duration === 'until' && draft.activeUntil ? new Date(draft.activeUntil).toISOString() : null };
      if (editing === 'new') await post('/admin/invite-groups', body); else await patch(`/admin/invite-groups/${encodeURIComponent(editing!)}`, body);
      await refresh(); setEditing(null); setNotice('分组已保存，之后创建的邀请使用这份设置；已发出的邀请保留原配置。');
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  async function toggle(group: InviteGroup) {
    setBusy(true); setError(''); setNotice('');
    try { await patch(`/admin/invite-groups/${group.id}`, { enabled: !group.enabled }); await refresh(); setNotice(group.enabled ? '分组已停用，该分组未使用的邀请暂时不能注册。已加入成员不受影响。' : '分组已启用。'); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  }
  function routeSelect(route: string, variant: string, change: (route: string, variant: string) => void, label: string) {
    const key = JSON.stringify([route, variant]);
    return <label>{label}<select value={key} disabled={busy} onChange={event => { const selected = versions.find(item => item.key === event.target.value); if (selected) change(selected.route, selected.variant); }}>
      {!versions.some(item => item.key === key) && <option value={key}>{route || '未选择'} · {variant || '默认版本'}（已移除）</option>}
      {versions.map(item => <option key={item.key} value={item.key}>{item.route} · {item.variant || '默认版本'}{activeModels(item.route, item.variant).length ? '' : ' · 暂无可用渠道'}</option>)}
    </select></label>;
  }
  function effortSelect(target: UserModelRoutingTarget, change: (effort: string) => void) {
    const supported = new Set(activeModels(target.targetRouteKey, target.targetVariantName).flatMap(model => model.reasoningEfforts));
    return <label>执行思考强度<select value={target.effort} disabled={busy} onChange={event => change(event.target.value)}>{efforts.map(item => <option key={item.value} value={item.value} disabled={item.value !== 'auto' && !supported.has(item.value) && target.effort !== item.value}>{item.label}{item.value !== 'auto' && !supported.has(item.value) ? ' · 不支持' : ''}</option>)}</select></label>;
  }
  function addRule() {
    const source = versions.find(item => !draft.rules.some(rule => rule.sourceRouteKey === item.route && rule.sourceVariantName === item.variant));
    const target = versions.find(item => item.key !== source?.key && activeModels(item.route, item.variant).length);
    if (!source || !target) { setError('请先配置至少两个模型版本，并启用执行模型的渠道。'); return; }
    setDraft(current => ({ ...current, rules: [...current.rules, { sourceRouteKey: source.route, sourceVariantName: source.variant, targetRouteKey: target.route, targetVariantName: target.variant, enabled: true, effort: 'auto', fallbacks: [] }] }));
  }
  function addBackup(index: number, rule: UserModelRoutingRule) {
    const used = [rule, ...(rule.fallbacks || [])];
    const candidates = versions.flatMap(item => activeModels(item.route, item.variant).length ? ['auto', ...new Set(activeModels(item.route, item.variant).flatMap(model => model.reasoningEfforts))].map(effort => ({ targetRouteKey: item.route, targetVariantName: item.variant, effort })) : []);
    const target = candidates.find(candidate => !used.some(item => item.targetRouteKey === candidate.targetRouteKey && item.targetVariantName === candidate.targetVariantName && item.effort === candidate.effort));
    if (!target) { setError('当前可用的模型、版本与思考强度组合均已添加。'); return; }
    updateRule(index, { fallbacks: [...(rule.fallbacks || []), target] });
  }
  return <section className="invite-groups-panel settings-card">
    <div className="section-title"><div><h4>特殊邀请分组</h4><p>让指定邀请自带套餐和专属模型路由，注册成功后自动生效。</p></div><button type="button" className="button small" disabled={busy || !loaded} onClick={() => { setEditing('new'); setDraft(empty()); setError(''); setRemoving(null); }}><Plus size={14}/>新增分组</button></div>
    {error && <div className="alert error" role="alert">{error}</div>}{notice && <p className="field-help" role="status">{notice}</p>}
    {!loaded && <p className="field-help">{error ? <button type="button" className="button small" onClick={() => setRetry(value => value + 1)}>重新读取分组</button> : '正在读取邀请分组…'}</p>}
    {loaded && !items.length && editing === null && <p className="field-help">尚无特殊分组，普通邀请仍按站点免费配置注册。</p>}
    {items.map(group => <div className="invite-group-row" key={group.id}><div><strong>{group.name}</strong><span>{group.enabled ? '已启用' : '已停用'} · {group.planId === null ? '不指定套餐' : group.planId === 'free' ? '免费版' : plans.find(plan => plan.id === group.planId)?.name || '原套餐'} · {group.rules.length} 条专属路由</span></div><div className="invite-group-actions"><button type="button" className="button small" disabled={busy} onClick={() => { setEditing(group.id); setDraft({ name: group.name, enabled: group.enabled, planId: group.planId, duration: group.duration, activeUntil: group.activeUntil, rules: structuredClone(group.rules) }); setError(''); setRemoving(null); }}>编辑</button><button type="button" className="button small" disabled={busy} onClick={() => void toggle(group)}>{group.enabled ? '停用' : '启用'}</button><button type="button" className="icon-button danger-text" disabled={busy} aria-label={`删除分组 ${group.name}`} onClick={() => setRemoving(group.id)}><Trash2 size={15}/></button></div>{removing === group.id && <div className="invite-group-delete"><p>删除后，这个分组所有未使用的邀请都将失效，已加入成员的权益保留。</p><button type="button" className="button small" disabled={busy} onClick={() => setRemoving(null)}>取消</button><button type="button" className="button small danger-text" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await remove(`/admin/invite-groups/${group.id}`); await refresh(); setRemoving(null); if (editing === group.id) setEditing(null); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }}>确认删除</button></div>}</div>)}
    {editing !== null && <form className="invite-group-editor stack" onSubmit={save}><div className="form-grid"><label>分组名称<input required maxLength={80} disabled={busy} value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))}/></label><label>赠送套餐<select disabled={busy} value={draft.planId ?? ''} onChange={event => setDraft(current => ({ ...current, planId: event.target.value || null }))}><option value="">不指定套餐（使用站点默认）</option><option value="free">指定免费版</option>{draft.planId && draft.planId !== 'free' && !plans.some(plan => plan.id === draft.planId) && <option value={draft.planId}>原套餐（已移除）</option>}{plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}{plan.active ? '' : '（未上架）'}</option>)}</select></label></div>
      {draft.planId !== null && <div className="form-grid"><label>权益期限<select value={draft.duration} disabled={busy} onChange={event => setDraft(current => ({ ...current, duration: event.target.value as Draft['duration'] }))}><option value="period">从注册日起一个套餐周期</option><option value="permanent">长期有效</option><option value="until">指定截止时间</option></select></label>{draft.duration === 'until' && <label>截止时间（本机时区）<input type="datetime-local" required disabled={busy} value={localTime(draft.activeUntil)} onChange={event => setDraft(current => ({ ...current, activeUntil: event.target.value ? new Date(event.target.value).toISOString() : null }))}/></label>}</div>}
      <label className="checkbox-label"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => setDraft(current => ({ ...current, enabled: event.target.checked }))}/>启用分组</label>
      <p className="field-help">创建邀请时冻结套餐权益与路由；更改分组只影响新邀请。停用或删除分组会阻止旧链接注册。赠送只改变站内权益，不发起收费。</p>
      <div className="invite-group-routing">{draft.rules.map((rule, index) => <fieldset className="member-routing-rule" key={index}><div className="member-routing-heading"><strong>专属路由 {index + 1}</strong><label className="checkbox-label"><input type="checkbox" checked={rule.enabled} disabled={busy} onChange={event => updateRule(index, { enabled: event.target.checked })}/>启用</label><button type="button" className="icon-button danger-text" disabled={busy} aria-label={`删除邀请路由 ${index + 1}`} onClick={() => setDraft(current => ({ ...current, rules: current.rules.filter((_, position) => position !== index) }))}><Trash2 size={15}/></button></div>
        {routeSelect(rule.sourceRouteKey, rule.sourceVariantName, (sourceRouteKey, sourceVariantName) => updateRule(index, { sourceRouteKey, sourceVariantName }), '用户选择的模型版本')}
        <div className="form-grid">{routeSelect(rule.targetRouteKey, rule.targetVariantName, (targetRouteKey, targetVariantName) => updateRule(index, { targetRouteKey, targetVariantName, effort: 'auto' }), '后台首选执行模型')}{effortSelect(rule, effort => updateRule(index, { effort }))}</div>
        {(rule.fallbacks || []).map((target, backupIndex) => <div className="invite-group-backup" key={backupIndex}><div className="member-fallback-heading"><strong>备用方案 {backupIndex + 1}</strong><div>{[-1, 1].map(direction => <button type="button" className="icon-button" key={direction} disabled={busy || (direction < 0 ? backupIndex === 0 : backupIndex === (rule.fallbacks || []).length - 1)} aria-label={`${direction < 0 ? '上移' : '下移'}邀请备用方案 ${backupIndex + 1}`} onClick={() => { const fallbacks = [...(rule.fallbacks || [])]; [fallbacks[backupIndex], fallbacks[backupIndex + direction]] = [fallbacks[backupIndex + direction], fallbacks[backupIndex]]; updateRule(index, { fallbacks }); }}>{direction < 0 ? <ArrowUp size={14}/> : <ArrowDown size={14}/>}</button>)}<button type="button" className="icon-button danger-text" disabled={busy} aria-label={`删除邀请备用方案 ${backupIndex + 1}`} onClick={() => updateRule(index, { fallbacks: rule.fallbacks?.filter((_, position) => position !== backupIndex) })}><Trash2 size={14}/></button></div></div><div className="form-grid">{routeSelect(target.targetRouteKey, target.targetVariantName, (targetRouteKey, targetVariantName) => updateRule(index, { fallbacks: rule.fallbacks?.map((item, position) => position === backupIndex ? { targetRouteKey, targetVariantName, effort: 'auto' } : item) }), '备用执行模型')}{effortSelect(target, effort => updateRule(index, { fallbacks: rule.fallbacks?.map((item, position) => position === backupIndex ? { ...item, effort } : item) }))}</div></div>)}
        <button type="button" className="button small" disabled={busy} onClick={() => addBackup(index, rule)}><Plus size={14}/>添加备用方案</button>
      </fieldset>)}</div>
      <div className="form-actions"><button type="button" className="button small" disabled={busy || draft.rules.length >= 100} onClick={addRule}><Plus size={14}/>添加专属路由</button><button type="button" className="button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="button primary" disabled={busy}><Check size={14}/>保存分组</button></div>
    </form>}
  </section>;
}
