import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BookOpen, Check, Download, LoaderCircle, Plus, RefreshCw, Terminal, Trash2, X } from 'lucide-react';
import { api, errorText, patch, post, remove } from '../../api';
import type { WorkSkill } from '../../types';
import WorkSearchSettings from './WorkSearchSettings';
interface WorkSettings { enabled: boolean; maxTurns: number; timeoutSeconds: number; memoryMb: number; cpus: number; maxBudgetUsd: number; maxConcurrentJobs: number; artifactTotalMb: number; artifactMaxFiles: number; userStorageMb: number }
interface RuntimeResponse { configured: boolean; available: boolean; reason?: string; settings: WorkSettings; limits?: Record<string, unknown> }
export default function WorkPanel({ onChanged }: { onChanged: () => Promise<void> }) {
  const [runtime, setRuntime] = useState<RuntimeResponse | null>(null);
  const [skills, setSkills] = useState<WorkSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [source, setSource] = useState<'content' | 'url'>('content');
  const [deleting, setDeleting] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const reload = useCallback(async () => {
    const [status, result] = await Promise.all([api<RuntimeResponse>('/admin/work/settings'), api<{ skills: WorkSkill[] }>('/work/skills')]);
    setRuntime(status); setSkills(result.skills); setVersion(value => value + 1);
  }, []);
  useEffect(() => { void reload().catch(err => setError(errorText(err))).finally(() => setLoading(false)); }, [reload]);
  async function run(key: string, action: () => Promise<unknown>, success: string) {
    if (busy) return false;
    setBusy(key); setError(''); setNotice('');
    try { await action(); await reload(); await onChanged(); setNotice(success); return true; }
    catch (err) { setError(errorText(err)); return false; }
    finally { setBusy(''); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const timeoutSeconds = Number(form.get('timeoutSeconds'));
    if (!Number.isInteger(timeoutSeconds) || (timeoutSeconds !== 0 && (timeoutSeconds < 30 || timeoutSeconds > 1800))) { setNotice(''); setError('任务最长时间请填写 0（不限时），或 30–1800 秒。'); return; }
    await run('save', () => patch('/admin/work/settings', { enabled: form.get('enabled') === 'on', maxTurns: Number(form.get('maxTurns')), timeoutSeconds, memoryMb: Number(form.get('memoryMb')), cpus: Number(form.get('cpus')), maxBudgetUsd: Number(form.get('maxBudgetUsd')), maxConcurrentJobs: Number(form.get('maxConcurrentJobs')), artifactTotalMb: Number(form.get('artifactTotalMb')), artifactMaxFiles: Number(form.get('artifactMaxFiles')), userStorageMb: Number(form.get('userStorageMb')) }), 'Work 设置已保存。');
  }
  async function createSkill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const name = String(form.get('name') || '').trim(); const description = String(form.get('description') || '').trim();
    const body = { ...(name ? { name } : {}), ...(description ? { description } : {}), ...(source === 'url' ? { url: form.get('url') } : { content: form.get('content') }) };
    if (await run('skill-add', () => post('/work/skills', body), '技能已添加，成员可在 Work 中选择使用。')) setAdding(false);
  }
  return <div className="admin-section">
    <div className="section-title"><div><h3>Work 与技能</h3><p>配置独立任务工作区，并管理可供成员使用的技能。</p></div><button className="button small" disabled={!!busy || loading} onClick={() => void run('refresh', reload, '服务状态已刷新。')}><RefreshCw size={14} className={busy === 'refresh' ? 'spin' : ''}/>刷新状态</button></div>
    {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status"><Check size={15}/>{notice}</div>}
    {loading ? <div className="settings-loading"><LoaderCircle size={22} className="spin"/>正在读取 Work 设置…</div> : <>
      {runtime && <>
        <div className="work-admin-runtime"><strong><Terminal size={17}/>{runtime.available ? 'Work 已就绪' : runtime.configured ? 'Work 暂不可用' : '尚未连接 Work 服务'}</strong><p>{runtime.reason || (runtime.available ? '任务使用模型 API 和独立 Docker 沙箱，可读写文件、执行操作并使用技能。Claude Code 是可选运行方式。' : '请按部署文档启动 Work 服务，并刷新检查。')}</p></div>
        <form className="stack" key={version} onSubmit={save}>
          <label className="checkbox-label"><input type="checkbox" name="enabled" defaultChecked={runtime.settings.enabled}/>启用 Work 模式</label>
          <div className="form-grid"><label>每次任务最多轮次<input type="number" name="maxTurns" defaultValue={runtime.settings.maxTurns} min={1} max={80} required/><span className="field-help">限制 Agent 循环次数。</span></label><label>任务最长时间（秒）<input type="number" name="timeoutSeconds" defaultValue={runtime.settings.timeoutSeconds} min={0} max={1800} step={1} required/><span className="field-help">0 表示不限时；需要时限时填写 30–1800。仍可主动停止，轮次、单次请求超时和资源限制继续生效。修改从下次任务生效。</span></label></div>
          <div className="form-grid"><label>每个任务内存（MB）<input type="number" name="memoryMb" defaultValue={runtime.settings.memoryMb} min={512} max={4096} step={128} required/></label><label>每个任务 CPU 核数<input type="number" name="cpus" defaultValue={runtime.settings.cpus} min={0.25} max={4} step={0.25} required/></label></div>
          <div className="form-grid"><label>单次任务预算（美元）<input type="number" name="maxBudgetUsd" defaultValue={runtime.settings.maxBudgetUsd} min={0.1} max={20} step={0.01} required/><span className="field-help">Claude Code 任务的预算上限；直接 API 任务以轮次和时间限制控制，实际扣费以服务商为准。</span></label><label>同时运行任务数<input type="number" name="maxConcurrentJobs" defaultValue={runtime.settings.maxConcurrentJobs} min={1} max={4} required/></label></div>
          <div className="settings-card stack">
            <strong>工作文件额度</strong>
            <p className="field-help">填写 0 表示不限制该项额度。修改从下次任务生效，已有文件保留并可下载。</p>
            <div className="form-grid"><label>每个对话文件总量（MB）<input type="number" name="artifactTotalMb" defaultValue={runtime.settings.artifactTotalMb ?? 0} min={0} max={1048576} required/></label><label>每个对话文件数量<input type="number" name="artifactMaxFiles" defaultValue={runtime.settings.artifactMaxFiles ?? 0} min={0} max={1000000} required/></label></div>
            <label>每位用户文件存储（MB）<input type="number" name="userStorageMb" defaultValue={runtime.settings.userStorageMb ?? 0} min={0} max={1048576} required/></label>
            <p className="field-help">单个下载文件上限仍为 10 MB；大文件可压缩或拆分。实际容量取决于服务器磁盘和沙箱资源。</p>
          </div>
          <div className="form-actions"><button className="button primary" disabled={!!busy}><Check size={15}/>保存 Work 设置</button></div>
        </form>
      </>}
      <WorkSearchSettings onChanged={onChanged}/>
      <div className="section-title" style={{ marginTop: 30 }}><div><h3>技能库</h3><p>以 SKILL.md 文本导入技能。成员可以选择使用，也可以下载到本地。</p></div><button className="button small" disabled={!!busy || skills.length >= 32} onClick={() => setAdding(!adding)}><Plus size={15}/>添加技能</button></div>
      {adding && <form className="settings-card stack" onSubmit={createSkill}>
        <div className="card-heading"><strong>添加技能</strong><button className="icon-button" type="button" aria-label="关闭添加技能" onClick={() => setAdding(false)}><X size={16}/></button></div>
        <label>导入方式<select value={source} onChange={event => setSource(event.target.value as 'content' | 'url')}><option value="content">粘贴 SKILL.md 内容</option><option value="url">从公开链接导入</option></select></label>
        <label>技能名称<input name="name" required={source === 'content'} maxLength={64} pattern="[a-z0-9][a-z0-9-]{0,63}" placeholder="例如：research-report"/><span className="field-help">1–64 个小写英文字母、数字或连字符。链接导入时可留空，使用文件中的名称。</span></label>
        <label>简介<input name="description" required={source === 'content'} maxLength={500} placeholder="说明这个技能适合处理什么任务"/></label>
        {source === 'content' ? <label>SKILL.md 内容<textarea name="content" rows={10} required maxLength={65536} placeholder={'---\nname: research-report\ndescription: 整理研究结果并编写报告\n---\n\n# 任务指引\n…'}/></label> : <label>公开文本链接<input type="url" name="url" required placeholder="https://example.com/SKILL.md"/><span className="field-help">填写直接返回 SKILL.md 文本的公开 HTTPS 地址。</span></label>}
        <div className="form-actions"><button className="button" type="button" onClick={() => setAdding(false)}>取消</button><button className="button primary" disabled={!!busy}>{busy === 'skill-add' && <LoaderCircle size={15} className="spin"/>}添加技能</button></div>
      </form>}
      {!skills.length && !adding ? <div className="settings-empty"><div className="empty-icon"><BookOpen size={24}/></div><h4>尚未添加技能</h4><p>导入任务指引后，可在 Work 输入框中选择。</p></div> : <div className="work-skill-admin-list">{skills.map(skill => <div className="work-skill-admin-row" key={skill.id}><div><strong>{skill.name}</strong>{skill.description && <p>{skill.description}</p>}{deleting === skill.id && <div className="inline-confirm"><span>从技能库移除此技能？</span><button className="button small" onClick={() => setDeleting(null)}>取消</button><button className="button danger small" disabled={!!busy} onClick={async () => { if (await run('skill-delete', () => remove(`/work/skills/${encodeURIComponent(skill.id)}`), '技能已移除。')) setDeleting(null); }}>移除</button></div>}</div><a className="icon-button" href={`/api/work/skills/${encodeURIComponent(skill.id)}/download`} aria-label={`下载 ${skill.name}`} title="下载 SKILL.md"><Download size={16}/></a><button className="icon-button danger-text" disabled={!!busy} aria-label={`删除 ${skill.name}`} title="删除技能" onClick={() => setDeleting(skill.id)}><Trash2 size={16}/></button></div>)}</div>}
    </>}
  </div>;
}
