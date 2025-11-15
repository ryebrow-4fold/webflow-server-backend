// server.js — Express + Stripe Checkout + Webhook + Email (Resend HTTP or SMTP)
// ESM required: package.json => { "type": "module" }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

// ------------------ Helper: compact cfg in metadata ------------------
function encodeCfgForMeta(obj) {
  try { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); } catch { return ''; }
}
function splitMeta(key, value, chunkSize = 480) {
  const meta = {}; if (!value) return meta; if (value.length <= 500) { meta[key] = value; return meta; }
  const parts = Math.ceil(value.length / chunkSize); meta[`${key}_parts`] = String(parts);
  for (let i = 0; i < parts; i++) meta[`${key}_${i + 1}`] = value.slice(i * chunkSize, (i + 1) * chunkSize);
  return meta;
}
function reassembleCfgFromMeta(md) {
  if (!md) return null; if (md.cfg) { try { return JSON.parse(Buffer.from(md.cfg, 'base64').toString('utf8')); } catch { return null; } }
  const parts = Number(md.cfg_parts || 0); if (!parts) return null; let joined = '';
  for (let i = 1; i <= parts; i++) joined += md[`cfg_${i}`] || '';
  try { return JSON.parse(Buffer.from(joined, 'base64').toString('utf8')); } catch { return null; }
}

// ------------------ Env ------------------
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://www.rockcreekgranite.com').trim();
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || FRONTEND_URL)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// ------------------ Mail provider (Resend HTTP first, SMTP fallback) ------------------
const MAIL_FROM = (process.env.SMTP_FROM || process.env.BUSINESS_EMAIL || 'no-reply@rockcreekgranite.com').trim();
const MAIL_FROM_NAME = (process.env.MAIL_FROM_NAME || 'Rock Creek Granite').trim();
const ORDER_NOTIFY_EMAIL = (process.env.ORDER_NOTIFY_EMAIL || MAIL_FROM).trim();

function buildMail() {
  const resendKey = (process.env.RESEND_API_KEY || '').trim();
  if (resendKey) {
    console.log(`[MAIL] Mode: resend-api  From: ${MAIL_FROM}  As: ${MAIL_FROM_NAME}`);
    return {
      mode: 'resend-api',
      async send({ to, bcc, subject, text, attachments }) {
        const body = {
          from: `${MAIL_FROM_NAME} <${MAIL_FROM}>`,
          to: Array.isArray(to) ? to : [to],
          subject,
          text,
        };
        if (bcc) body.bcc = Array.isArray(bcc) ? bcc : [bcc];
        if (attachments?.length) {
          body.attachments = attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType }));
        }
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const j = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(`Resend ${resp.status}: ${JSON.stringify(j)}`);
        return j;
      }
    };
  }
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;
  if (host && user && pass) {
    const port = Number(process.env.SMTP_PORT || 465);
    const secure = String(process.env.SMTP_SECURE || 'true').toLowerCase() === 'true';
    console.log(`[MAIL] Mode: smtp:${host}:${port}  From: ${MAIL_FROM}  As: ${MAIL_FROM_NAME}`);
    const transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    transporter.verify().then(() => console.log('[MAIL] SMTP verify ok')).catch(e => console.warn('[MAIL] SMTP verify failed:', e.message));
    return {
      mode: 'smtp',
      async send({ to, bcc, subject, text, attachments }) {
        return transporter.sendMail({ from: `${MAIL_FROM_NAME} <${MAIL_FROM}>`, to, bcc, subject, text, attachments });
      }
    };
  }
  console.warn('[MAIL] No email provider configured');
  return { mode: 'none', async send() { throw new Error('Mail not configured'); } };
}
const MAIL = buildMail();

// ------------------ Stripe ------------------
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ------------------ Express ------------------
const app = express();
app.set('trust proxy', true);

