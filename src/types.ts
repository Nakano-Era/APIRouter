export interface User { id: string; name: string; email: string; role: 'admin' | 'user'; createdAt: string; disabled?: boolean; dailyLimit?: number }
export interface Session { user: User | null; needsSetup: boolean; csrfToken?: string }
export type ChatMode = 'chat' | 'work';
export interface Model { id: string; modelId: string; name: string; vision: boolean; modes: ChatMode[]; reasoningEfforts: string[]; contextWindow?: number | null; maxOutputTokens?: number | null }
export interface AdminModel extends Model { providerId: string; enabled: boolean; providerName?: string; status: 'untested' | 'ok' | 'error'; lastCheckedAt?: string | null; error?: string | null; available?: boolean; routeKey?: string; channelCount?: number; failureCount?: number; cooldownUntil?: string | null }
export interface Chat { id: string; title: string; modelId: string; createdAt: string; updatedAt: string; pinned: boolean; archived: boolean; mode: ChatMode; effort: string; skillIds: string[]; webSearch: boolean }
export interface Attachment { id: string; name: string; mime: string; size: number; kind: 'image' | 'text'; url: string }
export interface Message { id: string; role: 'user' | 'assistant'; content: string; modelId?: string; createdAt: string; status: 'complete' | 'streaming' | 'error' | 'stopped'; attachments: Attachment[]; error?: string | null; canContinue?: boolean }
export interface Provider { responsesProfile?: 'auto' | 'standard' | 'codex'; runtime?: 'api' | 'claude-code'; id: string; name: string; baseUrl: string; protocol: 'openai-chat' | 'openai-responses' | 'anthropic'; enabled: boolean; hasKey: boolean; keyHint: string; lastSyncedAt: string | null; lastSyncError: string | null; createdAt: string; priority?: number; failureThreshold?: number; cooldownSeconds?: number; authMode?: 'auto' | 'bearer' | 'x-api-key' }
export interface Settings { siteName: string; systemPrompt?: string; defaultModelId: string | null; dailyLimit: number; maxOutputTokens: number; routingMaxAttempts?: number; retriesPerChannel?: number }
export interface Invite { id: string; email?: string; expiresAt: string; usedAt: string | null; createdAt: string }
export interface WorkSkill { id: string; name: string; description?: string }
export interface WorkCapabilities { available: boolean; reason?: string; skills: WorkSkill[]; webSearchSupported?: boolean }
export interface WorkArtifact { id: string; name: string; size: number; downloadUrl: string; mime?: string; createdAt?: string }
export interface StreamEvent { userMessage?: Message; assistantMessage?: Message; chat?: Chat; text?: string; message?: Message | string; error?: string; label?: string; artifact?: WorkArtifact }
export interface RawDiagnostic { status?: number; method?: string; url?: string; protocol?: string; modelId?: string; headers?: Record<string, string>; body?: string; truncated?: boolean; readNote?: string; [key: string]: unknown }
export interface RoutingAttempt { id: string; requestId: string; providerName: string; modelId: string; outcome: string; error?: string | null; createdAt: string; hasDetail?: boolean }
