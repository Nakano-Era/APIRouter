import type { Message } from '../types';

// A continuation keeps its message ID. Delayed snapshots must not erase a suffix.
export function mergeMessage(current: Message | undefined, incoming: Message): Message {
  if (incoming.role !== 'assistant' || current?.role !== 'assistant') return incoming;
  return {
    ...incoming,
    content: current.content.length > incoming.content.length ? current.content : incoming.content,
    reasoning: (current.reasoning?.length || 0) > (incoming.reasoning?.length || 0) ? current.reasoning : incoming.reasoning,
  };
}
export function upsertMessage(messages: Message[], incoming: Message): Message[] {
  const index = messages.findIndex(message => message.id === incoming.id);
  return index < 0 ? [...messages, incoming] : messages.map((message, position) => position === index ? mergeMessage(message, incoming) : message);
}
export function mergeSnapshot(current: Message[], incoming: Message[]): Message[] {
  const existing = new Map(current.map(message => [message.id, message]));
  const merged = incoming.map(message => mergeMessage(existing.get(message.id), message));
  const tail = incoming.at(-1)?.id;
  const tailIndex = tail ? current.findIndex(message => message.id === tail) : -1;
  if (tailIndex >= 0) merged.push(...current.slice(tailIndex + 1).filter(message => !incoming.some(item => item.id === message.id)));
  return !incoming.length && current.length ? current : merged;
}
export function interrupted(messages: Message[]): Message[] {
  return messages.map(message => message.role === 'assistant' && message.status === 'streaming'
    ? { ...message, status: 'error', canContinue: true, error: '连接已中断，已收到的内容会保留。可继续生成。' } : message);
}