// Webhook must use raw body and be registered BEFORE express.json()
app.post('/api/checkout-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook verify failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const cfg = reassembleCfgFromMeta(session.metadata);
        console.log('[stripe] checkout.session.completed', {
          id: session.id,
          email: session.customer_details?.email,
          amount_total: session.amount_total,
          cfg_summary: cfg ? { shape: cfg.shape, zip: cfg.zip } : null,
        });
        // Send emails (best-effort; don't block webhook)
        (async () => {
          try {
            const total = (session.amount_total / 100).toFixed(2);
            const cur = String(session.currency || 'usd').toUpperCase();
            const customerEmail = session.customer_details?.email;
            const summary = [
              `Stripe Session: ${session.id}`,
              `Customer: ${customerEmail || 'N/A'}`,
              `Total: $${total} ${cur}`,
              `ZIP: ${cfg?.zip || session.metadata?.zip || 'N/A'}`,
              `Shape: ${cfg?.shape || 'N/A'}`,
              `Dims: ${cfg?.dims ? JSON.stringify(cfg.dims) : 'N/A'}`,
              `Sinks: ${cfg?.sinks?.length || 0}`,
              `Edges: ${cfg?.edges?.join(', ') || 'None'}`,
              `Backsplash: ${cfg?.backsplash ? 'Yes' : 'No'}`,
            ].join('\n');

            // shop email
            try {
              const subject = `${process.env.NODE_ENV === 'production' ? '' : '[TEST] '}New RCG order ${session.id}`;
              const r1 = await MAIL.send({ to: ORDER_NOTIFY_EMAIL, subject, text: summary });
              console.log('[MAIL] order->ok', r1?.id || 'sent');
            } catch (e) { console.error('[MAIL] order->fail', e.message); }

            // customer email
            if (customerEmail) {
              try {
                const r2 = await MAIL.send({ to: customerEmail, subject: 'Order confirmed — Rock Creek Granite', text: `Thank you — your order has been received.\n\n${summary}` });
                console.log('[MAIL] customer->ok', r2?.id || 'sent');
              } catch (e) { console.error('[MAIL] customer->fail', e.message); }
            }
          } catch (e) {
            console.error('[MAIL] post-webhook error', e);
          }
        })();
        break;
      }
      default:
        if (process.env.NODE_ENV !== 'production') console.log(`[stripe] ${event.type}`);
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.sendStatus(500);
  }

  res.json({ received: true });
});

// CORS + JSON (after webhook route)
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server
    const ok = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

// ------------------ Pricing (mirror of client) ------------------
const DOLLARS_PER_SQFT = 55;
const LBS_PER_SQFT = 10.9;
const LTL_CWT_BASE = 35.9;
const DISTANCE_BANDS = [
  { max: 250, mult: 1.0 },
  { max: 600, mult: 1.25 },
  { max: 1000, mult: 1.5 },
  { max: 1500, mult: 1.7 },
  { max: Infinity, mult: 1.85 },
];
const SINK_PRICES = { 'bath-oval': 80, 'bath-rect': 95, 'kitchen-rect': 150 };
function areaSqft(shape, d) {
  if (!shape || !d) return 0;
  switch (shape) {
    case 'rectangle': return ((+d.L || 0) * (+d.W || 0)) / 144;
    case 'circle': { const D = +d.D || 0; return (Math.PI * Math.pow(D / 2, 2)) / 144; }
    case 'polygon': { const n = +d.n || 6; const s = +d.A || 12; const areaIn2 = (n * s * s) / (4 * Math.tan(Math.PI / n)); return areaIn2 / 144; }
    default: return 0;
  }
}
function distanceBand(originZip, destZip) { const o = parseInt(String(originZip || '63052').slice(0, 3), 10); const d = parseInt(String(destZip || '00000').slice(0, 3), 10); const approxMiles = Math.abs(o - d) * 20 + 100; return DISTANCE_BANDS.find(b => approxMiles <= b.max).mult; }
function shippingEstimate(area, destZip, originZip = '63052') {
  const weight = area * LBS_PER_SQFT; const cwt = Math.max(1, Math.ceil(weight / 100)); const mult = distanceBand(originZip, destZip); const base = cwt * LTL_CWT_BASE * mult; return { weight, cwt, mult, ltl: base * 1.2 };
}
function backsplashSqft(cfg) {
  if (!cfg || cfg.shape !== 'rectangle' || !cfg.backsplash) return 0; const L = +cfg.dims?.L || 0; const W = +cfg.dims?.W || 0; const edges = Array.isArray(cfg.edges) ? cfg.edges : []; const unpol = ['top', 'right', 'bottom', 'left'].filter(k => !edges.includes(k)); const lenMap = { top: L, bottom: L, left: W, right: W }; const areaIn2 = unpol.reduce((sum, k) => sum + (lenMap[k] || 0) * 4, 0); return areaIn2 / 144;
}
function taxRateByZip(zip) { if (!/\d{5}/.test(zip || '')) return 0.07; if (/^63/.test(zip)) return 0.0825; if (/^62/.test(zip)) return 0.0875; return 0.07; }
function computePricing(cfg) {
  const area = areaSqft(cfg?.shape, cfg?.dims);
  const material = area * DOLLARS_PER_SQFT;
  const sinks = cfg?.shape === 'rectangle' ? (cfg?.sinks || []).reduce((acc, s) => acc + (SINK_PRICES[s.key] || 0), 0) : 0;
  const bpsf = backsplashSqft(cfg) * DOLLARS_PER_SQFT;
  const ship = shippingEstimate(area + backsplashSqft(cfg), cfg?.zip || '');
  const taxRate = taxRateByZip(cfg?.zip);
  const services = material + sinks + bpsf + ship.ltl;
  const tax = services * taxRate;
  const total = services + tax;
  return { area, material, sinks, backsplash: bpsf, ship, taxRate, tax, total, services };
}

