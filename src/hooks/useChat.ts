import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorText, patch, post, remove, stream } from '../api';
import type { Attachment, Chat, Message, Model, Settings } from '../types';

export function useChat() {
  const [chats, setChats] = useState<Chat[]>([]); const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<Model[]>([]); const [modelId, setModelId] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null); const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true); const [chatLoading, setChatLoading] = useState(false);
  const [generating, setGenerating] = useState(false); const [error, setError] = useState('');
  const [routingNotice,setRoutingNotice] = useState('');
  const controller = useRef<AbortController | null>(null); const runningId = useRef<string | null>(null); const busy = useRef(false); const loadSequence = useRef(0);
  const refreshChats = useCallback(async () => { const data = await api<{ chats: Chat[] }>('/chats'); setChats(data.chats); }, []);
  const refreshModels = useCallback(async () => {
    const [data, config] = await Promise.all([api<{ models: Model[]; defaultModelId: string | null }>('/models'), api<{ settings: Settings }>('/settings')]);
    setModels(data.models); setSettings(config.settings); setModelId(current => data.models.some(m => m.id === current) ? current : data.models.some(m => m.id === data.defaultModelId) ? data.defaultModelId! : data.models[0]?.id || '');
  }, []);
  useEffect(() => { let live = true; Promise.all([refreshChats(), refreshModels()]).catch(err => { if (live) setError(errorText(err)); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [refreshChats, refreshModels]);
  useEffect(() => () => { controller.current?.abort(); }, []);
  useEffect(() => { const refresh = () => { if (!busy.current) refreshModels().catch(() => {}); }; const timer = window.setInterval(refresh,60000); window.addEventListener('focus',refresh); return () => { window.clearInterval(timer); window.removeEventListener('focus',refresh); }; }, [refreshModels]);
  const openChat = useCallback(async (id: string) => {
    if (busy.current) { setError('请先停止当前回答，再切换对话。'); return false; }
    const sequence = ++loadSequence.current; setChatLoading(true); setError('');
    try { const data = await api<{ chat: Chat; messages: Message[] }>(`/chats/${id}`); if (sequence !== loadSequence.current) return false; setSelectedId(id); setMessages(data.messages); setModelId(current => models.some(model => model.id === data.chat.modelId) ? data.chat.modelId : models.some(model => model.id === current) ? current : models[0]?.id || ''); return true; }
    catch (err) { if (sequence === loadSequence.current) setError(errorText(err)); return false; }
    finally { if (sequence === loadSequence.current) setChatLoading(false); }
  }, [models]);
  const newChat = useCallback(() => { if (busy.current) { setError('请先停止当前回答，再开始新对话。'); return; } loadSequence.current++; setChatLoading(false); setSelectedId(null); setMessages([]); setError(''); }, []);
  async function updateChat(id: string, values: Partial<Chat>) { try { const data = await patch<{ chat: Chat }>(`/chats/${id}`, values); setChats(current => current.map(c => c.id === id ? data.chat : c)); if (id === selectedId && values.archived) newChat(); } catch (err) { setError(errorText(err)); } }
  async function deleteChat(id: string) { try { await remove(`/chats/${id}`); setChats(current => current.filter(c => c.id !== id)); if (id === selectedId) newChat(); } catch (err) { setError(errorText(err)); } }
  async function generate(content: string, attachments: Attachment[] = [], mode: 'messages' | 'regenerate' | 'edit' = 'messages', messageId?: string) {
    if (busy.current || chatLoading) return false;
    if (!modelId || !models.some(m => m.id === modelId)) { setError('请先选择一个可用模型。'); return false; }
    busy.current = true; setGenerating(true); setError(''); setRoutingNotice(''); let chatId = selectedId; let accepted = false;
    const abort = new AbortController(); controller.current = abort;
    try {
      if (!chatId) { const result = await post<{ chat: Chat }>('/chats', { modelId }); chatId = result.chat.id; setSelectedId(chatId); setChats(current => [result.chat, ...current]); }
      runningId.current = chatId;
      const body = mode === 'regenerate' ? { modelId } : { content, modelId, attachmentIds: attachments.map(a => a.id), ...(messageId ? { messageId } : {}) };
      await stream(`/chats/${chatId}/${mode}`, body, abort.signal, (event, data) => {
        if (event === 'meta') {
          accepted = true;
          if (data.chat) setChats(current => [data.chat!, ...current.filter(c => c.id !== data.chat!.id)]);
          setMessages(current => {
            let previous = current;
            if (mode === 'edit') { const index = current.findIndex(m => m.id === messageId); previous = index >= 0 ? current.slice(0, index) : current; }
            if (mode === 'regenerate' && previous.at(-1)?.role === 'assistant') previous = previous.slice(0, -1);
            if (data.userMessage && !previous.some(m => m.id === data.userMessage!.id)) previous = [...previous, data.userMessage];
            return data.assistantMessage ? [...previous, data.assistantMessage] : previous;
          });
        }
        if (event === 'delta') setMessages(current => current.map((message, index) => index === current.length - 1 && message.role === 'assistant' ? { ...message, content: message.content + (data.text || '') } : message));
        if (event === 'routing' && typeof data.message === 'string') setRoutingNotice(data.message);
        if (event === 'delta') setRoutingNotice('');
        if (event === 'done' && data.message && typeof data.message !== 'string') { const message = data.message; setMessages(current => current.map(m => m.id === message.id ? message : m)); }
        if (event === 'error') { setError(data.error || '模型返回错误。'); if (data.message && typeof data.message !== 'string') { const message = data.message; setMessages(current => current.map(m => m.id === message.id ? message : m)); } }
      });
      return accepted;
    } catch (err) { if (!abort.signal.aborted) setError(errorText(err)); return accepted; }
    finally {
      controller.current = null; runningId.current = null;
      if (chatId) {
        try { const result = await api<{ chat: Chat; messages: Message[] }>(`/chats/${chatId}`); setMessages(result.messages.map(message => abort.signal.aborted && message.status === 'streaming' ? { ...message, status: 'stopped' } : message)); } catch { setMessages(current => current.map(message => message.status === 'streaming' ? { ...message, status: abort.signal.aborted ? 'stopped' : 'error' } : message)); }
      }
      refreshChats().catch(() => {});
      busy.current = false; setGenerating(false); setRoutingNotice('');
    }
  }
  async function stop() { const id = runningId.current; controller.current?.abort(); if (id) { try { await post(`/chats/${id}/stop`); } catch (err) { setError(errorText(err)); } } }
  return { chats, messages, models, modelId, setModelId, settings, selectedId, loading, chatLoading, generating, routingNotice, error, setError, openChat, newChat, updateChat, deleteChat, generate, stop, refreshModels };
}
