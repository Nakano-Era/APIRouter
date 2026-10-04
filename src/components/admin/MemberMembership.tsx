import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { Check, LoaderCircle, RefreshCw, RotateCcw } from 'lucide-react';
import { api, errorText } from '../../api';
import { billingDate, type AdminMembershipData } from '../../billingTypes';
import type { User } from '../../types';
import type { RunAction } from './ProvidersPanel';
import './member-membership.css';

const sourceNames: Record<string, string> = { free: '默认免费版', manual: '申请开通', stripe: 'Stripe 订阅', admin: '管理员指定' };
function localInput(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function MembershipEditor({ user, run, busy }: { user: User; run: RunAction; busy: string }) {
  const [data, setData] = useState<AdminMembershipData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [planId, setPlanId] = useState('free');
  const [duration, setDuration] = useState('period');
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const path = `/admin/users/${encodeURIComponent(user.id)}/membership`;
  const accept = useCallback((value: AdminMembershipData) => {
    setData(value); setPlanId(value.effective.planId);
    const current = value.override?.status === 'active' ? value.override : null;
    setDuration(current ? current.activeUntil ? 'until' : 'permanent' : 'period');
    setUntil(localInput(current?.activeUntil || null)); setNote('');
  }, []);
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    api<AdminMembershipData>(path).then(value => { if (active) accept(value); }).catch(cause => { if (active) setError(errorText(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, accept]);
  async function refresh() {
    setLoading(true); setError('');
    try { accept(await api<AdminMembershipData>(path)); } catch (cause) { setError(errorText(cause)); } finally { setLoading(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    const date = duration === 'until' ? new Date(until) : null;
    if (date && (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now())) { setError('请选择未来的截止时间。'); return; }
    await run(`membership-${user.id}`, async () => {
      accept(await api<AdminMembershipData>(path, { method: 'PUT', body: JSON.stringify({ planId, duration, ...(date ? { activeUntil: date.toISOString() } : {}), note }) }));
    }, `${user.name} 的套餐已更改，新的权益立即生效。`);
  }
  async function restore() {
    await run(`membership-${user.id}`, async () => { accept(await api<AdminMembershipData>(path, { method: 'DELETE', body: JSON.stringify({ note }) })); }, `${user.name} 已恢复原订阅权益。`);
  }
  const disabled = loading || !!busy;
  const selectedPlan = data?.plans.find(plan => plan.id === planId);
  return <div className="member-membership-editor">
    <div className="member-membership-heading"><strong>{user.name} 的套餐</strong><button type="button" className="button small" disabled={disabled} onClick={() => void refresh()} aria-label={`刷新 ${user.name} 的套餐`}><RefreshCw size={14}/>刷新</button></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {!data && loading && <p className="field-help"><LoaderCircle size={14} className="spin"/>正在读取套餐…</p>}
    {data && <>
      <div className="member-membership-current"><strong>当前有效：{data.effective.planName}</strong><span>{sourceNames[data.effective.source] || data.effective.source} · {data.effective.activeUntil ? `有效至 ${billingDate(data.effective.activeUntil)}` : '长期有效'}</span><span>每日 {data.effective.dailyLimit.toLocaleString()} 次{user.dailyLimit !== null && user.dailyLimit !== undefined ? '（使用成员单独设置的上限）' : ''}</span><span>可用模型：{data.effective.allowedRoutes.length ? data.effective.allowedRoutes.join('、') : '本站全部启用模型'}</span></div>
      <p className="field-help">此操作只调整站内权益，不扣款、不取消已有支付订阅；不会清空已用次数。指定期限结束后自动恢复原订阅，无有效订阅则恢复免费版。</p>
      {data.hasStripeSubscription && <p className="member-membership-payment-note">该成员已有 Stripe 订阅，付款和续订继续按原订阅执行。此处修改的套餐优先生效，不会被支付通知覆盖。</p>}
      {data.override && <p className="field-help">管理员指定：{data.override.planName}（{data.override.status === 'expired' ? '已到期' : data.override.activeUntil ? `至 ${billingDate(data.override.activeUntil)}` : '长期'}）；原订阅：{data.underlyingMembership ? `${data.underlyingMembership.planName}，至 ${billingDate(data.underlyingMembership.activeUntil)}` : '无有效订阅，使用免费版'}。</p>}
      <form className="stack" onSubmit={save}>
        <div className="form-grid"><label>套餐类型<select value={planId} disabled={disabled} onChange={event => setPlanId(event.target.value)}><option value="free">免费版</option>{data.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}{!plan.active ? '（未上架）' : ''}</option>)}</select></label><label>生效期限<select value={duration} disabled={disabled} onChange={event => setDuration(event.target.value)}><option value="period">从现在起{selectedPlan?.interval === 'year' ? '一年' : '一个月'}（一个周期）</option><option value="permanent">长期有效</option><option value="until">自定截止时间</option></select></label></div>
        {duration === 'until' && <label>截止时间（本地时间）<input type="datetime-local" value={until} disabled={disabled} required onChange={event => setUntil(event.target.value)}/></label>}
        <label>调整说明（选填，仅管理员可见）<input value={note} disabled={disabled} maxLength={1000} onChange={event => setNote(event.target.value)} placeholder="例如赠送一个月体验套餐"/></label>
        <div className="form-actions"><button type="submit" className="button primary small" disabled={disabled}><Check size={14}/>保存套餐</button>{data.override && <button type="button" className="button small" disabled={disabled} onClick={() => void restore()}><RotateCcw size={14}/>恢复原订阅</button>}</div>
      </form>
      {data.history.length > 0 && <details className="member-membership-history"><summary>套餐调整记录</summary><ol>{data.history.map(item => <li key={item.id}><strong>{item.action === 'restore' ? '恢复原订阅' : `指定为 ${item.next?.planName || '免费版'}`}{item.next && ` · ${item.next.activeUntil ? `至 ${billingDate(item.next.activeUntil)}` : '长期有效'}`}</strong><span>{item.adminName} · {new Date(item.createdAt).toLocaleString('zh-CN')}</span>{item.reason && <p>{item.reason}</p>}</li>)}</ol></details>}
    </>}
  </div>;
}

export default function MemberMembership({ user, run, busy }: { user: User; run: RunAction; busy: string }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return <details className="member-membership" aria-labelledby={id} onToggle={event => setExpanded(event.currentTarget.open)}><summary id={id} aria-label={`管理 ${user.name} 的套餐`}>用户套餐</summary>{expanded && <MembershipEditor user={user} run={run} busy={busy}/>}</details>;
}
