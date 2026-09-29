import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Check, CheckCircle2, CreditCard, Layers3, LoaderCircle, Pencil, Plus, RefreshCw, ReceiptText, X } from 'lucide-react';
import { api, errorText, patch, post } from '../../api';
import { billingDate, formatPrice, intervalLabel, type BillingPlan, type BillingRequest, type BillingSettings } from '../../billingTypes';
import type { Model } from '../../types';
import '../../billing.css';

type BillingTab = 'plans' | 'payments' | 'requests';
const statusLabels = { pending: '待审核', approved: '已同意', rejected: '已拒绝' };

// All supported currencies have two decimal places. Avoid floating-point rounding of prices.
function priceToCents(value: string) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('价格最多填写两位小数。');
  const [whole, decimal = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < 1) throw new Error('请输入有效价格。');
  return cents;
}

export default function BillingPanel({ onChanged }: { onChanged?: () => void | Promise<void> }) {
  const [tab, setTab] = useState<BillingTab>('plans');
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [requests, setRequests] = useState<BillingRequest[]>([]);
  const [settings, setSettings] = useState<BillingSettings | null>(null);
  const [routes, setRoutes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<BillingPlan | 'new' | null>(null);
  const [selectedRoutes, setSelectedRoutes] = useState<string[]>([]);
  const [freeRoutes, setFreeRoutes] = useState<string[]>([]);
  const [review, setReview] = useState<{ request: BillingRequest; decision: 'approve' | 'reject' } | null>(null);
  const [requestFilter, setRequestFilter] = useState<'pending' | 'all'>('pending');
  const [settingsVersion, setSettingsVersion] = useState(0);
  const reload = useCallback(async () => {
    const [planResult, requestResult, settingResult, modelResult] = await Promise.all([
      api<{ plans: BillingPlan[] }>('/admin/plans'), api<{ requests: BillingRequest[] }>('/admin/billing/requests'),
      api<BillingSettings>('/admin/billing/settings'), api<{ models: Model[] }>('/admin/models'),
    ]);
    setPlans(planResult.plans); setRequests(requestResult.requests); setSettings(settingResult); setFreeRoutes(settingResult.freeAllowedRoutes);
    setRoutes([...new Set(modelResult.models.map(model => model.routeKey || model.modelId))].sort());
    setSettingsVersion(value => value + 1);
  }, []);
  useEffect(() => { void reload().catch(err => setError(errorText(err))).finally(() => setLoading(false)); }, [reload]);

  async function run(key: string, action: () => Promise<unknown>, message: string) {
    if (busy) return false; setBusy(key); setError(''); setNotice('');
    let saved = false;
    try { await action(); saved = true; await reload(); await onChanged?.(); setNotice(message); return true; }
    catch (err) { setError(saved ? `操作已完成，但刷新失败：${errorText(err)}。请刷新查看最新状态。` : errorText(err)); return saved; }
    finally { setBusy(''); }
  }
  function editPlan(plan: BillingPlan | 'new') { setEditing(plan); setSelectedRoutes(plan === 'new' ? [] : [...plan.allowedRoutes]); setError(''); setNotice(''); }
  async function savePlan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!editing) return;
    const form = new FormData(event.currentTarget);
    let priceCents: number;
    try { priceCents = priceToCents(String(form.get('price'))); } catch (err) { setError(errorText(err)); return; }
    const body = {
      name: String(form.get('name')), description: String(form.get('description') || ''), priceCents,
      currency: String(form.get('currency')), interval: String(form.get('interval')), dailyLimit: Number(form.get('dailyLimit')),
      allowedRoutes: selectedRoutes, allowStripe: form.get('allowStripe') === 'on', allowManual: form.get('allowManual') === 'on',
      active: form.get('active') === 'on', sortOrder: Number(form.get('sortOrder')),
    };
    if (await run('plan-save', () => editing === 'new' ? post('/admin/plans', body) : patch(`/admin/plans/${editing.id}`, body), '套餐已保存。已购买的权益保持开通时的设置。')) setEditing(null);
  }
  async function savePayments(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    await run('payments', () => patch('/admin/billing/settings', { stripeEnabled: form.get('stripeEnabled') === 'on', secretKey: String(form.get('secretKey') || ''), webhookSecret: String(form.get('webhookSecret') || '') }), '支付设置已保存。请确认 Stripe 中已配置 Webhook 和客户门户。');
  }
  async function reviewRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!review) return; const form = new FormData(event.currentTarget);
    if (await run('review', () => post(`/admin/billing/requests/${review.request.id}/review`, { decision: review.decision, note: String(form.get('note') || '') }), review.decision === 'approve' ? '申请已同意，会员权益已开通。' : '申请已拒绝。')) setReview(null);
  }
  const item = editing && editing !== 'new' ? editing : undefined;
  const knownRoutes = [...new Set([...routes, ...selectedRoutes])];
  const knownFreeRoutes = [...new Set([...routes, ...freeRoutes])];
  const pendingCount = requests.filter(request => request.status === 'pending').length;

  return <div className="admin-section billing-admin"><div className="section-title"><div><h3>套餐与订阅</h3><p>设置价格、可用模型和开通方式。</p></div><button className="icon-button" aria-label="刷新套餐和申请" disabled={!!busy || loading} onClick={() => { setError(''); void reload().catch(err => setError(errorText(err))); }}><RefreshCw size={17}/></button></div>
    <nav className="billing-admin-tabs" aria-label="订阅管理类别">{([{ id: 'plans', label: '套餐', icon: Layers3 }, { id: 'payments', label: '支付方式', icon: CreditCard }, { id: 'requests', label: `开通申请${pendingCount ? ` (${pendingCount})` : ''}`, icon: ReceiptText }] as const).map(option => <button className={tab === option.id ? 'active' : ''} key={option.id} onClick={() => { setTab(option.id); setError(''); setNotice(''); }}><option.icon size={15}/>{option.label}</button>)}</nav>
    {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status"><CheckCircle2 size={16}/>{notice}</div>}
    {loading ? <div className="settings-loading"><LoaderCircle size={22} className="spin"/>加载订阅设置…</div> : <>
      {tab === 'plans' && <><div className="billing-section-tools"><p className="billing-note">免费版额度沿用工作空间设置。付费套餐由你定价。</p><button className="button primary small" disabled={!!busy} onClick={() => editPlan('new')}><Plus size={15}/>添加套餐</button></div>
        <details className="settings-card billing-free-settings"><summary>免费版可用模型</summary><p className="field-help">不勾选表示免费成员可以使用全部已启用模型。勾选后，只有所选模型对免费成员开放。</p><div className="billing-route-list">{knownFreeRoutes.map(route => <label className="checkbox-label" key={route}><input type="checkbox" checked={freeRoutes.includes(route)} onChange={event => setFreeRoutes(previous => event.target.checked ? [...previous, route] : previous.filter(value => value !== route))}/><span>{route}{!routes.includes(route) && <small>（目前未配置）</small>}</span></label>)}</div>{!knownFreeRoutes.length && <p className="billing-note">还没有配置模型。</p>}<div className="form-actions"><button className="button small" disabled={!!busy} onClick={() => void run('free-routes', () => patch('/admin/billing/settings', { freeAllowedRoutes: freeRoutes }), '免费版模型范围已更新。')}>保存免费版设置</button></div></details>
        {editing && <form className="settings-card stack billing-plan-editor" key={item?.id || 'new'} onSubmit={savePlan}><div className="card-heading"><strong>{item ? '编辑套餐' : '创建套餐'}</strong><button className="icon-button" type="button" aria-label="关闭套餐编辑" onClick={() => setEditing(null)}><X size={16}/></button></div><label>套餐名称<input name="name" required maxLength={60} defaultValue={item?.name} placeholder="例如：Plus"/></label><label>套餐介绍<textarea name="description" rows={2} maxLength={1000} defaultValue={item?.description} placeholder="说明这个方案适合谁，以及包含的权益"/></label><div className="billing-price-inputs"><label>价格<input name="price" inputMode="decimal" type="number" min="0.01" max="999999.99" step="0.01" required defaultValue={item ? (item.priceCents / 100).toFixed(2) : ''}/></label><label>币种<select name="currency" defaultValue={item?.currency || 'CNY'}><option value="CNY">CNY 人民币</option><option value="USD">USD 美元</option><option value="EUR">EUR 欧元</option><option value="HKD">HKD 港币</option></select></label><label>周期<select name="interval" defaultValue={item?.interval || 'month'}><option value="month">每月</option><option value="year">每年</option></select></label></div><div className="form-grid"><label>每日请求额度<input name="dailyLimit" type="number" min="0" max="100000" required defaultValue={item?.dailyLimit ?? 100}/><span className="field-help">0 表示暂停使用。成员单独设置的额度优先。</span></label><label>展示排序<input name="sortOrder" type="number" min="-10000" max="10000" required defaultValue={item?.sortOrder ?? 0}/><span className="field-help">数值越小，展示越靠前。</span></label></div>
          <fieldset className="billing-route-picker"><legend>可用模型</legend><p className="field-help">不勾选表示允许使用本站已启用的全部模型。按模型的统一名称配置。</p><div className="billing-route-list">{knownRoutes.map(route => <label className="checkbox-label" key={route}><input type="checkbox" checked={selectedRoutes.includes(route)} onChange={event => setSelectedRoutes(previous => event.target.checked ? [...previous, route] : previous.filter(value => value !== route))}/><span>{route}{!routes.includes(route) && <small>（目前未配置）</small>}</span></label>)}</div>{!knownRoutes.length && <p className="billing-note">还没有配置模型，可以先添加套餐。</p>}</fieldset>
          <fieldset className="billing-method-picker"><legend>开通方式</legend><label className="checkbox-label"><input name="allowStripe" type="checkbox" defaultChecked={item?.allowStripe ?? false}/>Stripe 自动订阅</label><label className="checkbox-label"><input name="allowManual" type="checkbox" defaultChecked={item?.allowManual ?? true}/>申请开通，由管理员审核</label><p className="field-help">Stripe 还需要在“支付方式”中启用并填写密钥。</p></fieldset>
          <label className="checkbox-label"><input name="active" type="checkbox" defaultChecked={item?.active ?? true}/>上架此套餐</label><p className="billing-note">价格和权益的修改仅适用于新开通。下架不影响已开通会员的剩余有效期。</p><div className="form-actions"><button type="button" className="button" disabled={!!busy} onClick={() => setEditing(null)}>取消</button><button className="button primary" disabled={!!busy}>{busy === 'plan-save' ? <LoaderCircle size={15} className="spin"/> : <Check size={15}/>}保存套餐</button></div></form>}
        {!plans.length && !editing && <div className="settings-empty"><div className="empty-icon"><Layers3 size={27}/></div><h4>创建你的第一个套餐</h4><p>设置价格与权益，让受邀成员按需升级。</p><button className="button" onClick={() => editPlan('new')}><Plus size={16}/>添加套餐</button></div>}
        {plans.map(plan => <article className="settings-card billing-admin-plan" key={plan.id}><div className="billing-admin-plan-heading"><div><strong>{plan.name}</strong><span>{formatPrice(plan.priceCents, plan.currency)} / {intervalLabel(plan.interval)}</span></div><span className={`status-pill ${plan.active ? 'success' : ''}`}>{plan.active ? '已上架' : '已下架'}</span><button className="icon-button" aria-label={`编辑套餐 ${plan.name}`} disabled={!!busy} onClick={() => editPlan(plan)}><Pencil size={15}/></button></div>{plan.description && <p className="billing-note">{plan.description}</p>}<div className="billing-plan-tags"><span>每日 {plan.dailyLimit.toLocaleString()} 次</span><span>{plan.allowedRoutes.length ? `${plan.allowedRoutes.length} 个指定模型` : '全部启用模型'}</span>{plan.allowStripe && <span>Stripe</span>}{plan.allowManual && <span>申请开通</span>}</div><div className="form-actions"><button className="button small" disabled={!!busy} onClick={() => void run(`toggle-${plan.id}`, () => patch(`/admin/plans/${plan.id}`, { active: !plan.active }), plan.active ? '套餐已下架，已开通会员保留原权益。' : '套餐已上架。')}>{plan.active ? '下架' : '上架'}</button></div></article>)}
      </>}
      {tab === 'payments' && settings && <form className="stack" key={`payments-${settingsVersion}`} onSubmit={savePayments}><div className="billing-payment-intro"><CreditCard size={23}/><div><strong>Stripe 自动订阅</strong><p>用户通过 Stripe 付款，验证付款通知后开通会员。</p></div></div><label className="checkbox-label"><input name="stripeEnabled" type="checkbox" defaultChecked={settings.stripeEnabled}/>启用 Stripe 支付</label><label>Stripe Secret Key<input name="secretKey" type="password" autoComplete="new-password" spellCheck={false} placeholder={settings.hasSecretKey ? `已保存 ${settings.secretKeyHint || '••••'}，留空保留` : 'sk_test_… 或 sk_live_…'}/><span className="field-help">密钥加密存储，浏览器不会收到已保存的完整密钥。建议先用测试模式验收。</span></label><label>Webhook 签名密钥<input name="webhookSecret" type="password" autoComplete="new-password" spellCheck={false} placeholder={settings.hasWebhookSecret ? `已保存 ${settings.webhookSecretHint || '••••'}，留空保留` : 'whsec_…'}/></label><label>Webhook 地址<input readOnly value={settings.webhookUrl || '请先配置站点的 PUBLIC_ORIGIN'} onFocus={event => event.currentTarget.select()}/><span className="field-help">将此地址添加到 Stripe 的 Webhook 接收端。正式支付需要可公开访问的 HTTPS 域名。</span></label><div className="billing-webhook-events"><strong>需要接收的事件</strong><code>checkout.session.completed<br/>checkout.session.async_payment_succeeded<br/>invoice.paid<br/>invoice.payment_failed<br/>customer.subscription.updated<br/>customer.subscription.deleted</code></div><p className="billing-note">在 Stripe 中启用客户门户，让用户查看账单与取消续订。支付费用、可用币种与收款资格由 Stripe 账户决定。</p><div className="form-actions"><button className="button primary" disabled={!!busy}>{busy === 'payments' ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>}保存支付设置</button></div><div className="info-note"><ReceiptText size={18}/><span>申请开通不经过 Stripe，也不会自动收款。管理员同意后立即授予该申请快照中的套餐权益。</span></div></form>}
      {tab === 'requests' && <><div className="billing-section-tools"><p className="billing-note">审批会影响会员权益，请确认申请与付款安排。</p><select className="billing-request-filter" aria-label="筛选开通申请" value={requestFilter} onChange={event => setRequestFilter(event.target.value as 'pending' | 'all')}><option value="pending">待审核</option><option value="all">全部申请</option></select></div>{!requests.filter(request => requestFilter === 'all' || request.status === 'pending').length && <div className="settings-empty"><ReceiptText size={28}/><h4>{requestFilter === 'pending' ? '暂无待审核申请' : '还没有开通申请'}</h4><p>成员提交申请后，会出现在这里。</p></div>}{requests.filter(request => requestFilter === 'all' || request.status === 'pending').map(request => <article key={request.id} className="settings-card billing-admin-request"><div className="billing-request-top"><div><strong>{request.userName || '成员'}</strong><span>{request.userEmail || request.userId}</span></div><span className={`status-pill ${request.status === 'approved' ? 'success' : ''}`}>{statusLabels[request.status]}</span></div><div className="billing-request-snapshot"><strong>{request.planName}</strong><span>{formatPrice(request.plan.priceCents, request.plan.currency)} / {intervalLabel(request.plan.interval)}</span><span>每日 {request.plan.dailyLimit.toLocaleString()} 次 · {request.plan.allowedRoutes.length ? `模型：${request.plan.allowedRoutes.join('、')}` : '全部启用模型'}</span></div>{request.note && <p className="billing-request-note">{request.note}</p>}<small className="muted">申请于 {billingDate(request.createdAt)}{request.reviewedAt ? ` · 审核于 ${billingDate(request.reviewedAt)}` : ''}</small>{request.reviewNote && <p className="billing-review-note">审核说明：{request.reviewNote}</p>}{request.status === 'pending' && review?.request.id !== request.id && <div className="form-actions"><button className="button small" disabled={!!busy} onClick={() => { setReview({ request, decision: 'reject' }); setError(''); setNotice(''); }}>拒绝</button><button className="button primary small" disabled={!!busy} onClick={() => { setReview({ request, decision: 'approve' }); setError(''); setNotice(''); }}><Check size={15}/>同意开通</button></div>}{review?.request.id === request.id && <form className="billing-review-form stack" onSubmit={reviewRequest}><strong>{review.decision === 'approve' ? `确认给 ${request.userName || '该成员'} 开通 ${request.planName}？` : `确认拒绝 ${request.userName || '该成员'} 的申请？`}</strong><p className="billing-note">{review.decision === 'approve' ? '同意后将立即开通一个周期。相同套餐从现有效期顺延，改换套餐从审批时开始。此操作不会收款。' : '拒绝后不会开通会员，用户会看到审核结果与说明。'}</p><label>审核说明（用户可见）<textarea name="note" rows={2} maxLength={1000} placeholder={review.decision === 'approve' ? '例如：已确认付款，欢迎使用' : '说明拒绝原因，方便用户了解'}/></label><div className="form-actions"><button className="button small" type="button" disabled={!!busy} onClick={() => setReview(null)}>返回</button><button className={`button small ${review.decision === 'approve' ? 'primary' : 'danger'}`} disabled={!!busy}>{busy === 'review' && <LoaderCircle size={15} className="spin"/>}{review.decision === 'approve' ? '确认同意并开通' : '确认拒绝'}</button></div></form>}</article>)}</>}
    </>}
  </div>;
}
