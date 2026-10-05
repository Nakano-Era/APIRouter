import { useEffect, useState, type FormEvent } from 'react';
import { Check, Download, FileKey2, LoaderCircle, Upload } from 'lucide-react';
import { errorText, post } from '../../api';
import './configuration-transfer.css';

interface TransferCount { section: string; create: number; update: number; preserve: number }
interface TransferPreview {
  fingerprint: string;
  confirmation: string;
  expiresAt: string;
  summary: TransferCount[];
  conflicts: { section: string; label: string; action: string }[];
  warnings: string[];
}
const fileLimit = 44 * 1024 * 1024;

function Summary({ rows }: { rows: TransferCount[] }) {
  return <div className="config-transfer-table"><table><caption>配置合并明细</caption><thead><tr><th scope="col">配置</th><th scope="col">新增</th><th scope="col">更新</th><th scope="col">保留</th></tr></thead><tbody>{rows.map(row => <tr key={row.section}><th scope="row">{row.section}</th><td>{row.create}</td><td>{row.update}</td><td>{row.preserve}</td></tr>)}</tbody></table></div>;
}

export default function ConfigurationTransferPanel({ onImported }: { onImported: () => Promise<void> }) {
  const [busy, setBusy] = useState<'export' | 'preview' | 'import' | ''>('');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [file, setFile] = useState<File | null>(null), [inputRevision, setInputRevision] = useState(0);
  const [currentPassword, setCurrentPassword] = useState(''), [backupPassword, setBackupPassword] = useState('');
  const [preview, setPreview] = useState<TransferPreview | null>(null), [acknowledged, setAcknowledged] = useState(false);
  const [imported, setImported] = useState<TransferCount[] | null>(null), [clock, setClock] = useState(Date.now());
  const [download, setDownload] = useState<{ url: string; filename: string } | null>(null);
  useEffect(() => () => { if (download) URL.revokeObjectURL(download.url); }, [download]);
  const expired = !!preview && new Date(preview.expiresAt).getTime() <= clock;
  useEffect(() => { if (!preview) return; const timer = window.setInterval(() => setClock(Date.now()), 10_000); return () => window.clearInterval(timer); }, [preview]);

  function resetPreview() { setPreview(null); setAcknowledged(false); setImported(null); setError(''); setNotice(''); }
  async function exportConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const form = event.currentTarget, values = new FormData(form);
    if (values.get('password') !== values.get('confirmPassword')) { setError('两次输入的配置文件密码不一致。'); return; }
    setBusy('export'); setError(''); setNotice('');
    try {
      const document = await post<unknown>('/admin/config/export', { currentPassword: values.get('currentPassword'), password: values.get('password') });
      const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
      const filename = `apirouter-config-${new Date().toISOString().replace(/[:.]/g, '-')}.encrypted.json`;
      setDownload({ url, filename });
      const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = filename;
      window.document.body.append(anchor); anchor.click(); anchor.remove();
      form.reset(); setNotice('加密配置文件已生成并请求下载。如果浏览器未开始下载，请点击下方“下载配置文件”。');
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(''); }
  }
  async function previewConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !file) return;
    resetPreview(); setBusy('preview');
    try {
      if (file.size > fileLimit) throw new Error('配置文件最大为 44 MiB。');
      let document: unknown;
      try { document = JSON.parse(await file.text()); } catch { throw new Error('无法读取配置文件，请选择本站导出的加密 JSON 文件。'); }
      const result = await post<TransferPreview>('/admin/config/preview', { currentPassword, password: backupPassword, document });
      setPreview(result); setClock(Date.now());
    } catch (cause) { setError(errorText(cause)); } finally { setBusy(''); }
  }
  async function importConfig() {
    if (busy || !preview || !acknowledged || expired) return;
    setBusy('import'); setError(''); setNotice('');
    try {
      const result = await post<{ ok: true; summary: TransferCount[] }>('/admin/config/import', { currentPassword, fingerprint: preview.fingerprint, confirmation: preview.confirmation });
      setImported(result.summary); setPreview(null); setAcknowledged(false); setCurrentPassword(''); setBackupPassword(''); setFile(null); setInputRevision(value => value + 1);
      setNotice('配置已成功导入。当前管理员账号与登录保持有效，可前往各管理页面查看。');
      try { await onImported(); } catch { setError('配置已导入，但页面刷新失败。请刷新浏览器查看最新配置，无需重复导入。'); }
    } catch (cause) { setError(errorText(cause)); setPreview(null); setAcknowledged(false); } finally { setBusy(''); }
  }

  return <section className="admin-section config-transfer"><div className="section-title"><div><h3>配置迁移</h3><p>将本站配置打包，导入部署在另一台服务器上的 APIRouter。</p></div><FileKey2 size={23}/></div>
    {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert success" role="status"><Check size={16}/>{notice}</div>}
    {download && <a className="button" href={download.url} download={download.filename}><Download size={16}/>下载配置文件</a>}
    <div className="settings-card stack"><strong>一个文件，迁移全部后台配置</strong><p>包含 API 连接及密钥、模型与版本、失败重试、用户及独立限额、专属路由与回落方案、套餐与支付设置、特殊邀请分组、公告、对外 API 权限、Work 设置与技能。</p><p className="field-help">聊天记录、工作文件、登录设备、用量及支付历史不在此文件内；整站迁移这些数据请使用服务器的完整备份与恢复功能。域名、HTTPS 和 Docker 环境由新服务器自行配置。</p></div>
    <form className="settings-card stack" onSubmit={exportConfig}><div><h4>导出配置</h4><p className="field-help">配置含渠道密钥和账号密码哈希，文件始终加密。请妥善保存文件密码，遗失后无法找回。</p></div><fieldset disabled={!!busy} className="config-transfer-fields"><label>当前管理员密码<input name="currentPassword" type="password" required maxLength={256} autoComplete="current-password"/></label><div className="form-grid"><label>配置文件密码<input name="password" type="password" required minLength={12} maxLength={256} autoComplete="new-password" placeholder="至少 12 个字符"/></label><label>确认配置文件密码<input name="confirmPassword" type="password" required minLength={12} maxLength={256} autoComplete="new-password"/></label></div><div className="form-actions"><button className="button primary" type="submit">{busy === 'export' ? <LoaderCircle size={16} className="spin"/> : <Download size={16}/>}一键导出所有配置</button></div></fieldset></form>
    <form className="settings-card stack" onSubmit={previewConfig}><div><h4>导入配置</h4><p className="field-help">先预览合并结果再导入。同邮箱账号保留本机密码、角色和停用状态；新账号可使用原密码登录。本机独有配置会保留。</p></div><fieldset disabled={!!busy} className="config-transfer-fields"><label>加密配置文件<input key={inputRevision} type="file" accept=".json,application/json" required onChange={event => { resetPreview(); const selected = event.target.files?.[0] ?? null; if (selected && selected.size > fileLimit) { setFile(null); setError('配置文件最大为 44 MiB。'); event.target.value = ''; } else setFile(selected); }}/><span className="field-help">选择从“配置迁移”导出的 .encrypted.json 文件，最大 44 MiB。</span></label><div className="form-grid"><label>本机管理员密码<input type="password" required maxLength={256} autoComplete="current-password" value={currentPassword} onChange={event => { setCurrentPassword(event.target.value); resetPreview(); }}/></label><label>文件解密密码<input type="password" required minLength={12} maxLength={256} autoComplete="off" value={backupPassword} onChange={event => { setBackupPassword(event.target.value); resetPreview(); }}/></label></div><div className="form-actions"><button className="button" type="submit" disabled={!file}>{busy === 'preview' ? <LoaderCircle size={16} className="spin"/> : <Upload size={16}/>}预览导入结果</button></div></fieldset></form>
    {preview && <div className="settings-card stack config-transfer-preview"><div className="card-heading"><h4>确认合并配置</h4><span className="muted">{expired ? '预览已过期' : `有效至 ${new Date(preview.expiresAt).toLocaleTimeString('zh-CN')}`}</span></div><Summary rows={preview.summary}/>{preview.warnings.length > 0 && <div className="config-transfer-warnings"><strong>导入须知</strong><ul>{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}{preview.conflicts.length > 0 && <details><summary>查看 {preview.conflicts.length} 项合并处理</summary><ul className="config-transfer-conflicts">{preview.conflicts.map((conflict, index) => <li key={index}><strong>{conflict.section} · {conflict.label}</strong><span>{conflict.action}</span></li>)}</ul></details>}<label className="config-transfer-ack"><input type="checkbox" checked={acknowledged} disabled={!!busy || expired} onChange={event => setAcknowledged(event.target.checked)}/><span>我已核对上述明细，确认将源配置合并到本机。</span></label>{expired && <p className="field-help">请重新点击“预览导入结果”获取最新结果。</p>}<div className="form-actions"><button className="button" type="button" disabled={!!busy} onClick={() => { setPreview(null); setAcknowledged(false); }}>取消</button><button className="button primary" type="button" disabled={!!busy || !acknowledged || expired} onClick={() => void importConfig()}>{busy === 'import' ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}导入配置</button></div></div>}
    {imported && <div className="settings-card stack"><h4>导入完成</h4><Summary rows={imported}/><p className="field-help">请检查新服务器的 API 连通性；如需 Work，请启用 Docker 沙箱及搜索服务。Stripe 更换域名后需在 Stripe 后台核对 Webhook 地址与签名密钥。</p></div>}
  </section>;
}
