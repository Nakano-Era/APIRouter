export type BillingCurrency = 'USD' | 'CNY' | 'EUR' | 'HKD';
export type BillingInterval = 'month' | 'year';

export interface BillingPlan {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  currency: BillingCurrency;
  interval: BillingInterval;
  dailyLimit: number;
  allowedRoutes: string[];
  allowStripe: boolean;
  allowManual: boolean;
  active: boolean;
  sortOrder: number;
}

export interface Membership {
  planId: string | null;
  planName: string;
  source: 'manual' | 'stripe' | 'admin';
  status: string;
  activeUntil: string | null;
  cancelAtPeriodEnd: boolean;
  dailyLimit: number;
  allowedRoutes: string[];
}

export interface BillingRequest {
  id: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  planId: string;
  planName: string;
  plan: BillingPlan;
  status: 'pending' | 'approved' | 'rejected';
  note: string;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface BillingData {
  plans: BillingPlan[];
  freePlan: { name: string; dailyLimit: number; allowedRoutes: string[] };
  membership: Membership | null;
  underlyingMembership: Membership | null;
  hasAdminOverride: boolean;
  hasStripeSubscription: boolean;
  requests: BillingRequest[];
  paymentMethods: { stripe: boolean; manual: boolean };
  canManageSubscription: boolean;
  canRequestManual: boolean;
  effectiveDailyLimit: number;
}

export interface AdminMembershipOverride extends Membership {
  reason: string;
  adminId: string;
  updatedAt: string;
}

export interface AdminMembershipData {
  effective: { planId: string; planName: string; dailyLimit: number; allowedRoutes: string[]; activeUntil: string | null; source: string };
  override: AdminMembershipOverride | null;
  underlyingMembership: Membership | null;
  hasStripeSubscription: boolean;
  plans: BillingPlan[];
  history: { id: string; action: 'set' | 'restore'; adminName: string; reason: string; createdAt: string; previous: AdminMembershipOverride | null; next: AdminMembershipOverride | null }[];
}

export interface BillingSettings {
  stripeEnabled: boolean;
  hasSecretKey: boolean;
  secretKeyHint: string | null;
  hasWebhookSecret: boolean;
  webhookSecretHint: string | null;
  webhookUrl: string | null;
  freeAllowedRoutes: string[];
}

export function formatPrice(priceCents: number, currency: string) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency, minimumFractionDigits: priceCents % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(priceCents / 100);
}

export function billingDate(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function intervalLabel(interval: BillingInterval) { return interval === 'year' ? '年' : '月'; }
