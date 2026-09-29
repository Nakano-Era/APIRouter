import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, CheckCircle2, CreditCard, LoaderCircle, MessageSquareText, Sparkles, X } from 'lucide-react';
import { api, errorText, post } from '../api';
import { billingDate, formatPrice, intervalLabel, type BillingData, type BillingPlan, type BillingRequest } from '../billingTypes';
import Modal from './Modal';
import '../billing.css';

const requestStatus: Record<BillingRequest['status'], string> = { pending: '等待审核', approved: '已同意', rejected: '已拒绝' };

function stripeRedirect(url: string) {
  const destination = new URL(url);
  if (destination.protocol !== 'https:' || destination.username || destination.password || !['checkout.stripe.com', 'billing.stripe.com'].includes(destination.hostname)) throw new Error('支付服务返回了无效链接，请联系管理员。');
  window.location.assign(destination.href);
}

function PlanFeatures({ dailyLimit, allowedRoutes }: { dailyLimit: number; allowedRoutes: string[] }) {
  return <ul className="billing-features">
    <li><Check size={17}/><span>每日 {dailyLimit.toLocaleString()} 次请求</span></li>
    <li><Check size={17}/><span>{allowedRoutes.length ? `可用 ${allowedRoutes.length} 个指定模型` : '可用本站已启用的全部模型'}</span></li>
    {allowedRoutes.length > 0 && <li className="billing-model-list">{allowedRoutes.join(' · ')}</li>}
    <li><Check size={17}/><span>保存对话与上传文件</span></li>
  </ul>;
}

