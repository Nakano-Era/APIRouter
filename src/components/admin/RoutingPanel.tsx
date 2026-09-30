import { useState } from 'react';
import { CheckCircle2, FileText, LoaderCircle, RefreshCw, Route, XCircle } from 'lucide-react';
import { api, errorText } from '../../api';
import type { RawDiagnostic, RoutingAttempt } from '../../types';
import RawDiagnosticDetails from './RawDiagnosticDetails';
export default function RoutingPanel({ attempts, refresh, busy }: { attempts: RoutingAttempt[]; refresh: () => void; busy: boolean }) {
  const [details, setDetails] = useState<Record<string, RawDiagnostic>>({});
  const [loading, setLoading] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  async function loadDetail(id: string) {
    if (loading.includes(id)) return;
    setLoading(current => [...current, id]); setErrors(current => ({ ...current, [id]: '' }));
    try { const result = await api<{ detail: RawDiagnostic }>(`/admin/routing-logs/${encodeURIComponent(id)}/detail`); setDetails(current => ({ ...current, [id]: result.detail })); }
    catch (err) { setErrors(current => ({ ...current, [id]: errorText(err) })); }
    finally { setLoading(current => current.filter(value => value !== id)); }
  }
  return <div className="admin-section"><div className="section-title"><div><h3>路由日志</h3><p>查看真实请求的渠道选择、重试、切换与原始错误响应。</p></div><button className="button small" onClick={refresh} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''}/>刷新</button></div>
    <div className="info-note routing-info"><Route size={17}/><span>同一个请求 ID 下的记录是一次对话请求的不同尝试。原始错误仅管理员可查看，用户界面不显示渠道信息。</span></div>
    {attempts.length === 0 ? <div className="settings-empty"><div className="empty-icon"><Route size={25}/></div><h4>暂时没有路由记录</h4><p>发送消息后，可以在这里查看实际调用了哪个渠道。</p></div> : <div className="routing-logs">{attempts.map(attempt => {
      const success = ['success', 'ok', 'complete'].includes(attempt.outcome);
      const pending = loading.includes(attempt.id);
      return <div className="routing-log" key={attempt.id}>
        <div className="routing-log-heading">{success ? <CheckCircle2 size={16} className="success-text"/> : <XCircle size={16} className="danger-text"/>}<strong>{attempt.providerName || '已删除的渠道'}</strong><span className={`status-pill ${success ? 'success' : ''}`}>{success ? '成功' : ['aborted', 'stopped'].includes(attempt.outcome) ? '已取消' : attempt.outcome === 'running' ? '进行中' : ['error', 'failure', 'failed'].includes(attempt.outcome) ? '失败' : attempt.outcome}</span></div>
        <div className="routing-log-meta"><span>{attempt.modelId}</span><time>{new Date(attempt.createdAt).toLocaleString('zh-CN')}</time></div><div className="routing-request-id">请求 {attempt.requestId}</div>
        {attempt.error && <p className="model-error">{attempt.error}</p>}
        {details[attempt.id] ? <RawDiagnosticDetails detail={details[attempt.id]}/> : attempt.hasDetail && <button className="button small routing-detail-button" disabled={pending} onClick={() => void loadDetail(attempt.id)}>{pending ? <LoaderCircle size={14} className="spin"/> : <FileText size={14}/>}读取原始错误</button>}
        {errors[attempt.id] && <p className="model-error" role="alert">{errors[attempt.id]}</p>}
      </div>;
    })}</div>}
  </div>;
}
