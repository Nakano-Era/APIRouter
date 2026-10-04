import { useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Check, LoaderCircle, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, errorText } from '../../api';
import type { AdminModel, ModelGroup, Provider, User, UserModelRoutingRule, UserModelRoutingTarget } from '../../types';
import type { RunAction } from './ProvidersPanel';

type DraftTarget = UserModelRoutingTarget & { key: string };
type DraftRule = Omit<UserModelRoutingRule, 'fallbacks'> & { key: string; fallbacks: DraftTarget[] };
let draftSequence = 0;
const draftKey = () => `routing-rule-${++draftSequence}`;
const selectionKey = (route: string, variant: string) => JSON.stringify([route, variant]);
const efforts = [{ value: 'auto', label: '自动' }, { value: 'low', label: '轻量' }, { value: 'medium', label: '标准' }, { value: 'high', label: '深入' }, { value: 'xhigh', label: '更深入' }, { value: 'max', label: '最大' }];
const draftRules = (rules: UserModelRoutingRule[]): DraftRule[] => rules.map(rule => ({ ...rule, key: draftKey(), fallbacks: (rule.fallbacks || []).map(target => ({ ...target, key: draftKey() })) }));

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
  function update(key: string, change: Partial<DraftRule>) {
    setRules(current => current.map(rule => rule.key === key ? { ...rule, ...change } : rule));
    setDirty(true); setSaved(false); setError('');
  }
  function add() {
    const source = versions.find(option => !rules.some(rule => rule.sourceRouteKey === option.route && rule.sourceVariantName === option.variant));
    if (!source) return;
    const target = versions.find(option => selectionKey(option.route, option.variant) !== selectionKey(source.route, source.variant) && available(option.route, option.variant))
      || versions.find(option => selectionKey(option.route, option.variant) !== selectionKey(source.route, source.variant));
    if (!target) return;
    setRules(current => [...current, { key: draftKey(), sourceRouteKey: source.route, sourceVariantName: source.variant, targetRouteKey: target.route, targetVariantName: target.variant, enabled: true, effort: 'auto', fallbacks: [] }]);
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
      const targets = new Set<string>();
      for (const [step, target] of [rule, ...rule.fallbacks].entries()) {
        const label = `第 ${index + 1} 条规则的${step ? `备用方案 ${step}` : '首选方案'}`;
        const identity = JSON.stringify([target.targetRouteKey, target.targetVariantName, target.effort]);
        if (targets.has(identity)) { setError(`${label}重复，请选择不同的模型、版本或思考强度。`); return; }
        targets.add(identity);
        if (rule.enabled && !available(target.targetRouteKey, target.targetVariantName)) { setError(`${label}暂无可用渠道，请启用对应渠道或停用此规则。`); return; }
        if (rule.enabled && target.effort !== 'auto' && !activeModels(target.targetRouteKey, target.targetVariantName).some(model => model.reasoningEfforts.includes(target.effort))) { setError(`${label}不支持所选思考强度，请选择“自动”或支持的强度。`); return; }
      }
    }
    await run(`model-routing-${user.id}`, async () => {
      try {
        const result = await api<{ rules: UserModelRoutingRule[] }>(`/admin/users/${encodeURIComponent(user.id)}/model-routing`, { method: 'PUT', body: JSON.stringify({ rules: rules.map(({ key: _key, fallbacks, ...rule }) => ({ ...rule, fallbacks: fallbacks.map(({ key: _backupKey, ...target }) => target) })) }) });
        setRules(draftRules(result.rules)); setDirty(false); setSaved(true);
      } catch (cause) { setError(errorText(cause)); throw cause; }
    });
  }
  function modelSelection(rule: DraftRule, side: 'source' | 'target', backup?: DraftTarget) {
    const route = side === 'source' ? rule.sourceRouteKey : (backup || rule).targetRouteKey;
    const variant = side === 'source' ? rule.sourceVariantName : (backup || rule).targetVariantName;
    const group = groups.find(item => item.name === route);
    const routeLabel = side === 'source' ? '用户选择的模型' : '后台实际模型';
    const variantLabel = side === 'source' ? '用户选择的版本' : '后台实际版本';
    const change = (nextRoute: string, nextVariant: string) => {
      const next = { targetRouteKey: nextRoute, targetVariantName: nextVariant, effort: 'auto' };
      update(rule.key, side === 'source' ? { sourceRouteKey: nextRoute, sourceVariantName: nextVariant } : backup ? { fallbacks: rule.fallbacks.map(item => item.key === backup.key ? { ...item, ...next } : item) } : next);
    };
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

  function effortSelection(rule: DraftRule, target: UserModelRoutingTarget, backup?: DraftTarget) {
    const supported = new Set(activeModels(target.targetRouteKey, target.targetVariantName).flatMap(model => model.reasoningEfforts));
    return <label className="member-routing-effort">执行思考强度<select value={target.effort} disabled={!!busy} onChange={event => update(rule.key, backup ? { fallbacks: rule.fallbacks.map(item => item.key === backup.key ? { ...item, effort: event.target.value } : item) } : { effort: event.target.value })}>{efforts.map(effort => <option key={effort.value} value={effort.value} disabled={effort.value !== 'auto' && !supported.has(effort.value) && effort.value !== target.effort}>{effort.label}{effort.value !== 'auto' && !supported.has(effort.value) ? ' · 目标不支持' : ''}</option>)}</select></label>;
  }
  function addBackup(rule: DraftRule) {
    const candidates = versions.filter(option => available(option.route, option.variant)).flatMap(option => ['auto', ...new Set(activeModels(option.route, option.variant).flatMap(model => model.reasoningEfforts))].map(effort => ({ targetRouteKey: option.route, targetVariantName: option.variant, effort })));
    const unused = candidates.filter(target => ![rule, ...rule.fallbacks].some(item => item.targetRouteKey === target.targetRouteKey && item.targetVariantName === target.targetVariantName && item.effort === target.effort));
    const target = unused.find(item => item.effort === 'auto') || unused[0];
    if (target) update(rule.key, { fallbacks: [...rule.fallbacks, { key: draftKey(), ...target }] });
    else setError('当前可用的模型、版本与思考强度组合均已添加。可先添加新的模型版本，再增加备用方案。');
  }
  function moveBackup(rule: DraftRule, index: number, offset: number) {
    const fallbacks = [...rule.fallbacks];
    [fallbacks[index], fallbacks[index + offset]] = [fallbacks[index + offset], fallbacks[index]];
    update(rule.key, { fallbacks });
  }

  return <details className="member-model-routing" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary aria-label={`${user.name}的专属模型路由`}>专属模型路由</summary>
    {expanded && <>
      <p className="field-help">仅对这位成员生效。界面和额度保持用户所选模型版本。首选方案失败、超时或上游明确报告未完成时，按顺序调用备用方案并携带已生成内容接续；手动停止不会触发回落。</p>
      {loading && <p className="field-help"><LoaderCircle className="spin" size={14}/>正在读取专属路由…</p>}
      {error && <div className="alert error" role="alert">{error}</div>}
      {!loaded && !loading && error && <button className="button small" onClick={() => setRetry(value => value + 1)}><RefreshCw size={14}/>重新读取</button>}
      {loaded && <form onSubmit={save}>
        <div className="member-routing-list">{rules.map((rule, index) => {
          return <fieldset className="member-routing-rule" key={rule.key}>
            <div className="member-routing-heading"><strong>规则 {index + 1}</strong><label className="checkbox-label"><input type="checkbox" checked={rule.enabled} disabled={!!busy} onChange={event => update(rule.key, { enabled: event.target.checked })}/>启用</label><button type="button" className="icon-button danger-text" aria-label={`删除专属路由规则 ${index + 1}`} disabled={!!busy} onClick={() => { setRules(current => current.filter(item => item.key !== rule.key)); setDirty(true); setSaved(false); setError(''); }}><Trash2 size={15}/></button></div>
            {modelSelection(rule, 'source')}
            <div className="member-routing-direction">↓ 首选方案 · 后台静默执行</div>
            {modelSelection(rule, 'target')}
            {effortSelection(rule, rule)}
            <p className="field-help">每个方案可单独设置思考强度；自动由目标模型决定。</p>
            <div className="member-fallback-list">{rule.fallbacks.map((target, backupIndex) => <div className="member-fallback-card" key={target.key}>
              <div className="member-fallback-heading"><strong>备用方案 {backupIndex + 1}</strong><div>
                <button type="button" className="icon-button" disabled={!!busy || backupIndex === 0} aria-label={`上移备用方案 ${backupIndex + 1}`} onClick={() => moveBackup(rule, backupIndex, -1)}><ArrowUp size={15}/></button>
                <button type="button" className="icon-button" disabled={!!busy || backupIndex === rule.fallbacks.length - 1} aria-label={`下移备用方案 ${backupIndex + 1}`} onClick={() => moveBackup(rule, backupIndex, 1)}><ArrowDown size={15}/></button>
                <button type="button" className="icon-button danger-text" disabled={!!busy} aria-label={`删除备用方案 ${backupIndex + 1}`} onClick={() => update(rule.key, { fallbacks: rule.fallbacks.filter(item => item.key !== target.key) })}><Trash2 size={15}/></button>
              </div></div>
              {modelSelection(rule, 'target', target)}{effortSelection(rule, target, target)}
            </div>)}</div>
            <button type="button" className="button small member-add-fallback" disabled={!!busy || !versions.some(option => available(option.route, option.variant))} onClick={() => addBackup(rule)}><Plus size={14}/>添加备用方案</button>
            <p className="field-help">备用方案数量不设固定上限，按从上到下的顺序执行；只使用这里列出的方案，不递归套用其他路由。每个方案内仍支持渠道切换。</p>
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
