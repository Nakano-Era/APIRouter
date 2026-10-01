import { useEffect, useState, type FormEvent } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { api, errorText } from '../../api';
import type { ModelGroup, ModelLimit, User } from '../../types';
import type { RunAction } from './ProvidersPanel';
import { modelLimitKey, versionLimitOptions } from './model-limit-options';

export default function MemberModelLimits({ user, groups, run, busy }: { user: User; groups: ModelGroup[]; run: RunAction; busy: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [limits, setLimits] = useState<ModelLimit[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expanded || loaded) return;
    let live = true; setLoading(true); setError('');
    api<{ limits: ModelLimit[] }>(`/admin/users/${user.id}/model-limits`).then(result => { if (live) { setLimits(result.limits); setLoaded(true); } }).catch(cause => { if (live) setError(errorText(cause)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [expanded, loaded, user.id]);
  const options = versionLimitOptions(groups, limits);
  function update(option: ModelLimit, field: 'dailyLimit' | 'monthlyLimit', value: string) {
    const key = modelLimitKey(option.routeKey, option.variantName || '');
    setLimits(current => [...current.filter(limit => modelLimitKey(limit.routeKey, limit.variantName || '') !== key), { ...option, variantName: option.variantName || '', [field]: value === '' ? null : Number(value) }]);
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    const payload = options.map(({ routeKey, variantName, dailyLimit, monthlyLimit }) => ({ routeKey, variantName: variantName || '', dailyLimit, monthlyLimit }));
    await run(`model-limits-${user.id}`, async () => { const result = await api<{ limits: ModelLimit[] }>(`/admin/users/${user.id}/model-limits`, { method: 'PUT', body: JSON.stringify({ limits: payload }) }); setLimits(result.limits); }, `${user.name} 的各版本额度已保存。`);
  }
  return <details className="member-model-limits" onToggle={event => setExpanded(event.currentTarget.open)}><summary>各模型版本使用额度</summary>{expanded && <>
    <p className="field-help">每个模型的每个版本分别计算额度，不与其他版本共用。留空不设置该项额外限制，0 表示禁止调用；仍受成员或套餐总额度限制。日/月按台北时间重置。</p>
    {loading && <p className="field-help"><LoaderCircle className="spin" size={14}/>正在读取额度…</p>}
    {error && <div className="alert error" role="alert">{error}</div>}
    {loaded && <form onSubmit={save}><div className="quota-list">{options.map(option => <div className="quota-row" key={modelLimitKey(option.routeKey, option.variantName || '')}><div className="quota-row-heading"><strong>{option.routeKey} · {option.variantName || '默认版本'}</strong><span>今日已用 {option.usedToday ?? '—'} · 本月已用 {option.usedMonth ?? '—'}</span></div><div className="form-grid"><label>每日请求上限<input type="number" min={0} max={1000000000} step={1} disabled={!!busy} value={option.dailyLimit ?? ''} onChange={event => update(option, 'dailyLimit', event.target.value)} placeholder="不限此项"/></label><label>每月请求上限<input type="number" min={0} max={1000000000} step={1} disabled={!!busy} value={option.monthlyLimit ?? ''} onChange={event => update(option, 'monthlyLimit', event.target.value)} placeholder="不限此项"/></label></div></div>)}</div>{!options.length && <p className="field-help">请先在模型目录中添加版本。空模型草稿无需配置额度。</p>}<div className="form-actions"><button className="button small" disabled={!!busy || !options.length}><Check size={14}/>保存各版本额度</button></div></form>}
  </>}</details>;
}
