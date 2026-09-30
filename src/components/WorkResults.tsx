import { BriefcaseBusiness, Check, ChevronDown, Download, FileText, LoaderCircle } from 'lucide-react';
import type { WorkArtifact } from '../types';
export default function WorkResults({ activity, artifacts, generating }: { activity: string[]; artifacts: WorkArtifact[]; generating: boolean }) {
  if (!activity.length && !artifacts.length) return null;
  const downloadable = artifacts.filter(file => file.downloadUrl?.startsWith('/api/work/'));
  return <section className="work-results" aria-label="任务进度与文件">
    {activity.length > 0 && <details className="work-activity"><summary>{generating ? <LoaderCircle size={16} className="spin"/> : <BriefcaseBusiness size={16}/>}<span>{generating ? activity.at(-1) : '查看任务活动'}</span><ChevronDown size={14}/></summary><ol>{activity.map((label, index) => <li key={`${index}-${label}`}>{generating && index === activity.length - 1 ? <LoaderCircle size={12} className="spin"/> : <Check size={12}/>}<span>{label}</span></li>)}</ol></details>}
    {downloadable.length > 0 && <div className="work-artifacts"><span className="work-artifact-heading">任务文件</span>{downloadable.map(file => <a href={file.downloadUrl} download className="work-artifact" key={file.id}><FileText size={22}/><span><strong>{file.name}</strong><small>{file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}</small></span><Download size={17}/></a>)}</div>}
  </section>;
}