export default function BillingModal({ onClose, onChanged }: { onClose: () => void; onChanged?: () => void | Promise<void> }) {
  const [data, setData] = useState<BillingData | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [requestPlan, setRequestPlan] = useState<BillingPlan | null>(null);
  const [interval, setInterval] = useState<'all' | 'month' | 'year'>('all');
  const [returnFlow] = useState(() => new URLSearchParams(window.location.search).get('billing'));
  const [paymentNotice, setPaymentNotice] = useState('');
  const changedRef = useRef(onChanged); changedRef.current = onChanged;
  const requestForm = useRef<HTMLFormElement>(null);
  const reload = useCallback(async () => { const result = await api<BillingData>('/billing'); setData(result); }, []);
  useEffect(() => {
    let active = true; let timer: ReturnType<typeof setTimeout> | undefined; const started = Date.now();
    const awaitingPayment = returnFlow === 'success';
    if (['success', 'cancelled', 'return'].includes(returnFlow || '')) {
      const current = new URL(window.location.href); current.searchParams.delete('billing'); window.history.replaceState(window.history.state, '', `${current.pathname}${current.search}${current.hash}`);
      setPaymentNotice(awaitingPayment ? '正在确认付款，请稍候。会员权益以服务器收到的付款结果为准。' : returnFlow === 'cancelled' ? '你已从支付页面返回。下方显示服务器记录的当前会员状态。' : '已从订阅管理返回，正在同步会员状态。');
    }
    async function check() {
      try {
        const result = await api<BillingData>('/billing'); if (!active) return; setData(result); setError('');
        if (awaitingPayment && result.membership?.source === 'stripe') { setPaymentNotice('已确认当前 Stripe 会员状态，权益和有效期如下。'); void Promise.resolve(changedRef.current?.()).catch(() => {}); }
        else if (awaitingPayment && Date.now() - started < 60_000) timer = setTimeout(() => void check(), 3000);
        else if (awaitingPayment) setPaymentNotice('暂未收到已完成的付款确认。稍后重新打开此页面查看，或联系管理员核对订单；请勿重复付款。');
        else if (returnFlow === 'return') { setPaymentNotice('已刷新服务器记录的会员状态。支付平台变更可能需要片刻同步。'); void Promise.resolve(changedRef.current?.()).catch(() => {}); }
      } catch (err) { if (active) setError(errorText(err)); }
      finally { if (active) setLoading(false); }
    }
    void check(); return () => { active = false; if (timer) clearTimeout(timer); };
  }, [returnFlow]);
  useEffect(() => { if (requestPlan) requestForm.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [requestPlan]);

  async function checkout(plan: BillingPlan) {
    if (busy) return; setBusy(`checkout-${plan.id}`); setError(''); setNotice('');
    try { const result = await post<{ url: string }>('/billing/checkout', { planId: plan.id }); stripeRedirect(result.url); }
    catch (err) { setError(errorText(err)); setBusy(''); }
  }
  async function portal() {
    if (busy) return; setBusy('portal'); setError(''); setNotice('');
    try { const result = await post<{ url: string }>('/billing/portal'); stripeRedirect(result.url); }
    catch (err) { setError(errorText(err)); setBusy(''); }
  }
  async function submitRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!requestPlan || busy || data?.canRequestManual === false) return;
    const form = new FormData(event.currentTarget); setBusy('request'); setError(''); setNotice('');
    try { await post('/billing/requests', { planId: requestPlan.id, note: String(form.get('note') || '') }); setRequestPlan(null); await reload(); await onChanged?.(); setNotice('申请已提交，管理员审核后会更新你的会员状态。'); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(''); }
  }
  const hasMonthly = data?.plans.some(plan => plan.interval === 'month');
  const hasYearly = data?.plans.some(plan => plan.interval === 'year');
  const paidMembership = !!data?.membership?.planId;
  const currentPlanId = data?.membership?.planId;
  const stripeMembership = data?.membership?.source === 'stripe';
  const pendingRequest = data?.requests.find(request => request.status === 'pending');

  return <Modal title="升级你的方案" wide onClose={onClose}><div className="billing-modal-body">
    <div className="billing-heading"><span className="billing-eyebrow"><Sparkles size={16}/>为你的每一天，提供更多帮助</span><h3>选择适合你的方案</h3><p>按需升级，享受本站管理员配置的额度与模型。</p></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {notice && <div className="alert success" role="status"><CheckCircle2 size={16}/>{notice}</div>}
    {paymentNotice && <div className="billing-payment-notice" role="status">{paymentNotice}</div>}
    {loading ? <div className="settings-loading"><LoaderCircle size={23} className="spin"/>正在加载方案…</div> : data ? <>
      {data.membership && <div className="billing-membership"><div><strong>{data.membership.planName}</strong><span>{data.membership.cancelAtPeriodEnd ? '已取消续订，有效期至' : stripeMembership ? '当前订阅周期至' : '会员有效期至'} {billingDate(data.membership.activeUntil)}</span><span>当前每日额度：{data.effectiveDailyLimit.toLocaleString()} 次</span><span>当前模型范围：{data.membership.allowedRoutes.length ? data.membership.allowedRoutes.join('、') : '本站全部启用模型'}</span>{['past_due', 'unpaid', 'incomplete'].includes(data.membership.status) && <small className="danger-text">付款状态需要处理，请管理订阅。</small>}</div>{data.canManageSubscription && <button className="button small" disabled={!!busy} onClick={() => void portal()}><CreditCard size={15}/>管理订阅<ArrowUpRight size={14}/></button>}</div>}
      {!data.membership && data.canManageSubscription && <div className="billing-membership"><p>查看付款状态、账单或管理现有订阅。</p><button className="button small" disabled={!!busy} onClick={() => void portal()}><CreditCard size={15}/>管理订阅<ArrowUpRight size={14}/></button></div>}
      {hasMonthly && hasYearly && <div className="billing-periods" aria-label="计费周期">{([{ value: 'all', label: '全部方案' }, { value: 'month', label: '按月' }, { value: 'year', label: '按年' }] as const).map(option => <button key={option.value} className={interval === option.value ? 'active' : ''} onClick={() => setInterval(option.value)}>{option.label}</button>)}</div>}
      <div className="billing-plan-grid">
        <article className={`billing-plan ${!paidMembership ? 'billing-plan-current' : ''}`}><div className="billing-plan-title"><h4>{data.freePlan.name || '免费'}</h4>{!paidMembership && <span className="billing-current-badge">当前方案</span>}</div><div className="billing-price"><strong>免费</strong></div><p className="billing-plan-description">从日常对话开始，探索更多可能。</p><button className="button billing-plan-action" disabled>{paidMembership ? '基础方案' : '你正在使用此方案'}</button><PlanFeatures dailyLimit={data.freePlan.dailyLimit} allowedRoutes={data.freePlan.allowedRoutes}/></article>
        {data.plans.filter(plan => interval === 'all' || plan.interval === interval).map(plan => {
          const current = currentPlanId === plan.id;
          const pending = data.requests.some(request => request.planId === plan.id && request.status === 'pending');
          return <article className={`billing-plan ${current ? 'billing-plan-current' : ''}`} key={plan.id}><div className="billing-plan-title"><h4>{plan.name}</h4>{current && <span className="billing-current-badge">当前方案</span>}</div><div className="billing-price"><strong>{formatPrice(plan.priceCents, plan.currency)}</strong><span>/{intervalLabel(plan.interval)}</span></div><p className="billing-plan-description">{plan.description || '按你的需求，获得更多使用额度。'}</p><div className="billing-plan-buttons">
            {current ? <><button className="button billing-plan-action" disabled><Check size={16}/>你正在使用此方案</button>{!stripeMembership && plan.allowManual && data.paymentMethods.manual && <button className="button billing-plan-action" disabled={!!busy || !!pendingRequest || !data.canRequestManual} onClick={() => { setRequestPlan(plan); setError(''); setNotice(''); }}>{pending ? '续期申请审核中' : '申请续期'}</button>}</> : <>
              {plan.allowStripe && data.paymentMethods.stripe && <button className="button primary billing-plan-action" disabled={!!busy || paidMembership || !!pendingRequest} onClick={() => void checkout(plan)}>{busy === `checkout-${plan.id}` ? <LoaderCircle className="spin" size={16}/> : <CreditCard size={16}/>}订阅 {plan.name}<ArrowUpRight size={15}/></button>}
              {plan.allowManual && data.paymentMethods.manual && <button className={`button billing-plan-action ${!(plan.allowStripe && data.paymentMethods.stripe) ? 'primary' : ''}`} disabled={!!busy || !!pendingRequest || stripeMembership || !data.canRequestManual} onClick={() => { setRequestPlan(plan); setError(''); setNotice(''); }}><MessageSquareText size={16}/>{pending ? '申请审核中' : pendingRequest ? '已有待审核申请' : '申请开通'}</button>}
              {!((plan.allowStripe && data.paymentMethods.stripe) || (plan.allowManual && data.paymentMethods.manual)) && <button className="button billing-plan-action" disabled>暂未开放开通</button>}
            </>}
          </div><PlanFeatures dailyLimit={plan.dailyLimit} allowedRoutes={plan.allowedRoutes}/>{plan.allowStripe && data.paymentMethods.stripe && <p className="billing-renewal">按{intervalLabel(plan.interval)}自动续订，可在订阅管理中取消。</p>}</article>;
        })}
      </div>
      {stripeMembership && <p className="billing-note">你已拥有 Stripe 订阅。请通过“管理订阅”处理付款或取消续订，避免重复开通。</p>}
      {!data.canRequestManual && <p className="billing-note">管理员无需申请开通，可在后台设置自己的额度。</p>}
      {paidMembership && !stripeMembership && data.canRequestManual && <p className="billing-note">你当前的会员通过管理员开通，可申请续期或更换套餐。如需改用 Stripe，请在当前会员到期后订阅。</p>}
      {pendingRequest && <p className="billing-note">你有一项开通申请等待审核，处理完成后可以提交新申请或支付。</p>}
      {!data.plans.length && <p className="billing-note">管理员尚未发布付费套餐。你可以继续使用当前方案。</p>}
      {requestPlan && <form className="billing-request-form stack" ref={requestForm} onSubmit={submitRequest}><div className="card-heading"><div><strong>申请开通 {requestPlan.name}</strong><p className="muted">{formatPrice(requestPlan.priceCents, requestPlan.currency)} / {intervalLabel(requestPlan.interval)}</p></div><button className="icon-button" type="button" aria-label="取消开通申请" onClick={() => setRequestPlan(null)}><X size={17}/></button></div><p className="billing-note">申请不会自动扣款。管理员确认后开通一个周期；付款安排请与管理员确认。</p><label>申请说明（选填）<textarea name="note" rows={3} maxLength={1000} placeholder="写下你希望管理员了解的信息"/></label><div className="form-actions"><button className="button" type="button" disabled={!!busy} onClick={() => setRequestPlan(null)}>取消</button><button className="button primary" disabled={!!busy}>{busy === 'request' && <LoaderCircle size={16} className="spin"/>}提交申请</button></div></form>}
      {data.requests.length > 0 && <section className="billing-request-history"><h4>我的申请</h4>{data.requests.map(request => <article className="billing-request-row" key={request.id}><div><strong>{request.planName}</strong><span>{formatPrice(request.plan.priceCents, request.plan.currency)} / {intervalLabel(request.plan.interval)} · {billingDate(request.createdAt)}</span>{request.reviewNote && <p>{request.reviewNote}</p>}</div><span className={`status-pill ${request.status === 'approved' ? 'success' : ''}`}>{requestStatus[request.status]}</span></article>)}</section>}
      <p className="billing-footer-note">套餐由本站独立提供，适用于本站服务。API 服务商用量与 ChatGPT 官方订阅分开计算。</p>
    </> : <button className="button" onClick={() => { setLoading(true); setError(''); void reload().catch(err => setError(errorText(err))).finally(() => setLoading(false)); }}>重新加载</button>}
  </div></Modal>;
}
