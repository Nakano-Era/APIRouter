export interface User { id: string; name: string; email: string; role: 'admin' | 'user'; createdAt: string; disabled?: boolean; dailyLimit?: number }
export interface Session { user: User | null; needsSetup: boolean; csrfToken?: string }
export interface Model { id: string; providerId: string; modelId: string; name: string; enabled: boolean; vision: boolean; providerName?: string; status: 'untested' | 'ok' | 'error'; lastCheckedAt?: string | null; error?: string | null; available?: boolean; routeKey?: string; channelCount?: number; failureCount?: number; cooldownUntil?: string | null }
export interface Chat { id: string; title: string; modelId: string; createdAt: string; updatedAt: string; pinned: boolean; archived: boolean }
export interface Attachment { id: string; name: string; mime: string; size: number; kind: 'image' | 'text'; url: string }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; modelId?: string; createdAt: string; status: 'complete' | 'streaming' | 'error' | 'stopped'; attachments: Attachment[]; error?: string | null; sourceProvider?: string | null; sourceModel?: string | null }
export interface Provider { id: string; name: string; baseUrl: string; protocol: 'openai-chat' | 'openai-responses' | 'anthropic'; enabled: boolean; hasKey: boolean; keyHint: string; lastSyncedAt: string | null; lastSyncError: string | null; createdAt: string; priority?: number; failureThreshold?: number; cooldownSeconds?: number; authMode?: 'auto' | 'bearer' | 'x-api-key' }
export interface Settings { siteName: string; systemPrompt?: string; defaultModelId: string | null; dailyLimit: number; maxOutputTokens: number; routingMaxAttempts?: number; retriesPerChannel?: number }
export interface Invite { id: string; email?: string; expiresAt: string; usedAt: string | null; createdAt: string }
export interface StreamEvent { userMessage?: Message; assistantMessage?: Message; chat?: Chat; text?: string; message?: Message | string; error?: string }
export interface RoutingAttempt { id: string; requestId: string; providerName: string; modelId: string; outcome: string; error?: string | null; createdAt: string }
