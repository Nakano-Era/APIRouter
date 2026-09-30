import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, patch, post, remove, stream } from '../api';
import type { Attachment, Chat, ChatMode, Message, Model, Settings, WorkArtifact, WorkCapabilities } from '../types';
import { interrupted, mergeSnapshot, upsertMessage } from './chat-state';

interface ChatView { messages: Message[]; artifacts: WorkArtifact[]; activity: string[]; error: string; routingNotice: string; generating: boolean }
interface ChatResponse { chat: Chat; messages: Message[]; generating?: boolean }
interface RunningTask { controller: AbortController; assistantId?: string; text: string; reasoning: string; stopping: boolean }
const emptyView = (): ChatView => ({ messages: [], artifacts: [], activity: [], error: '', routingNotice: '', generating: false });

export function useChat() {
  const [chats, setChats] = useState<Chat[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('');
  const [mode, setMode] = useState<ChatMode>('chat');
  const [effort, setEffort] = useState('auto');
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [webSearch, setWebSearch] = useState(false);
  const [capabilities, setCapabilities] = useState<WorkCapabilities | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [chatLoading, setChatLoading] = useState(false);
  const [views, setViews] = useState<Record<string, ChatView>>({ '': emptyView() });
  const viewsRef = useRef(views);
  const selectedRef = useRef<string | null>(null);
  const running = useRef(new Map<string, RunningTask>());
  const recovering = useRef(new Set<string>());
  const polling = useRef(new Set<string>());
  const revisions = useRef(new Map<string, number>());
  const restored = useRef(false);
  const creating = useRef(false);
  const loadSequence = useRef(0);
  const live = useRef(true);
  const currentView = views[selectedId || ''] || emptyView();
  const { messages, artifacts, activity, generating, error, routingNotice } = currentView;
  const activeChatIds = Object.keys(views).filter(id => id && views[id].generating);

  const updateView = useCallback((id: string | null, update: (current: ChatView) => ChatView) => {
    if (!live.current) return;
    const key = id || '';
    const next = { ...viewsRef.current, [key]: update(viewsRef.current[key] || emptyView()) };
    viewsRef.current = next; setViews(next);
  }, []);
  const setError = useCallback((value: string) => updateView(selectedRef.current, current => ({ ...current, error: value })), [updateView]);
  const refreshChats = useCallback(async () => { const data = await api<{ chats: Chat[] }>('/chats'); if (live.current) setChats(data.chats); }, []);
  const refreshCapabilities = useCallback(async () => {
    try {
      const data = await api<WorkCapabilities>('/work/capabilities');
      if (!live.current) return;
      setCapabilities(data); setSkillIds(current => current.filter(id => data.skills.some(skill => skill.id === id)));
      if (data.webSearchSupported === false) setWebSearch(false);
    } catch { if (live.current) setCapabilities({ available: false, reason: '暂时无法连接 Work 服务，请稍后重试。', skills: [] }); }
  }, []);
  const refreshModels = useCallback(async () => {
    const [data, config] = await Promise.all([api<{ models: Model[]; defaultModelId: string | null }>('/models'), api<{ settings: Settings }>('/settings')]);
    if (!live.current) return;
    setModels(data.models); setSettings(config.settings);
    setModelId(current => data.models.some(model => model.id === current) ? current : data.models.some(model => model.id === data.defaultModelId) ? data.defaultModelId! : data.models[0]?.id || '');
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
    live.current = true;
    Promise.all([refreshChats(), refreshModels()]).catch(err => setError(errorText(err))).finally(() => { if (live.current) setLoading(false); });
    return () => { live.current = false; for (const task of running.current.values()) task.controller.abort(); };
  }, [refreshChats, refreshModels, setError]);

  const refreshArtifacts = useCallback(async (id: string) => {
    try {
      const files = await api<{ artifacts: WorkArtifact[] }>(`/work/chats/${id}/artifacts`);
      updateView(id, current => ({ ...current, artifacts: files.artifacts }));
    } catch { /* Keep already received files when reconnecting is unavailable. */ }
  }, [updateView]);
  const applySnapshot = useCallback((id: string, data: ChatResponse) => {
    // Active streams own their deltas; snapshots only recover disconnected tasks.
    const local = running.current.has(id);
    if (data.generating && !local) recovering.current.add(id);
    if (!data.generating) recovering.current.delete(id);
    updateView(id, current => ({ ...current, messages: local ? current.messages : mergeSnapshot(current.messages, data.messages), generating: local || !!data.generating,
      routingNotice: !local && data.generating ? '正在恢复连接，任务仍在继续…' : local ? current.routingNotice : '' }));
    if (live.current) setChats(current => [data.chat, ...current.filter(chat => chat.id !== id)]);
  }, [updateView]);
  const recover = useCallback(async (id: string) => {
    if (polling.current.has(id) || running.current.has(id)) return;
    polling.current.add(id);
    const revision = revisions.current.get(id);
    try {
      const data = await api<ChatResponse>(`/chats/${id}`);
      if (revision !== revisions.current.get(id)) return;
      applySnapshot(id, data);
      if (!data.generating) { void refreshArtifacts(id); void refreshChats().catch(() => {}); }
    } catch {
      if (revision === revisions.current.get(id)) updateView(id, current => ({ ...current, messages: interrupted(current.messages), generating: false, routingNotice: '', error: '暂时无法恢复连接。已收到的内容会保留，连接恢复后可继续生成。' }));
    } finally { polling.current.delete(id); }
  }, [applySnapshot, refreshArtifacts, refreshChats, updateView]);
  useEffect(() => {
    const tick = () => { for (const id of recovering.current) void recover(id); };
    const timer = window.setInterval(tick, 1500); window.addEventListener('focus', tick);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', tick); };
  }, [recover]);
  useEffect(() => {
    const refresh = () => { void refreshModels().catch(() => {}); };
    const timer = window.setInterval(refresh, 60000); window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [refreshModels]);

  const openChat = useCallback(async (id: string) => {
    const sequence = ++loadSequence.current;
    selectedRef.current = id; setSelectedId(id); setChatLoading(true);
    sessionStorage.setItem('apirouter-selected-chat', id);
    try {
      const data = await api<ChatResponse>(`/chats/${id}`); applySnapshot(id, data);
      if (sequence !== loadSequence.current) return false;
      setMode(data.chat.mode || 'chat'); setEffort(data.chat.effort || 'auto');
      setSkillIds(data.chat.skillIds || []); setWebSearch(!!data.chat.webSearch);
      const candidates = models.filter(model => (model.modes || ['chat']).includes(data.chat.mode || 'chat'));
      setModelId(current => candidates.some(model => model.id === data.chat.modelId) ? data.chat.modelId : candidates.some(model => model.id === current) ? current : candidates[0]?.id || '');
      void refreshArtifacts(id); return true;
    } catch (err) { updateView(id, current => ({ ...current, error: errorText(err) })); return false; }
    finally { if (sequence === loadSequence.current) setChatLoading(false); }
  }, [applySnapshot, models, refreshArtifacts, updateView]);
  useEffect(() => {
    if (loading || restored.current) return;
    restored.current = true;
    const saved = sessionStorage.getItem('apirouter-selected-chat');
    if (saved && chats.some(chat => chat.id === saved)) void openChat(saved);
  }, [loading, chats, openChat]);
  const newChat = useCallback(() => {
    loadSequence.current++; selectedRef.current = null; setSelectedId(null); setChatLoading(false);
    sessionStorage.removeItem('apirouter-selected-chat');
    updateView(null, () => emptyView());
  }, [updateView]);
  async function updateChat(id: string, values: Partial<Chat>) {
    try { const data = await patch<{ chat: Chat }>(`/chats/${id}`, values); setChats(current => current.map(chat => chat.id === id ? data.chat : chat)); if (id === selectedRef.current && values.archived) newChat(); }
    catch (err) { setError(errorText(err)); }
  }
  async function deleteChat(id: string) {
    if (running.current.has(id) || viewsRef.current[id]?.generating) { setError('请先停止该对话中的任务，再删除聊天。'); return; }
    try { await remove(`/chats/${id}`); recovering.current.delete(id); setChats(current => current.filter(chat => chat.id !== id)); if (id === selectedRef.current) newChat(); }
    catch (err) { setError(errorText(err)); }
  }
  async function generate(content: string, attachments: Attachment[] = [], action: 'messages' | 'regenerate' | 'edit' | 'continue' = 'messages', messageId?: string, onChatCreated?: (id: string) => void) {
    let chatId = selectedRef.current;
    if (chatLoading || (chatId ? running.current.has(chatId) || viewsRef.current[chatId]?.generating : creating.current)) return false;
    if (!modelId || !availableModels.some(model => model.id === modelId)) { setError('请先选择一个可用模型。'); return false; }
    if (mode === 'work' && !capabilities?.available) { setError(capabilities?.reason || 'Work 暂时不可用。'); return false; }
    const options = { modelId, mode, effort, skillIds: mode === 'work' ? skillIds : [], webSearch: mode === 'work' && webSearch };
    const sequence = loadSequence.current;
    const task: RunningTask = { controller: new AbortController(), text: '', reasoning: '', stopping: false };
    let accepted = false;
    updateView(chatId, current => ({ ...current, generating: true, error: '', routingNotice: '', activity: [] }));
    if (!chatId) creating.current = true;
    else { recovering.current.delete(chatId); revisions.current.set(chatId, (revisions.current.get(chatId) || 0) + 1); running.current.set(chatId, task); }
    try {
      if (!chatId) {
        const result = await post<{ chat: Chat }>('/chats', options);
        chatId = result.chat.id; onChatCreated?.(chatId); running.current.set(chatId, task);
        updateView(chatId, current => ({ ...current, generating: true })); setChats(current => [result.chat, ...current]);
        if (sequence === loadSequence.current && selectedRef.current === null) { selectedRef.current = chatId; setSelectedId(chatId); sessionStorage.setItem('apirouter-selected-chat', chatId); }
        updateView(null, current => ({ ...current, generating: false })); creating.current = false;
      }
      const id = chatId;
      const body = action === 'regenerate' ? options : action === 'continue' ? { ...options, messageId } : { ...options, content, attachmentIds: attachments.map(attachment => attachment.id), ...(messageId ? { messageId } : {}) };
      await stream(`/chats/${id}/${action}`, body, task.controller.signal, (event, data) => {
        if (event === 'meta') {
          accepted = true;
          if (data.chat) setChats(current => [data.chat!, ...current.filter(chat => chat.id !== data.chat!.id)]);
          if (data.assistantMessage) { task.assistantId = data.assistantMessage.id; task.text = data.assistantMessage.content; task.reasoning = data.assistantMessage.reasoning || ''; }
          updateView(id, current => {
            let previous = current.messages;
            if (action === 'edit') { const index = previous.findIndex(message => message.id === messageId); if (index >= 0) previous = previous.slice(0, index); }
            if (action === 'regenerate' && previous.at(-1)?.role === 'assistant') previous = previous.slice(0, -1);
            if (data.userMessage) previous = upsertMessage(previous, data.userMessage);
            if (data.assistantMessage) previous = upsertMessage(previous, data.assistantMessage);
            return { ...current, messages: previous };
          });
        }
        if (event === 'delta') {
          task.text += data.text || '';
          updateView(id, current => ({ ...current, routingNotice: '', messages: current.messages.map(message => message.id === task.assistantId && task.text.length >= message.content.length ? { ...message, content: task.text } : message) }));
        }
        if (event === 'reasoning') {
          task.reasoning += data.text || '';
          updateView(id, current => ({ ...current, routingNotice: '', messages: current.messages.map(message => message.id === task.assistantId && task.reasoning.length >= (message.reasoning?.length || 0) ? { ...message, reasoning: task.reasoning } : message) }));
        }
        if (event === 'routing') updateView(id, current => ({ ...current, routingNotice: '正在连接模型，请稍候…' }));
        if (event === 'activity' && data.label) updateView(id, current => ({ ...current, activity: current.activity.at(-1) === data.label ? current.activity : [...current.activity.slice(-19), data.label!] }));
        if (event === 'artifact' && data.artifact) updateView(id, current => ({ ...current, artifacts: [...current.artifacts.filter(file => file.id !== data.artifact!.id), data.artifact!] }));
        if ((event === 'done' || event === 'error') && data.message && typeof data.message !== 'string') {
          const message = data.message; updateView(id, current => ({ ...current, messages: upsertMessage(current.messages, message), error: event === 'done' ? '' : current.error }));
        }
        if (event === 'error') updateView(id, current => ({ ...current, error: data.error || '回答未完成，可继续生成。' }));
      });
      return accepted;
    } catch (err) {
      if (!task.controller.signal.aborted) updateView(chatId, current => ({ ...current, error: errorText(err) }));
      return accepted;
    } finally {
      if (chatId) {
        running.current.delete(chatId);
        updateView(chatId, current => ({ ...current, generating: false, routingNotice: '', messages: task.stopping ? current.messages.map(message => message.status === 'streaming' ? { ...message, status: 'stopped', canContinue: true } : message) : interrupted(current.messages) }));
        if (live.current) { recovering.current.add(chatId); await recover(chatId); }
      } else { creating.current = false; updateView(null, current => ({ ...current, generating: false })); }
      if (live.current) void refreshChats().catch(() => {});
    }
  }
  async function stop() {
    const id = selectedRef.current; if (!id) return;
    const task = running.current.get(id);
    try {
      if (task) task.stopping = true;
      // Persist stop before aborting the transport, so recovery cannot revive it.
      await post(`/chats/${id}/stop`); task?.controller.abort();
      if (!task) { recovering.current.add(id); await recover(id); }
    } catch (err) { if (task) task.stopping = false; setError(errorText(err)); }
  }
  return { chats, messages, models, availableModels, modelId, setModelId, mode, setMode, effort, setEffort, skillIds, setSkillIds, webSearch, setWebSearch, capabilities, artifacts, activity, settings, selectedId, activeChatIds, loading, chatLoading, generating, routingNotice, error, setError, openChat, newChat, updateChat, deleteChat, generate, stop, refreshModels };
}
