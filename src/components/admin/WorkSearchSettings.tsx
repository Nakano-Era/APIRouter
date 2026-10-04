import { useEffect, useState, type FormEvent } from 'react';
import { Check, Globe, LoaderCircle, Search } from 'lucide-react';
import { api, errorText, patch, post } from '../../api';

interface SearchSettings { enabled: boolean; baseUrl: string }
interface SearchResult { query: string; retrievedAt: string; results: { title: string; url: string; snippet: string }[] }
export default function WorkSearchSettings({ onChanged }: { onChanged: () => Promise<void> }) {
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [query, setQuery] = useState('香港城巴 37A 官方路线');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null), [dirty, setDirty] = useState(false);
  useEffect(() => { let live = true; api<{ settings: SearchSettings }>('/admin/work/search').then(data => { if (live) setSettings(data.settings); }).catch(cause => { if (live) setError(errorText(cause)); }); return () => { live = false; }; }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); if (!settings) return; setBusy('save'); setError(''); setNotice('');
    try { const data = await patch<{ settings: SearchSettings }>('/admin/work/search', settings); setSettings(data.settings); setDirty(false); setResult(null); await onChanged(); setNotice('搜索设置已保存。'); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(''); }
  }
  async function test() {
    setBusy('test'); setError(''); setNotice(''); setResult(null);
    try { setResult(await post<SearchResult>('/admin/work/search/test', { query })); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(''); }
  }
  return <section className="settings-card stack" style={{ marginTop: 24 }}>
    <div className="card-heading"><strong><Globe size={16}/> 网络搜索</strong></div>
    <p className="field-help">Work 的直接 API 模式使用独立搜索与网页读取工具，无需模型服务商提供内置搜索。开启后先检索本次问题，任务活动会显示实际结果或失败原因。</p>
    {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status">{notice}</div>}
    {settings && <>
      <form className="stack" onSubmit={save}>
        <label className="checkbox-label"><input type="checkbox" checked={settings.enabled} disabled={!!busy} onChange={event => { setSettings({ ...settings, enabled: event.target.checked }); setDirty(true); }}/>开启独立网络搜索</label>
        <label>搜索服务地址<input type="url" required value={settings.baseUrl} disabled={!!busy} onChange={event => { setSettings({ ...settings, baseUrl: event.target.value }); setDirty(true); }}/><span className="field-help">默认使用随 Docker Work 部署的 SearXNG。也可填写自己部署、开启 JSON 接口的公网 HTTPS SearXNG 地址。</span></label>
        <div className="form-actions"><button className="button small" disabled={!!busy || !dirty}><Check size={14}/>保存搜索设置</button></div>
      </form>
      <div className="stack"><label>测试搜索词<input value={query} maxLength={500} disabled={!!busy} onChange={event => setQuery(event.target.value)}/></label><div className="form-actions"><button className="button small" disabled={!!busy || dirty || !settings.enabled || !query.trim()} onClick={() => void test()}>{busy === 'test' ? <LoaderCircle size={14} className="spin"/> : <Search size={14}/>}测试搜索</button></div>{dirty && <p className="field-help">请先保存修改，再测试连接。</p>}</div>
      {result && <div role="status"><strong>已取得 {result.results.length} 条搜索结果</strong><p className="field-help">{new Date(result.retrievedAt).toLocaleString('zh-CN')}</p><ul className="work-search-results">{result.results.map((item, index) => <li key={`${item.url}-${index}`}><a href={/^https?:\/\//i.test(item.url) ? item.url : undefined} target="_blank" rel="noreferrer">{item.title}</a><p className="field-help">{item.snippet}</p></li>)}</ul></div>}
      <p className="field-help">旧部署需要更新 Work 镜像并启动搜索服务。搜索词会发送给搜索服务及其搜索引擎；网页读取仅访问公开页面，不支持登录或验证码。Claude Code 仍使用其自带搜索。</p>
    </>}
  </section>;
}
