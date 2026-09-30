import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, patch, post, remove, stream } from '../api';
import type { Attachment, Chat, ChatMode, Message, Model, Settings, WorkArtifact, WorkCapabilities } from '../types';

export function useChat() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('');
  const [mode, setMode] = useState<ChatMode>('chat');
  const [effort, setEffort] = useState('auto');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [webSearch, setWebSearch] = useState(false);
  const [capabilities, setCapabilities] = useState<WorkCapabilities | null>(null);
  const [artifacts, setArtifacts] = useState<WorkArtifact[]>([]);
  const [activity, setActivity] = useState<string[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [routingNotice, setRoutingNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const runningId = useRef<string | null>(null);
  const busy = useRef(false);
  const loadSequence = useRef(0);
  const refreshChats = useCallback(async () => { const data = await api<{ chats: Chat[] }>('/chats'); setChats(data.chats); }, []);
  const refreshCapabilities = useCallback(async () => {
    try {
      const data = await api<WorkCapabilities>('/work/capabilities');
      setCapabilities(data);
      setSkillIds(current => current.filter(id => data.skills.some(skill => skill.id === id)));
      if (data.webSearchSupported === false) setWebSearch(false);
    } catch {
      setCapabilities({ available: false, reason: '暂时无法连接 Work 服务，请稍后重试。', skills: [] });
    }
  }, []);
  const refreshModels = useCallback(async () => {
    const [data, config] = await Promise.all([api<{ models: Model[]; defaultModelId: string | null }>('/models'), api<{ settings: Settings }>('/settings')]);
    setModels(data.models); setSettings(config.settings);
    setModelId(current => data.models.some(m => m.id === current) ? current : data.models.some(m => m.id === data.defaultModelId) ? data.defaultModelId! : data.models[0]?.id || '');
    void refreshCapabilities();
  }, [refreshCapabilities]);
  const availableModels = models.filter(model => (model.modes || ['chat']).includes(mode));
  useEffect(() => {
    if (loading || chatLoading || generating) return;
    if (!availableModels.some(model => model.id === modelId)) setModelId(availableModels[0]?.id || '');
    const current = availableModels.find(model => model.id === modelId);
    if (effort !== 'auto' && !current?.reasoningEfforts?.includes(effort)) setEffort('auto');
  }, [models, mode, modelId, effort, loading, chatLoading, generating]);
  useEffect(() => {
    let live = true;
    Promise.all([refreshChats(), refreshModels()]).catch(err => { if (live) setError(errorText(err)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [refreshChats, refreshModels]);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => {
    const refresh = () => { if (!busy.current) refreshModels().catch(() => {}); };
    const timer = window.setInterval(refresh, 60000); window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [refreshModels]);
  const openChat = useCallback(async (id: string) => {
    if (busy.current) { setError('请先停止当前回答，再切换对话。'); return false; }
    const sequence = ++loadSequence.current; setChatLoading(true); setError('');
    try {
      const data = await api<{ chat: Chat; messages: Message[] }>(`/chats/${id}`);
      if (sequence !== loadSequence.current) return false;
      setSelectedId(id); setMessages(data.messages); setMode(data.chat.mode || 'chat'); setEffort(data.chat.effort || 'auto');
      setSkillIds(data.chat.skillIds || []); setWebSearch(!!data.chat.webSearch); setActivity([]); setArtifacts([]);
      const candidates = models.filter(model => (model.modes || ['chat']).includes(data.chat.mode || 'chat'));
      setModelId(current => candidates.some(model => model.id === data.chat.modelId) ? data.chat.modelId : candidates.some(model => model.id === current) ? current : candidates[0]?.id || '');
      try {
        const files = await api<{ artifacts: WorkArtifact[] }>(`/work/chats/${id}/artifacts`);
        if (sequence === loadSequence.current) setArtifacts(files.artifacts);
      } catch { /* A normal chat can remain usable when Work is not configured. */ }
      return true;
    } catch (err) { if (sequence === loadSequence.current) setError(errorText(err)); return false; }
    finally { if (sequence === loadSequence.current) setChatLoading(false); }
  }, [models]);
  const newChat = useCallback(() => {
    if (busy.current) { setError('请先停止当前回答，再开始新对话。'); return; }
    loadSequence.current++; setChatLoading(false); setSelectedId(null); setMessages([]); setArtifacts([]); setActivity([]); setError('');
  }, []);
  async function updateChat(id: string, values: Partial<Chat>) {
    try { const data = await patch<{ chat: Chat }>(`/chats/${id}`, values); setChats(current => current.map(c => c.id === id ? data.chat : c)); if (id === selectedId && values.archived) newChat(); }
    catch (err) { setError(errorText(err)); }
  }
  async function deleteChat(id: string) {
    try { await remove(`/chats/${id}`); setChats(current => current.filter(c => c.id !== id)); if (id === selectedId) newChat(); }
    catch (err) { setError(errorText(err)); }
  }
  async function generate(content: string, attachments: Attachment[] = [], action: 'messages' | 'regenerate' | 'edit' = 'messages', messageId?: string) {
    if (busy.current || chatLoading) return false;
    if (!modelId || !availableModels.some(m => m.id === modelId)) { setError('请先选择一个可用模型。'); return false; }
    if (mode === 'work' && !capabilities?.available) { setError(capabilities?.reason || 'Work 暂时不可用。'); return false; }
    const options = { modelId, mode, effort, skillIds: mode === 'work' ? skillIds : [], webSearch: mode === 'work' && webSearch };
    busy.current = true; setGenerating(true); setError(''); setRoutingNotice(''); setActivity([]);
    let chatId = selectedId; let accepted = false;
    const abort = new AbortController(); controller.current = abort;
    try {
      if (!chatId) {
        const result = await post<{ chat: Chat }>('/chats', options); chatId = result.chat.id; setSelectedId(chatId); setChats(current => [result.chat, ...current]);
      }
      runningId.current = chatId;
      const body = action === 'regenerate' ? options : { ...options, content, attachmentIds: attachments.map(a => a.id), ...(messageId ? { messageId } : {}) };
      await stream(`/chats/${chatId}/${action}`, body, abort.signal, (event, data) => {
        if (event === 'meta') {
          accepted = true;
          if (data.chat) setChats(current => [data.chat!, ...current.filter(c => c.id !== data.chat!.id)]);
          setMessages(current => {
            let previous = current;
            if (action === 'edit') { const index = current.findIndex(m => m.id === messageId); previous = index >= 0 ? current.slice(0, index) : current; }
            if (action === 'regenerate' && previous.at(-1)?.role === 'assistant') previous = previous.slice(0, -1);
            if (data.userMessage && !previous.some(m => m.id === data.userMessage!.id)) previous = [...previous, data.userMessage];
            return data.assistantMessage ? [...previous, data.assistantMessage] : previous;
          });
        }
        if (event === 'delta') {
          setMessages(current => current.map((message, index) => index === current.length - 1 && message.role === 'assistant' ? { ...message, content: message.content + (data.text || '') } : message));
          setRoutingNotice('');
        }
        if (event === 'routing') setRoutingNotice('正在连接模型，请稍候…');
        if (event === 'activity' && data.label) setActivity(current => current.at(-1) === data.label ? current : [...current.slice(-19), data.label!]);
        if (event === 'artifact' && data.artifact) setArtifacts(current => [...current.filter(file => file.id !== data.artifact!.id), data.artifact!]);
        if (event === 'done' && data.message && typeof data.message !== 'string') { const message = data.message; setMessages(current => current.map(m => m.id === message.id ? message : m)); }
        if (event === 'error') {
          setError(data.error || '模型返回错误。');
          if (data.message && typeof data.message !== 'string') { const message = data.message; setMessages(current => current.map(m => m.id === message.id ? message : m)); }
        }
      });
      return accepted;
    } catch (err) { if (!abort.signal.aborted) setError(errorText(err)); return accepted; }
    finally {
      controller.current = null; runningId.current = null;
      if (chatId) {
        try { const result = await api<{ chat: Chat; messages: Message[] }>(`/chats/${chatId}`); setMessages(result.messages.map(message => abort.signal.aborted && message.status === 'streaming' ? { ...message, status: 'stopped' } : message)); }
        catch { setMessages(current => current.map(message => message.status === 'streaming' ? { ...message, status: abort.signal.aborted ? 'stopped' : 'error' } : message)); }
        if (mode === 'work') {
          try { const result = await api<{ artifacts: WorkArtifact[] }>(`/work/chats/${chatId}/artifacts`); setArtifacts(result.artifacts); }
          catch { /* Keep artifact events already received if the reload is unavailable. */ }
        }
      }
      refreshChats().catch(() => {}); busy.current = false; setGenerating(false); setRoutingNotice('');
    }
  }
  async function stop() { const id = runningId.current; controller.current?.abort(); if (id) { try { await post(`/chats/${id}/stop`); } catch (err) { setError(errorText(err)); } } }
  return { chats, messages, models, availableModels, modelId, setModelId, mode, setMode, effort, setEffort, skillIds, setSkillIds, webSearch, setWebSearch, capabilities, artifacts, activity, settings, selectedId, loading, chatLoading, generating, routingNotice, error, setError, openChat, newChat, updateChat, deleteChat, generate, stop, refreshModels };
}