// ------------------ REST: Create Checkout Session ------------------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { config, email } = req.body || {};
    if (!config) return res.status(400).json({ error: 'Missing config' });

    const p = computePricing(config);
    const line_items = [
      { price_data: { currency: 'usd', product_data: { name: 'Custom Porcelain Countertop', description: 'Material, fabrication, sinks, backsplash (if selected), packaging & LTL shipping' }, unit_amount: Math.max(0, Math.round(p.services * 100)) }, quantity: 1 },
    ];
    if (p.tax > 0) {
      line_items.push({ price_data: { currency: 'usd', product_data: { name: 'Sales Tax' }, unit_amount: Math.max(0, Math.round(p.tax * 100)) }, quantity: 1 });
    }

    const compactCfg = {
      shape: config.shape,
      dims: config.dims,
      sinks: Array.isArray(config.sinks) ? config.sinks.map(s => ({ key: s.key, x: Number(s.x?.toFixed?.(2) ?? s.x), y: Number(s.y?.toFixed?.(2) ?? s.y), faucet: s.faucet ?? '1', spread: s.spread ?? null })) : [],
      color: config.color,
      edges: Array.isArray(config.edges) ? config.edges : [],
      backsplash: !!config.backsplash,
      zip: String(config.zip || ''),
    };
    const cfgB64 = encodeCfgForMeta(compactCfg);
    const metadata = { zip: String(config.zip || ''), ...splitMeta('cfg', cfgB64) };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: `${FRONTEND_URL}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/configurator?canceled=1`,
      customer_email: email || undefined,
      metadata,
      shipping_address_collection: { allowed_countries: ['US'] },
    });

    res.json({ id: session.id, url: session.url });
  } catch (e) {
    console.error('create-checkout-session failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Read a Checkout Session so the thank-you page can show details
app.get('/api/checkout-session', async (req, res) => {
  try {
    const id = req.query.id; if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    const session = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items', 'payment_intent', 'customer'] });
    return res.json({ ok: true, session });
  } catch (e) {
    console.error('GET /api/checkout-session failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ------------------ REST: Email DXF ------------------
app.post('/api/email-dxf', async (req, res) => {
  try {
    const { to, bcc, subject, config, dxfBase64 } = req.body || {};
    if (!to || !dxfBase64) return res.status(400).json({ error: 'Missing to or dxfBase64' });
    const summary = `Shape: ${config?.shape}\nSize: ${JSON.stringify(config?.dims)}\nPolished: ${Array.isArray(config?.edges) ? config.edges.join(', ') : 'None'}\nBacksplash: ${config?.backsplash ? 'Yes' : 'No'}\nSinks: ${(config?.sinks || []).length}`;
    const attach = [{ filename: 'RCG_CutSheet.dxf', content: dxfBase64, contentType: 'application/dxf' }];
    const r = await MAIL.send({ to, bcc, subject: subject || 'RCG DXF', text: `Attached is your DXF cut sheet.\n\n${summary}`, attachments: attach });
    res.json({ ok: true, result: r });
  } catch (e) {
    console.error('email-dxf failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------ Diagnostics & Health ------------------
app.get('/.well-known/mail-debug', (_req, res) => {
  res.json({
    mode: MAIL.mode,
    from: MAIL_FROM,
    fromName: MAIL_FROM_NAME,
    hasResendKey: !!process.env.RESEND_API_KEY,
    smtp: {
      host: process.env.SMTP_HOST || null,
      port: process.env.SMTP_PORT || null,
      secure: process.env.SMTP_SECURE || null,
      hasUser: !!process.env.SMTP_USER,
      hasPass: !!(process.env.SMTP_PASSWORD || process.env.SMTP_PASS),
    },
  });
});

app.get('/', (_req, res) => res.type('text/plain').send('ok'));
app.get('/.well-known/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ------------------ Start ------------------
app.listen(PORT, () => {
  console.log(`[BOOT] FRONTEND_URL: ${FRONTEND_URL}`);
  console.log(`[BOOT] Allowed origins: ${ALLOWED_ORIGINS.join(', ')}`);
  console.log(`Server listening on :${PORT}`);
});

