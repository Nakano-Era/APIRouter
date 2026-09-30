import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowUp, FileText, LoaderCircle, Paperclip, Plus, Square, X } from 'lucide-react';
import { api, errorText, remove } from '../api';
import type { Attachment, Model } from '../types';
export interface ComposerDraft { content: string; files: Attachment[]; uploading: boolean; error: string }
export const emptyComposerDraft = (): ComposerDraft => ({ content: '', files: [], uploading: false, error: '' });
export default function Composer({ onSend, onStop, generating, model, draft, onDraftChange, tools, modelControls, work = false, disabled = false }: { onSend: (content: string, files: Attachment[]) => Promise<boolean>; onStop: () => void; generating: boolean; model?: Model; draft: ComposerDraft; onDraftChange: (update: (current: ComposerDraft) => ComposerDraft) => void; tools?: ReactNode; modelControls?: ReactNode; work?: boolean; disabled?: boolean }) {
  const { content, files, uploading, error } = draft; const [dragging, setDragging] = useState(false);
  const setContent = (value: string) => onDraftChange(current => ({ ...current, content: value }));
  const setFiles = (value: Attachment[] | ((current: Attachment[]) => Attachment[])) => onDraftChange(current => ({ ...current, files: typeof value === 'function' ? value(current.files) : value }));
  const onError = (value: string) => onDraftChange(current => ({ ...current, error: value }));
  const setUploading = (value: boolean) => onDraftChange(current => ({ ...current, uploading: value }));
  const input = useRef<HTMLInputElement>(null); const textarea = useRef<HTMLTextAreaElement>(null); const sending = useRef(false);
  useEffect(() => { const node = textarea.current; if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, 220)}px`; } }, [content]);
  async function upload(incoming: FileList | File[]) {
    if (generating || uploading) return;
    if (incoming.length + files.length > 5) { onError('每条消息最多添加 5 个文件。'); return; }
    if (Array.from(incoming).some(file => file.size > 10 * 1024 * 1024)) { onError('单个文件不能超过 10 MB。'); return; }
    setUploading(true); onError(''); const form = new FormData(); Array.from(incoming).forEach(file => form.append('files', file));
    try { const result = await api<{ files: Attachment[] }>('/files', { method: 'POST', body: form }); setFiles(current => [...current, ...result.files]); }
    catch (err) { onError(errorText(err)); } finally { setUploading(false); if (input.current) input.current.value = ''; }
  }
  async function submit() {
    if (sending.current || generating || uploading || disabled || !model || (!content.trim() && !files.length)) return;
    if (files.some(file => file.kind === 'image') && !model.vision) { onError('当前模型未开启图片识别，请选择支持识图的模型，或移除图片。'); return; }
    const text = content.trim(); const savedFiles = files; sending.current = true; setContent(''); setFiles([]);
    try { const accepted = await onSend(text, savedFiles); if (!accepted) { setContent(text); setFiles(savedFiles); } }
    finally { sending.current = false; textarea.current?.focus(); }
  }
  function drop(event: DragEvent) { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) void upload(event.dataTransfer.files); }
  return <div className={`composer ${dragging ? 'dragging' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={drop}>{error && <div className="alert error" role="alert">{error}<button className="icon-button" aria-label="关闭附件提示" onClick={() => onError('')}><X size={13}/></button></div>}{files.length > 0 && <div className="composer-files">{files.map(file => <div className="attachment-chip" key={file.id}>{file.kind === 'image' ? <img src={file.url} alt={file.name}/> : <div className="file-icon"><FileText size={19}/></div>}<div><strong>{file.name}</strong><span>{file.kind === 'image' ? '图片' : '文档'} · {Math.max(1,Math.round(file.size/1024))} KB</span></div><button className="icon-button" aria-label={`移除 ${file.name}`} onClick={() => { setFiles(current => current.filter(f => f.id !== file.id)); remove(`/files/${file.id}`).catch(() => {}); }}><X size={13}/></button></div>)}</div>}<textarea ref={textarea} value={content} disabled={generating} onChange={e => setContent(e.target.value)} placeholder={work ? "描述任务，让 Work 为你完成" : "询问任何问题"} aria-label="消息内容" rows={1} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} onPaste={e => { const images = Array.from(e.clipboardData.files); if (images.length) { e.preventDefault(); void upload(images); } }}/><div className="composer-toolbar"><div className="composer-tools"><input ref={input} type="file" multiple hidden accept=".png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.json,.pdf,.docx,.xlsx,.js,.ts,.tsx,.jsx,.py,.html,.css,.xml,.yaml,.yml,.sql,.sh,.log" onChange={e => { if (e.target.files?.length) void upload(e.target.files); }}/><button className="icon-button attach-button" aria-label="添加文件或图片" title="添加文件或图片（每个最多 10 MB）" onClick={() => input.current?.click()} disabled={uploading || generating}>{uploading ? <LoaderCircle className="spin" size={19}/> : <Plus size={22}/>}</button>{tools}{uploading && <span className="composer-capability" role="status">正在读取文件…</span>}</div><div className="composer-submit-tools">{modelControls}{generating ? <button className="send-button stop-button" onClick={onStop} aria-label="停止生成" title="停止生成"><Square size={14} fill="currentColor"/></button> : <button className="send-button" onClick={() => void submit()} disabled={disabled || !model || uploading || (!content.trim() && !files.length)} aria-label="发送消息" title="发送消息"><ArrowUp size={20}/></button>}</div></div>{dragging && <div className="drop-zone"><Paperclip size={24}/>松开以添加文件</div>}</div>;
}
