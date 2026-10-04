import express from 'express';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';
import { id } from './store.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const currencies = new Set(['USD', 'CNY', 'EUR', 'HKD']);
const terminalSubscriptions = new Set(['canceled', 'incomplete_expired']);
const objectId = value => typeof value === 'string' ? value : value?.id;
const parse = value => JSON.parse(value);
function text(value, label, max, optional = false) {
  if (typeof value !== 'string' || value.length > max || (!optional && !value.trim())) throw fail(400, `${label}格式不正确，最多 ${max} 个字符。`);
  return value.trim();
}
function integer(value, label, min, max) { if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `${label}需要是 ${min}–${max} 之间的整数。`); return value; }
function boolean(value, label) { if (typeof value !== 'boolean') throw fail(400, `${label}必须是布尔值。`); return value; }

// Calendar periods are UTC and clamp to the last day (Jan 31 + one month = Feb 28/29).
export function addBillingPeriod(value, interval) {
  const date = new Date(value), day = date.getUTCDate();
  if (!Number.isFinite(date.getTime()) || !['month', 'year'].includes(interval)) throw new Error('Invalid billing period');
  date.setUTCDate(1);
  if (interval === 'month') date.setUTCMonth(date.getUTCMonth() + 1);
  else date.setUTCFullYear(date.getUTCFullYear() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}

export function createBilling({ store, publicOrigin, stripeFactory = key => new Stripe(key, { maxNetworkRetries: 1, timeout: 15_000 }), clock = Date.now } = {}) {
  const iso = () => new Date(clock()).toISOString();
  const timestamp = () => Math.floor(clock() / 1000);
  const checkoutBusy = new Set();
  const manualRequestBusy = new Set();
  const queues = new Map();
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS billing_config (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, encrypted_secret TEXT, secret_hint TEXT, encrypted_webhook TEXT, webhook_hint TEXT, free_routes TEXT NOT NULL DEFAULT '[]');
    INSERT OR IGNORE INTO billing_config(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS billing_plans (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_memberships (user_id TEXT PRIMARY KEY REFERENCES users(id), plan_id TEXT NOT NULL, plan_snapshot TEXT NOT NULL, active_until TEXT NOT NULL, source TEXT NOT NULL, stripe_subscription_id TEXT, status TEXT NOT NULL DEFAULT 'active', cancel_at_period_end INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS billing_requests (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan_id TEXT NOT NULL, plan_snapshot TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', review_note TEXT, reviewer_id TEXT REFERENCES users(id), created_at TEXT NOT NULL, reviewed_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_one_pending ON billing_requests(user_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS billing_checkouts (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), plan_id TEXT NOT NULL, plan_snapshot TEXT NOT NULL, session_id TEXT UNIQUE, subscription_id TEXT UNIQUE, customer_id TEXT, url TEXT, status TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, request_origin TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_billing_checkouts_user ON billing_checkouts(user_id,created_at);
    CREATE TABLE IF NOT EXISTS billing_subscriptions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), checkout_id TEXT NOT NULL REFERENCES billing_checkouts(id), customer_id TEXT NOT NULL, status TEXT NOT NULL, period_end TEXT, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_user ON billing_subscriptions(user_id);
    CREATE TABLE IF NOT EXISTS billing_customers (user_id TEXT PRIMARY KEY REFERENCES users(id), customer_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, processed_at TEXT NOT NULL);
  `);
  if (!store.all('PRAGMA table_info(billing_config)').some(column => column.name === 'free_routes')) store.db.exec("ALTER TABLE billing_config ADD COLUMN free_routes TEXT NOT NULL DEFAULT '[]'");
  const config = () => store.get('SELECT * FROM billing_config WHERE id=1');
  const planJSON = row => row ? { ...parse(row.data), id: row.id, createdAt: row.created_at, updatedAt: row.updated_at } : null;
  const plans = () => store.all('SELECT * FROM billing_plans').map(planJSON).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  const getPlan = planId => planJSON(store.get('SELECT * FROM billing_plans WHERE id=?', planId));
  const requestJSON = row => ({ id: row.id, userId: row.user_id, userName: row.user_name, userEmail: row.user_email, planId: row.plan_id, planName: parse(row.plan_snapshot).name, plan: parse(row.plan_snapshot), note: row.note, status: row.status, reviewNote: row.review_note, createdAt: row.created_at, reviewedAt: row.reviewed_at });
  const memberRow = userId => store.get('SELECT * FROM billing_memberships WHERE user_id=? AND active_until>?', userId, iso());
  const pending = userId => store.get("SELECT id FROM billing_requests WHERE user_id=? AND status='pending'", userId);
  const canRequestManual = user => user.role !== 'admin' || store.get("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND disabled=0").count > 1;
  const openCheckout = userId => store.get("SELECT * FROM billing_checkouts WHERE user_id=? AND status IN ('creating','open','complete') ORDER BY created_at DESC LIMIT 1", userId);
  const ongoingStripe = userId => store.all('SELECT * FROM billing_subscriptions WHERE user_id=?', userId).find(row => !terminalSubscriptions.has(row.status));
  function memberJSON(row) {
    if (!row) return null;
    const plan = parse(row.plan_snapshot);
    return { planId: row.plan_id, planName: plan.name, activeUntil: row.active_until, source: row.source, status: row.status, cancelAtPeriodEnd: !!row.cancel_at_period_end, dailyLimit: plan.dailyLimit, allowedRoutes: plan.allowedRoutes };
  }
  function effectiveEntitlement(userId) {
    const user = store.get('SELECT daily_limit FROM users WHERE id=?', userId);
    const member = memberJSON(memberRow(userId));
    return { planId: member?.planId || 'free', planName: member?.planName || '免费版', dailyLimit: user?.daily_limit ?? member?.dailyLimit ?? store.settings().dailyLimit, allowedRoutes: member?.allowedRoutes || parse(config().free_routes), activeUntil: member?.activeUntil || null, source: member?.source || 'free' };
  }
  function originFor(req) {
    const candidate = publicOrigin || process.env.PUBLIC_ORIGIN;
    let url;
    try { url = new URL(candidate || `${req.protocol}://${req.get('host')}`); } catch { throw fail(400, '请先配置有效的 PUBLIC_ORIGIN。'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || (!candidate && !local)) throw fail(400, 'Stripe 支付需要将 PUBLIC_ORIGIN 配置为本站 HTTPS 地址。');
    return url.origin;
  }
  function settingsJSON(req) {
    const row = config();
    let webhookUrl = null;
    try { webhookUrl = `${originFor(req)}/api/billing/webhook`; } catch { /* Manual billing works without a public domain. */ }
    return { stripeEnabled: !!row.enabled, hasSecretKey: !!row.encrypted_secret, secretKeyHint: row.secret_hint || null, hasWebhookSecret: !!row.encrypted_webhook, webhookSecretHint: row.webhook_hint || null, webhookUrl, freeAllowedRoutes: parse(row.free_routes) };
  }
  function stripeClient(requireEnabled = false) {
    const row = config();
    if (!row.encrypted_secret || !row.encrypted_webhook || (requireEnabled && !row.enabled)) throw fail(503, 'Stripe 支付尚未开通，请选择申请开通或联系管理员。');
    return stripeFactory(store.decrypt(row.encrypted_secret));
  }
  function validatePlan(input, existing) {
    const data = { name: '', description: '', priceCents: 0, currency: 'USD', interval: 'month', dailyLimit: 100, allowedRoutes: [], active: true, allowStripe: false, allowManual: true, sortOrder: 0, ...existing, ...input };
    const allowedRoutes = data.allowedRoutes;
    if (!Array.isArray(allowedRoutes) || allowedRoutes.length > 100 || allowedRoutes.some(route => typeof route !== 'string' || !route.trim() || route.length > 300)) throw fail(400, '模型范围应为最多 100 个模型分组名称。');
    if (!currencies.has(data.currency) || !['month', 'year'].includes(data.interval)) throw fail(400, '币种或计费周期不支持。');
    const value = { name: text(data.name, '套餐名称', 60), description: text(data.description, '套餐说明', 1000, true), priceCents: integer(data.priceCents, '价格（分）', 1, 99_999_999), currency: data.currency, interval: data.interval, dailyLimit: integer(data.dailyLimit, '每日次数', 0, 100_000), allowedRoutes: [...new Set(allowedRoutes.map(route => route.trim()))], active: boolean(data.active, '上架状态'), allowStripe: boolean(data.allowStripe, 'Stripe 支付'), allowManual: boolean(data.allowManual, '申请开通'), sortOrder: integer(data.sortOrder, '排序', -10_000, 10_000) };
    if (value.active && !value.allowStripe && !value.allowManual) throw fail(400, '上架套餐至少需要一种开通方式。');
    return value;
  }
  function requirePurchasable(planId, method) {
    const plan = typeof planId === 'string' && getPlan(planId);
    if (!plan?.active || !plan[method]) throw fail(400, '此套餐暂不支持所选开通方式。');
    return plan;
  }
  function saveMembership(userId, plan, activeUntil, source, subscription = null) {
    store.run(`INSERT INTO billing_memberships(user_id,plan_id,plan_snapshot,active_until,source,stripe_subscription_id,status,cancel_at_period_end,updated_at) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET plan_id=excluded.plan_id,plan_snapshot=excluded.plan_snapshot,active_until=excluded.active_until,source=excluded.source,stripe_subscription_id=excluded.stripe_subscription_id,status=excluded.status,cancel_at_period_end=excluded.cancel_at_period_end,updated_at=excluded.updated_at`, userId, plan.id, JSON.stringify(plan), activeUntil, source, subscription?.id || null, subscription?.status || 'active', subscription?.cancel_at_period_end ? 1 : 0, iso());
  }
  async function serial(key, fn) {
    const previous = queues.get(key) || Promise.resolve();
    const promise = previous.catch(() => {}).then(fn);
    queues.set(key, promise);
    try { return await promise; } finally { if (queues.get(key) === promise) queues.delete(key); }
  }
  function officialUrl(value, host) {
    try { const url = new URL(value); if (url.protocol === 'https:' && url.hostname === host && !url.username && !url.password) return url.href; } catch { /* Reject malformed provider redirects. */ }
    throw fail(502, 'Stripe 返回了无效的支付地址，请联系管理员。');
  }
  async function safeStripe(fn) {
    try { return await fn(); } catch (error) { if (error.status && !error.type?.startsWith('Stripe')) throw error; throw fail(502, 'Stripe 暂时无法处理此操作，请稍后再试或联系管理员检查支付配置。'); }
  }
  function checkoutParams(record, user) {
    const plan = parse(record.plan_snapshot);
    const customer = store.get('SELECT customer_id FROM billing_customers WHERE user_id=?', user.id);
    const metadata = { checkoutId: record.id, userId: user.id, planId: plan.id };
    return { mode: 'subscription', client_reference_id: user.id, ...(customer ? { customer: customer.customer_id } : { customer_email: user.email }), metadata, subscription_data: { metadata }, line_items: [{ quantity: 1, price_data: { currency: plan.currency.toLowerCase(), unit_amount: plan.priceCents, recurring: { interval: plan.interval }, product_data: { name: plan.name, ...(plan.description ? { description: plan.description } : {}) } } }], success_url: `${record.request_origin}/?billing=success`, cancel_url: `${record.request_origin}/?billing=cancelled`, expires_at: Math.floor(new Date(record.expires_at).getTime() / 1000) };
  }
  async function createCheckout(user, planId, req) {
    const plan = requirePurchasable(planId, 'allowStripe');
    const client = stripeClient(true), origin = originFor(req);
    if (checkoutBusy.has(user.id)) throw fail(409, '正在创建支付页面，请稍后再试。');
    checkoutBusy.add(user.id);
    try {
      if (ongoingStripe(user.id) || memberRow(user.id)) throw fail(409, '已有有效会员或 Stripe 订阅。请先管理当前订阅，或到期后再购买。');
      if (pending(user.id)) throw fail(409, '已有开通申请正在审核，请等待处理后再支付。');
      let record = openCheckout(user.id);
      if (record?.status === 'complete') throw fail(409, '付款结果正在确认，请稍后刷新会员状态。');
      if (record?.session_id) {
        const current = await safeStripe(() => client.checkout.sessions.retrieve(record.session_id));
        if (current.status === 'complete') { store.run("UPDATE billing_checkouts SET status='complete' WHERE id=?", record.id); throw fail(409, '付款结果正在确认，请稍后刷新会员状态。'); }
        if (current.status === 'open') {
          if (record.plan_id !== plan.id) throw fail(409, '已有其他套餐的支付页面，请完成或等待其过期后再选择。');
          return { url: officialUrl(current.url || record.url, 'checkout.stripe.com') };
        }
        store.run("UPDATE billing_checkouts SET status='expired' WHERE id=?", record.id); record = null;
      }
      if (record && record.plan_id !== plan.id) throw fail(409, '已有其他套餐的支付订单正在确认，请稍后重试。');
      if (record && new Date(record.created_at).getTime() < clock() - 23 * 60 * 60_000) throw fail(409, '历史支付订单状态不明确，请联系管理员核对 Stripe 订单后处理。');
      if (!record) {
        record = { id: id(), user_id: user.id, plan_id: plan.id, plan_snapshot: JSON.stringify(plan), status: 'creating', expires_at: new Date(clock() + 31 * 60_000).toISOString(), created_at: iso(), request_origin: origin };
        store.run('INSERT INTO billing_checkouts(id,user_id,plan_id,plan_snapshot,status,expires_at,created_at,request_origin) VALUES(?,?,?,?,?,?,?,?)', record.id, record.user_id, record.plan_id, record.plan_snapshot, record.status, record.expires_at, record.created_at, record.request_origin);
      }
      // Persist before making the network call. An ambiguous timeout reuses this idempotency key.
      const session = await safeStripe(() => client.checkout.sessions.create(checkoutParams(record, user), { idempotencyKey: `apirouter-checkout-${record.id}` }));
      const url = officialUrl(session.url, 'checkout.stripe.com');
      store.run("UPDATE billing_checkouts SET session_id=?,url=?,status='open' WHERE id=?", session.id, url, record.id);
      return { url };
    } finally { checkoutBusy.delete(user.id); }
  }
  function validMetadata(value, record) { return value?.checkoutId === record.id && value?.userId === record.user_id && value?.planId === record.plan_id; }
  async function synchronizeSubscription(client, subscriptionId, sessionHint) {
    // Fetch current state rather than trusting event order or an old event's snapshot.
    const subscription = await safeStripe(() => client.subscriptions.retrieve(subscriptionId, { expand: ['latest_invoice'] }));
    const existing = store.get('SELECT * FROM billing_subscriptions WHERE id=?', subscriptionId);
    const record = existing ? store.get('SELECT * FROM billing_checkouts WHERE id=?', existing.checkout_id) : store.get('SELECT * FROM billing_checkouts WHERE id=?', subscription.metadata?.checkoutId || '');
    if (!record) return;
    if (!record.session_id) throw fail(503, '订单仍在创建，稍后重试。');
    const session = sessionHint?.id === record.session_id ? sessionHint : await safeStripe(() => client.checkout.sessions.retrieve(record.session_id));
    if (session.mode !== 'subscription' || session.client_reference_id !== record.user_id || !validMetadata(session.metadata, record) || !validMetadata(subscription.metadata, record) || objectId(session.subscription) !== subscriptionId || (record.subscription_id && record.subscription_id !== subscriptionId) || objectId(session.customer) !== objectId(subscription.customer)) throw fail(400, '支付订单关联校验失败。');
    if (session.status !== 'complete') return;
    const customerId = objectId(subscription.customer);
    if (!customerId) throw fail(400, '支付账户信息不完整。');
    const knownCustomer = store.get('SELECT customer_id FROM billing_customers WHERE user_id=?', record.user_id);
    if (knownCustomer && knownCustomer.customer_id !== customerId) throw fail(400, '支付账户关联不一致。');
    const plan = parse(record.plan_snapshot), items = subscription.items?.data || [], item = items[0];
    const compatible = items.length === 1 && item.quantity === 1 && item.price?.unit_amount === plan.priceCents && item.price?.currency === plan.currency.toLowerCase() && item.price?.recurring?.interval === plan.interval && (item.price.recurring.interval_count ?? 1) === 1;
    const endSeconds = item?.current_period_end ?? subscription.current_period_end;
    const periodEnd = Number.isFinite(endSeconds) && endSeconds > 0 ? new Date(endSeconds * 1000).toISOString() : null;
    const invoicePaid = subscription.latest_invoice?.status === 'paid' || subscription.latest_invoice?.paid === true;
    const confirmed = ['paid', 'no_payment_required'].includes(session.payment_status) && (subscription.status === 'trialing' || (subscription.status === 'active' && invoicePaid));
    store.transaction(() => {
      store.run("UPDATE billing_checkouts SET subscription_id=?,customer_id=?,status='fulfilled' WHERE id=?", subscriptionId, customerId, record.id);
      store.run('INSERT INTO billing_customers(user_id,customer_id) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING', record.user_id, customerId);
      store.run(`INSERT INTO billing_subscriptions(id,user_id,checkout_id,customer_id,status,period_end,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,period_end=excluded.period_end,updated_at=excluded.updated_at`, subscriptionId, record.user_id, record.id, customerId, subscription.status, periodEnd, iso());
      const member = store.get('SELECT * FROM billing_memberships WHERE user_id=?', record.user_id);
      // Old subscriptions must never overwrite a newer manual or Stripe membership.
      const canOwn = !member || member.stripe_subscription_id === subscriptionId || (member.active_until <= iso() && member.updated_at <= record.created_at);
      if (confirmed && compatible && periodEnd > iso() && canOwn) saveMembership(record.user_id, plan, periodEnd, 'stripe', subscription);
      else if (member?.stripe_subscription_id === subscriptionId) {
        // A cancellation or failed renewal cannot extend access, but a paid period is retained.
        store.run('UPDATE billing_memberships SET status=?,cancel_at_period_end=?,updated_at=? WHERE user_id=?', compatible ? subscription.status : 'plan_changed', subscription.cancel_at_period_end ? 1 : 0, iso(), record.user_id);
      }
    });
  }
  async function processEvent(event, client) {
    if (store.get('SELECT id FROM billing_events WHERE id=?', event.id)) return;
    if (event.account) throw fail(400, '此站点不接受 Stripe Connect 事件。');
    const object = event.data?.object;
    let subscriptionId, session;
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      const record = store.get('SELECT * FROM billing_checkouts WHERE session_id=?', object?.id || '');
      if (!record) {
        if (object?.metadata?.checkoutId && store.get('SELECT id FROM billing_checkouts WHERE id=?', object.metadata.checkoutId)) throw fail(503, '订单仍在创建，稍后重试。');
      } else {
        session = await safeStripe(() => client.checkout.sessions.retrieve(record.session_id));
        subscriptionId = objectId(session.subscription);
      }
    } else if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) subscriptionId = object?.id;
    else if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) subscriptionId = objectId(object?.parent?.subscription_details?.subscription || object?.subscription);
    if (subscriptionId) await synchronizeSubscription(client, subscriptionId, session);
    store.run('INSERT OR IGNORE INTO billing_events(id,type,processed_at) VALUES(?,?,?)', event.id, event.type, iso());
  }
  function mountWebhook(app) {
    app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
      const row = config();
      if (!row.encrypted_webhook || !row.encrypted_secret) throw fail(503, '支付通知尚未配置。');
      if (!Buffer.isBuffer(req.body) || typeof req.get('stripe-signature') !== 'string') throw fail(400, '支付通知签名无效。');
      const client = stripeClient();
      let event;
      try { event = client.webhooks.constructEvent(req.body, req.get('stripe-signature'), store.decrypt(row.encrypted_webhook)); } catch { throw fail(400, '支付通知签名无效。'); }
      if (typeof event.id !== 'string' || typeof event.type !== 'string') throw fail(400, '支付通知格式无效。');
      const liveMode = /^(sk|rk)_live_/.test(store.decrypt(row.encrypted_secret));
      if (typeof event.livemode !== 'boolean' || event.livemode !== liveMode) throw fail(400, '支付通知环境与本站 Stripe 配置不一致。');
      // One serialized queue avoids old network reads winning races with newer events.
      await serial('webhooks', () => processEvent(event, client));
      res.json({ received: true });
    });
  }
  function registerRoutes(app, { auth, admin, csrf }) {
    const userRoutes = express.Router(), adminRoutes = express.Router();
    const limiter = rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: '会员操作过于频繁，请稍后再试。' } });
    userRoutes.get('/', (req, res) => {
      const row = config(), availablePlans = plans().filter(plan => plan.active);
      res.json({ plans: availablePlans, freePlan: { id: 'free', name: '免费版', dailyLimit: req.user.daily_limit ?? store.settings().dailyLimit, allowedRoutes: parse(row.free_routes) }, membership: memberJSON(memberRow(req.user.id)), requests: store.all('SELECT * FROM billing_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 50', req.user.id).map(requestJSON), paymentMethods: { stripe: !!(row.enabled && row.encrypted_secret && row.encrypted_webhook), manual: availablePlans.some(plan => plan.allowManual) }, canRequestManual: canRequestManual(req.user), canManageSubscription: !!(row.encrypted_secret && store.get('SELECT user_id FROM billing_customers WHERE user_id=?', req.user.id)), effectiveDailyLimit: effectiveEntitlement(req.user.id).dailyLimit });
    });
    userRoutes.post('/requests', limiter, async (req, res) => {
      if (!canRequestManual(req.user)) throw fail(409, '唯一管理员无需申请会员，可配置自身额度；会员申请需要其他管理员审批。');
      const plan = requirePurchasable(req.body.planId, 'allowManual');
      const note = text(req.body.note ?? '', '申请说明', 1000, true), requestId = id();
      manualRequestBusy.add(requestId);
      try {
      const checkout = openCheckout(req.user.id);
      if (checkout?.status === 'open' && checkout.expires_at <= iso()) {
        const current = await safeStripe(() => stripeClient().checkout.sessions.retrieve(checkout.session_id));
        if (current.status === 'expired') store.run("UPDATE billing_checkouts SET status='expired' WHERE id=? AND status='open'", checkout.id);
      }
      store.transaction(() => {
        if (!canRequestManual(req.user)) throw fail(409, '唯一管理员无需申请会员，可配置自身额度；会员申请需要其他管理员审批。');
        if (pending(req.user.id)) throw fail(409, '已有申请正在审核，请等待管理员处理。');
        if (ongoingStripe(req.user.id) || memberRow(req.user.id)?.source === 'stripe') throw fail(409, '请先在订阅管理中取消 Stripe 订阅，并等待当前会员到期。');
        if (openCheckout(req.user.id) || checkoutBusy.has(req.user.id)) throw fail(409, '已有支付订单待完成，请等待订单过期后再申请。');
        store.run('INSERT INTO billing_requests(id,user_id,plan_id,plan_snapshot,note,created_at) VALUES(?,?,?,?,?,?)', requestId, req.user.id, plan.id, JSON.stringify(plan), note, iso());
      });
      res.status(201).json({ request: requestJSON(store.get('SELECT * FROM billing_requests WHERE id=?', requestId)) });
      } finally { manualRequestBusy.delete(requestId); }
    });
    userRoutes.post('/checkout', limiter, async (req, res) => res.json(await createCheckout(req.user, req.body.planId, req)));
    userRoutes.post('/portal', limiter, async (req, res) => {
      const client = stripeClient(), customer = store.get('SELECT customer_id FROM billing_customers WHERE user_id=?', req.user.id);
      if (!customer) throw fail(400, '尚无可管理的 Stripe 订阅。');
      const result = await safeStripe(() => client.billingPortal.sessions.create({ customer: customer.customer_id, return_url: `${originFor(req)}/?billing=return` }));
      res.json({ url: officialUrl(result.url, 'billing.stripe.com') });
    });
    adminRoutes.get('/plans', (_req, res) => res.json({ plans: plans() }));
    adminRoutes.post('/plans', (req, res) => {
      const data = validatePlan(req.body), planId = id(), time = iso();
      store.run('INSERT INTO billing_plans(id,data,created_at,updated_at) VALUES(?,?,?,?)', planId, JSON.stringify(data), time, time);
      res.status(201).json({ plan: getPlan(planId) });
    });
    adminRoutes.patch('/plans/:id', (req, res) => {
      const plan = getPlan(req.params.id); if (!plan) throw fail(404, '套餐不存在。');
      const data = validatePlan(req.body, plan);
      store.run('UPDATE billing_plans SET data=?,updated_at=? WHERE id=?', JSON.stringify(data), iso(), plan.id);
      res.json({ plan: getPlan(plan.id) });
    });
    adminRoutes.get('/billing/requests', (_req, res) => res.json({ requests: store.all('SELECT r.*,u.name AS user_name,u.email AS user_email FROM billing_requests r JOIN users u ON u.id=r.user_id ORDER BY CASE WHEN r.status=\'pending\' THEN 0 ELSE 1 END,r.created_at DESC LIMIT 200').map(requestJSON) }));
    adminRoutes.post('/billing/requests/:id/review', (req, res) => {
      if (!['approve', 'reject'].includes(req.body.decision)) throw fail(400, '请选择同意或拒绝。');
      const note = text(req.body.note ?? '', '审核说明', 1000, true);
      store.transaction(() => {
        const request = store.get('SELECT * FROM billing_requests WHERE id=?', req.params.id);
        if (!request) throw fail(404, '申请不存在。');
        if (request.user_id === req.user.id) throw fail(403, '不能审核自己的申请，请由另一位管理员审核。');
        if (request.status !== 'pending') throw fail(409, '此申请已经审核，请刷新列表。');
        if (req.body.decision === 'approve') {
          const user = store.get('SELECT disabled FROM users WHERE id=?', request.user_id);
          if (!user || user.disabled) throw fail(400, '申请账号已停用。');
          if (ongoingStripe(request.user_id) || memberRow(request.user_id)?.source === 'stripe' || openCheckout(request.user_id)) throw fail(409, '此用户已有 Stripe 订阅或待付款订单。');
          const plan = parse(request.plan_snapshot), current = memberRow(request.user_id);
          const start = current?.source === 'manual' && current.plan_id === plan.id ? current.active_until : iso();
          saveMembership(request.user_id, plan, addBillingPeriod(start, plan.interval), 'manual');
        }
        store.run('UPDATE billing_requests SET status=?,review_note=?,reviewer_id=?,reviewed_at=? WHERE id=?', req.body.decision === 'approve' ? 'approved' : 'rejected', note, req.user.id, iso(), request.id);
      });
      res.json({ request: requestJSON(store.get('SELECT * FROM billing_requests WHERE id=?', req.params.id)) });
    });
    adminRoutes.get('/billing/settings', (req, res) => res.json(settingsJSON(req)));
    adminRoutes.patch('/billing/settings', (req, res) => {
      const row = config(), enabled = req.body.stripeEnabled === undefined ? !!row.enabled : boolean(req.body.stripeEnabled, 'Stripe 开关');
      const secret = req.body.secretKey === undefined || req.body.secretKey === '' ? null : text(req.body.secretKey, 'Stripe Secret Key', 256);
      const webhook = req.body.webhookSecret === undefined || req.body.webhookSecret === '' ? null : text(req.body.webhookSecret, 'Webhook Secret', 256);
      const routes = req.body.freeAllowedRoutes === undefined ? parse(row.free_routes) : req.body.freeAllowedRoutes;
      if (!Array.isArray(routes) || routes.length > 100 || routes.some(route => typeof route !== 'string' || !route.trim() || route.length > 300)) throw fail(400, '免费模型范围应为最多 100 个模型分组名称。');
      if (secret && !/^(sk|rk)_(test|live)_[a-zA-Z0-9]+$/.test(secret)) throw fail(400, '请输入有效的 Stripe Secret Key。');
      if (webhook && !/^whsec_[a-zA-Z0-9]+$/.test(webhook)) throw fail(400, '请输入有效的 Webhook Secret。');
      if (secret && row.encrypted_secret && secret.split('_')[1] !== store.decrypt(row.encrypted_secret).split('_')[1] && store.get('SELECT id FROM billing_checkouts LIMIT 1')) throw fail(409, '已有 Stripe 订单，不能在本站切换测试与正式模式。请使用独立测试站，正式部署保持同一 Stripe 账号。');
      if (enabled && !(secret || row.encrypted_secret) || enabled && !(webhook || row.encrypted_webhook)) throw fail(400, '启用 Stripe 前请同时配置 Secret Key 和 Webhook Secret。');
      if ((secret || webhook) && (checkoutBusy.size || queues.size)) throw fail(409, '支付操作正在处理中，请稍后修改密钥。');
      store.run('UPDATE billing_config SET enabled=?,encrypted_secret=?,secret_hint=?,encrypted_webhook=?,webhook_hint=?,free_routes=? WHERE id=1', enabled ? 1 : 0, secret ? store.encrypt(secret) : row.encrypted_secret, secret ? secret.slice(-4) : row.secret_hint, webhook ? store.encrypt(webhook) : row.encrypted_webhook, webhook ? webhook.slice(-4) : row.webhook_hint, JSON.stringify([...new Set(routes.map(route => route.trim()))]));
      res.json(settingsJSON(req));
    });
    app.use('/api/billing', auth, csrf, userRoutes);
    app.use('/api/admin', auth, csrf, admin, adminRoutes);
  }
  function ensureModelRenameIdle() {
    if (checkoutBusy.size || manualRequestBusy.size || queues.size) throw fail(409, '支付操作正在处理中，请稍后再修改模型名称。');
  }
  return { mountWebhook, registerRoutes, effectiveEntitlement, ensureModelRenameIdle };
}
