import { useEffect, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, errorText } from '../../api';
import type { AdminModel, ModelGroup, Provider, User, UserModelRoutingRule } from '../../types';
import type { RunAction } from './ProvidersPanel';

type DraftRule = UserModelRoutingRule & { key: string };
let draftSequence = 0;
const draftKey = () => `routing-rule-${++draftSequence}`;
const selectionKey = (route: string, variant: string) => JSON.stringify([route, variant]);
const efforts = [{ value: 'auto', label: '自动' }, { value: 'low', label: '轻量' }, { value: 'medium', label: '标准' }, { value: 'high', label: '深入' }, { value: 'xhigh', label: '更深入' }, { value: 'max', label: '最大' }];
const draftRules = (rules: UserModelRoutingRule[]): DraftRule[] => rules.map(rule => ({ ...rule, key: draftKey() }));

export default function MemberModelRouting({ user, groups, models, providers, run, busy }: { user: User; groups: ModelGroup[]; models: AdminModel[]; providers: Provider[]; run: RunAction; busy: string }) {
  const [expanded, setExpanded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [rules, setRules] = useState<DraftRule[]>([]);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!expanded || loaded) return;
    let live = true; setLoading(true); setError('');
    api<{ rules: UserModelRoutingRule[] }>(`/admin/users/${encodeURIComponent(user.id)}/model-routing`)
      .then(result => { if (live) { setRules(draftRules(result.rules)); setLoaded(true); } })
      .catch(cause => { if (live) setError(errorText(cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [expanded, loaded, retry, user.id]);

  const versions = groups.flatMap(group => group.variants.map(variant => ({ route: group.name, variant: variant.name, modelIds: variant.modelIds })));
  const activeModels = (route: string, variant: string) => {
    const ids = versions.find(option => option.route === route && option.variant === variant)?.modelIds || [];
    return models.filter(model => ids.includes(model.id) && model.enabled && model.available !== false && providers.some(provider => provider.id === model.providerId && provider.enabled));
  };
  const available = (route: string, variant: string) => activeModels(route, variant).length > 0;
  function update(key: string, change: Partial<UserModelRoutingRule>) {
    setRules(current => current.map(rule => rule.key === key ? { ...rule, ...change } : rule));
    setDirty(true); setSaved(false); setError('');
  }
  function add() {
    const source = versions.find(option => !rules.some(rule => rule.sourceRouteKey === option.route && rule.sourceVariantName === option.variant));
    if (!source) return;
    const target = versions.find(option => selectionKey(option.route, option.variant) !== selectionKey(source.route, source.variant) && available(option.route, option.variant))
      || versions.find(option => selectionKey(option.route, option.variant) !== selectionKey(source.route, source.variant));
    if (!target) return;
    setRules(current => [...current, { key: draftKey(), sourceRouteKey: source.route, sourceVariantName: source.variant, targetRouteKey: target.route, targetVariantName: target.variant, enabled: true, effort: 'auto' }]);
    setDirty(true); setSaved(false); setError('');
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError(''); setSaved(false);
    const sources = new Set<string>();
    for (const [index, rule] of rules.entries()) {
      const source = selectionKey(rule.sourceRouteKey, rule.sourceVariantName);
      if (sources.has(source)) { setError(`第 ${index + 1} 条规则的来源重复。每个模型版本只能配置一条专属路由。`); return; }
      sources.add(source);
      if (source === selectionKey(rule.targetRouteKey, rule.targetVariantName)) { setError(`第 ${index + 1} 条规则的来源和目标相同，请选择不同的模型或版本。`); return; }
      if (rule.enabled && !versions.some(option => option.route === rule.sourceRouteKey && option.variant === rule.sourceVariantName)) { setError(`第 ${index + 1} 条规则的来源已从模型目录移除，请重新选择，或停用此规则后保存。`); return; }
      if (rule.enabled && !available(rule.targetRouteKey, rule.targetVariantName)) { setError(`第 ${index + 1} 条规则的目标暂无可用渠道，请先启用目标渠道，或停用此规则后保存。`); return; }
      if (rule.enabled && rule.effort !== 'auto' && !activeModels(rule.targetRouteKey, rule.targetVariantName).some(model => model.reasoningEfforts.includes(rule.effort))) { setError(`第 ${index + 1} 条规则的思考强度不受目标模型支持，请选择“自动”或目标支持的强度。`); return; }
    }
    await run(`model-routing-${user.id}`, async () => {
      try {
        const result = await api<{ rules: UserModelRoutingRule[] }>(`/admin/users/${encodeURIComponent(user.id)}/model-routing`, { method: 'PUT', body: JSON.stringify({ rules: rules.map(({ key: _key, ...rule }) => rule) }) });
        setRules(draftRules(result.rules)); setDirty(false); setSaved(true);
      } catch (cause) { setError(errorText(cause)); throw cause; }
    });
  }
  function modelSelection(rule: DraftRule, side: 'source' | 'target') {
    const route = side === 'source' ? rule.sourceRouteKey : rule.targetRouteKey;
    const variant = side === 'source' ? rule.sourceVariantName : rule.targetVariantName;
    const group = groups.find(item => item.name === route);
    const routeLabel = side === 'source' ? '用户选择的模型' : '后台实际模型';
    const variantLabel = side === 'source' ? '用户选择的版本' : '后台实际版本';
    const change = (nextRoute: string, nextVariant: string) => update(rule.key, side === 'source' ? { sourceRouteKey: nextRoute, sourceVariantName: nextVariant } : { targetRouteKey: nextRoute, targetVariantName: nextVariant, effort: 'auto' });
    return <div className="form-grid">
      <label>{routeLabel}<select value={route} disabled={!!busy} onChange={event => { const next = groups.find(item => item.name === event.target.value); change(event.target.value, next?.variants[0]?.name || ''); }}>
        {!group?.variants.length && <option value={route}>{route || '未选择'}（{group ? '暂无版本' : '已移除'}）</option>}
        {groups.filter(item => item.variants.length).map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
      </select></label>
      <label>{variantLabel}<select value={variant} disabled={!!busy} onChange={event => change(route, event.target.value)}>
        {!group?.variants.some(item => item.name === variant) && <option value={variant}>{variant || '默认版本'}（已移除）</option>}
        {group?.variants.map(item => <option key={item.name} value={item.name}>{item.name || '默认版本'}{!available(route, item.name) ? ' · 暂无可用渠道' : ''}</option>)}
      </select></label>
    </div>;
  }

  return <details className="member-model-routing" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>专属模型路由</summary>
    {expanded && <>
      <p className="field-help">仅对这位成员生效。用户界面保留所选模型和版本，后台使用指定目标回答；额度计入用户选择的原模型版本。请求失败仅在目标版本绑定的渠道内切换，不会回到原模型，也不会继续套用其他专属路由。</p>
      {loading && <p className="field-help"><LoaderCircle className="spin" size={14}/>正在读取专属路由…</p>}
      {error && <div className="alert error" role="alert">{error}</div>}
      {!loaded && !loading && error && <button className="button small" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14}/>重新读取</button>}
      {loaded && <form onSubmit={save}>
        <div className="member-routing-list">{rules.map((rule, index) => {
          const supportedEfforts = new Set(activeModels(rule.targetRouteKey, rule.targetVariantName).flatMap(model => model.reasoningEfforts));
          return <fieldset className="member-routing-rule" key={rule.key}>
            <div className="member-routing-heading"><strong>规则 {index + 1}</strong><label className="checkbox-label"><input type="checkbox" checked={rule.enabled} disabled={!!busy} onChange={event => update(rule.key, { enabled: event.target.checked })}/>启用</label><button type="button" className="icon-button danger-text" aria-label={`删除专属路由规则 ${index + 1}`} disabled={!!busy} onClick={() => { setRules(current => current.filter(item => item.key !== rule.key)); setDirty(true); setSaved(false); setError(''); }}><Trash2 size={15}/></button></div>
            {modelSelection(rule, 'source')}
            <div className="member-routing-direction" aria-hidden="true">↓ 后台静默执行</div>
            {modelSelection(rule, 'target')}
            <label className="member-routing-effort">执行思考强度<select value={rule.effort} disabled={!!busy} onChange={event => update(rule.key, { effort: event.target.value })}>{efforts.map(effort => <option key={effort.value} value={effort.value} disabled={effort.value !== 'auto' && !supportedEfforts.has(effort.value) && effort.value !== rule.effort}>{effort.label}{effort.value !== 'auto' && !supportedEfforts.has(effort.value) ? ' · 目标不支持' : ''}</option>)}</select><span className="field-help">此设置覆盖用户本次选择的思考强度；自动由目标模型决定。</span></label>
          </fieldset>;
        })}</div>
        {!rules.length && <p className="field-help">尚未设置专属路由，这位成员将使用自己选择的模型。</p>}
        <div className="member-routing-actions"><button type="button" className="button small" disabled={!!busy || rules.length >= 100 || versions.length < 2 || versions.every(option => rules.some(rule => rule.sourceRouteKey === option.route && rule.sourceVariantName === option.variant))} onClick={add}><Plus size={14}/>添加专属路由</button><button className="button small" disabled={!!busy || !dirty}>{busy === `model-routing-${user.id}` ? <LoaderCircle className="spin" size={14}/> : <Check size={14}/>}保存专属路由</button></div>
        {versions.length < 2 && <p className="field-help">请先在模型目录中配置至少两个模型版本。</p>}
        {dirty && <p className="field-help">有未保存的修改；删除或停用规则后，保存即可恢复原模型路由。</p>}
        {saved && !dirty && <p className="member-routing-saved" role="status"><Check size={14}/>专属路由已保存，下次请求生效。</p>}
      </form>}
    </>}
  </details>;
}
