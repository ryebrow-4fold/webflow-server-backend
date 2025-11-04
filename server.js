// server.js — Express + Stripe Checkout + Webhook + Email DXF/Test (ESM)
// package.json must include: { "type": "module" }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

// ---------- Crash guards (keep first) ----------
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

// ---------- Helpers: metadata chunking (stay small for Stripe limits) ----------
function encodeCfgForMeta(obj) {
  try {
    const json = JSON.stringify(obj);
    return Buffer.from(json, 'utf8').toString('base64'); // compact base64
  } catch {
    return '';
  }
}
function splitMeta(key, value, chunkSize = 480) {
  const meta = {};
  if (!value) return meta;
  if (value.length <= 500) {
    meta[key] = value;
    return meta;
  }
  const parts = Math.ceil(value.length / chunkSize);
  meta[`${key}_parts`] = String(parts);
  for (let i = 0; i < parts; i++) {
    meta[`${key}_${i + 1}`] = value.slice(i * chunkSize, (i + 1) * chunkSize);
  }
  return meta;
}
function reassembleCfgFromMeta(md) {
  if (!md) return null;
  if (md.cfg) {
    try { return JSON.parse(Buffer.from(md.cfg, 'base64').toString('utf8')); }
    catch { return null; }
  }
  const parts = Number(md.cfg_parts || 0);
  if (!parts) return null;
  let joined = '';
  for (let i = 1; i <= parts; i++) joined += md[`cfg_${i}`] || '';
  try { return JSON.parse(Buffer.from(joined, 'base64').toString('utf8')); }
  catch { return null; }
}
const money = (cents) => `$${(Math.max(0, +cents) / 100).toFixed(2)}`;

// ---------- Env & App ----------
const PORT = Number(process.env.PORT || 3000);
const DEFAULT_FRONTEND = 'https://www.rockcreekgranite.com';
const FRONTEND_URL = process.env.FRONTEND_URL || DEFAULT_FRONTEND;

// Allow both www and non-www by default if ALLOWED_ORIGINS not set
const DEFAULT_ALLOWED = [FRONTEND_URL, FRONTEND_URL.replace('://www.', '://')];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : DEFAULT_ALLOWED
).map(s => s.trim()).filter(Boolean);

if (!process.env.STRIPE_SECRET_KEY) console.warn('[WARN] STRIPE_SECRET_KEY not set');
if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('[WARN] STRIPE_WEBHOOK_SECRET not set');
if (!process.env.SMTP_HOST && !process.env.RESEND_API_KEY) {
  console.warn('[WARN] No SMTP creds or RESEND_API_KEY set — email will fail.');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });
const app = express();
app.set('trust proxy', true);

// Boot logs
console.log('[BOOT] FRONTEND_URL:', FRONTEND_URL);
console.log('[BOOT] Allowed origins:', ALLOWED_ORIGINS.join(', ') || '(none)');

// Mail mode log
const mailMode = process.env.RESEND_API_KEY
  ? 'resend-smtp'
  : (process.env.SMTP_HOST ? `smtp:${process.env.SMTP_HOST}:${process.env.SMTP_PORT || ''}` : 'none');
console.log(`[MAIL] Mode: ${mailMode}  From: ${process.env.SMTP_FROM || '(unset)'}  As: ${process.env.MAIL_FROM_NAME || '(no name)'}`);

// ---------- Stripe Webhook (MUST be before express.json) ----------
app.post('/api/checkout-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, secret);
  } catch (err) {
    console.error('Webhook verify failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const cfg = reassembleCfgFromMeta(session.metadata);
        const customerEmail = session.customer_details?.email || session.customer_email || '';

        console.log('[stripe] checkout.session.completed', {
          id: session.id,
          email: customerEmail || '(none)',
          amount_total: session.amount_total,
          cfg_summary: cfg ? { shape: cfg.shape, zip: cfg.zip } : null,
        });

        // --- Prepare emails
        const transporter = createTransporter();
        const from = process.env.MAIL_FROM_NAME
          ? `"${process.env.MAIL_FROM_NAME}" <${process.env.SMTP_FROM || 'no-reply@rockcreekgranite.com'}>`
          : (process.env.SMTP_FROM || 'no-reply@rockcreekgranite.com');

        const orderTo = process.env.ORDER_NOTIFY_EMAIL || process.env.BUSINESS_EMAIL || process.env.SMTP_FROM;
        const orderSubject = `${process.env.NODE_ENV === 'production' ? '' : '[TEST] '}New RCG order ${session.id}`;
        const orderText = [
          `Stripe Session: ${session.id}`,
          `Total: ${money(session.amount_total)} ${String(session.currency || 'usd').toUpperCase()}`,
          `Customer: ${customerEmail || 'N/A'}`,
          `ZIP: ${cfg?.zip || session.metadata?.zip || 'N/A'}`,
          `Shape: ${cfg?.shape || 'N/A'}`,
          `Dims: ${cfg?.dims ? JSON.stringify(cfg.dims) : 'N/A'}`,
          `Sinks: ${cfg?.sinks?.length ?? 0}`,
          `Edges: ${cfg?.edges?.join(', ') || 'None'}`,
          `Backsplash: ${cfg?.backsplash ? 'Yes' : 'No'}`,
        ].join('\n');

        const customerSubject = 'Rock Creek Granite — Order received';
        const customerText = [
          `Thank you for your order!`,
          ``,
          `Order: ${session.id}`,
          `Amount: ${money(session.amount_total)} ${String(session.currency || 'usd').toUpperCase()}`,
          `We’ll review your configuration and follow up with shipping details.`,
          ``,
          `If you have questions, reply to this email.`,
        ].join('\n');

        // Send emails (don't fail the webhook if mail fails)
        const sendOps = [];
        if (orderTo) {
          sendOps.push(
            transporter.sendMail({ from, to: orderTo, subject: orderSubject, text: orderText })
              .then(info => console.log('[mail] order ->', orderTo, info.messageId))
              .catch(e => console.error('[mail] order FAILED:', e.message))
          );
        }
        if (customerEmail) {
          sendOps.push(
            transporter.sendMail({ from, to: customerEmail, subject: customerSubject, text: customerText })
              .then(info => console.log('[mail] customer ->', customerEmail, info.messageId))
              .catch(e => console.error('[mail] customer FAILED:', e.message))
          );
        }
        await Promise.allSettled(sendOps);
        break;
      }

      default:
        if (process.env.NODE_ENV !== 'production') console.log(`[stripe] ${event.type}`);
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    // still 200 to avoid Stripe retry storms if the bug is ours; but you can 500 while debugging
  }

  res.json({ received: true });
});

// ---------- CORS + JSON (after webhook) ----------
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server or curl
    const ok = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

// ---------- Pricing (mirrors client) ----------
const DOLLARS_PER_SQFT = 55;
const LBS_PER_SQFT = 10.9;
const LTL_CWT_BASE = 35.9;
const DISTANCE_BANDS = [
  { max: 250,  mult: 1.0 },
  { max: 600,  mult: 1.25 },
  { max: 1000, mult: 1.5 },
  { max: 1500, mult: 1.7 },
  { max: Infinity, mult: 1.85 },
];
const SINK_PRICES = { 'bath-oval': 80, 'bath-rect': 95, 'kitchen-rect': 150 };

function areaSqft(shape, d) {
  if (!shape || !d) return 0;
  switch (shape) {
    case 'rectangle': return ((+d.L || 0) * (+d.W || 0)) / 144;
    case 'circle':    return (Math.PI * Math.pow((+d.D || 0) / 2, 2)) / 144;
    case 'polygon': {
      const n = +d.n || 6;
      const s = +d.A || 12;
      const areaIn2 = (n * s * s) / (4 * Math.tan(Math.PI / n));
      return areaIn2 / 144;
    }
    default: return 0;
  }
}
function distanceBand(originZip, destZip) {
  const o = parseInt(String(originZip || '63052').slice(0, 3), 10);
  const d = parseInt(String(destZip || '00000').slice(0, 3), 10);
  const approxMiles = Math.abs(o - d) * 20 + 100;
  return DISTANCE_BANDS.find(b => approxMiles <= b.max).mult;
}
function shippingEstimate(area, destZip, originZip = '63052') {
  const weight = area * LBS_PER_SQFT;
  const cwt = Math.max(1, Math.ceil(weight / 100));
  const mult = distanceBand(originZip, destZip);
  const base = cwt * LTL_CWT_BASE * mult;
  return { weight, cwt, mult, ltl: base * 1.2 };
}
function backsplashSqft(cfg) {
  if (!cfg || cfg.shape !== 'rectangle' || !cfg.backsplash) return 0;
  const L = +cfg.dims?.L || 0;
  const W = +cfg.dims?.W || 0;
  const edges = Array.isArray(cfg.edges) ? cfg.edges : [];
  const unpol = ['top', 'right', 'bottom', 'left'].filter(k => !edges.includes(k));
  const lenMap = { top: L, bottom: L, left: W, right: W };
  const areaIn2 = unpol.reduce((sum, k) => sum + (lenMap[k] || 0) * 4, 0);
  return areaIn2 / 144;
}
function taxRateByZip(zip) {
  if (!/^\d{5}$/.test(zip || '')) return 0.07;
  if (/^63/.test(zip)) return 0.0825;
  if (/^62/.test(zip)) return 0.0875;
  return 0.07;
}
function computePricing(cfg) {
  const area = areaSqft(cfg?.shape, cfg?.dims);
  const material = area * DOLLARS_PER_SQFT;
  const sinks = cfg?.shape === 'rectangle'
    ? (cfg?.sinks || []).reduce((acc, s) => acc + (SINK_PRICES[s.key] || 0), 0)
    : 0;
  const bpsf = backsplashSqft(cfg) * DOLLARS_PER_SQFT;
  const ship = shippingEstimate(area + backsplashSqft(cfg), cfg?.zip || '');
  const taxRate = taxRateByZip(cfg?.zip);
  const services = material + sinks + bpsf + ship.ltl;
  const tax = services * taxRate;
  const total = services + tax;
  return { area, material, sinks, backsplash: bpsf, ship, taxRate, tax, total, services };
}

// ---------- Mail transporter ----------
function createTransporter() {
  // Resend (optional)
  if (process.env.RESEND_API_KEY) {
    return nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 587,
      secure: false,
      auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
    });
  }

  // Gmail / generic SMTP
  const SMTP_HOST = process.env.SMTP_HOST;                 // e.g., smtp.gmail.com
  const SMTP_PORT = Number(process.env.SMTP_PORT || 587);  // 587 = STARTTLS, 465 = SSL
  const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true'
                      || SMTP_PORT === 465;
  const SMTP_USER = process.env.SMTP_USER;                 // full Gmail address
  const SMTP_PASS = process.env.SMTP_PASS || process.env.SMTP_PASSWORD; // accept either name

  if (!SMTP_HOST) console.warn('[WARN] SMTP_HOST not set; email will fail.');
  if (SMTP_USER && !SMTP_PASS) console.warn('[WARN] SMTP_USER set but SMTP_PASS/SMTP_PASSWORD missing.');

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
}

// ---------- API: Create Stripe Checkout Session ----------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { config, email } = req.body || {};
    if (!config) return res.status(400).json({ error: 'Missing config' });

    // Compute server-authoritative pricing
    const p = computePricing(config);

    const line_items = [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Custom Porcelain Countertop',
            description: 'Material, fabrication, sinks, backsplash (if selected), packaging & LTL shipping',
          },
          unit_amount: Math.max(0, Math.round(p.services * 100)),
        },
        quantity: 1,
      },
    ];
    if (p.tax > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Sales Tax' },
          unit_amount: Math.max(0, Math.round(p.tax * 100)),
        },
        quantity: 1,
      });
    }

    // Compact config for metadata (no pricing)
    const compactCfg = {
      shape: config.shape,
      dims: config.dims,
      sinks: Array.isArray(config.sinks)
        ? config.sinks.map(s => ({
            key: s.key,
            x: Number(s.x?.toFixed?.(2) ?? s.x),
            y: Number(s.y?.toFixed?.(2) ?? s.y),
            faucet: s.faucet ?? '1',
            spread: s.spread ?? null,
          }))
        : [],
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

// ---------- API: Thank-you page can pull session details ----------
app.get('/api/checkout-session', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    const session = await stripe.checkout.sessions.retrieve(id, {
      expand: ['line_items', 'payment_intent', 'customer'],
    });
    res.json({ ok: true, session });
  } catch (e) {
    console.error('GET /api/checkout-session failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- API: Test outbound email ----------
app.post('/api/test-email', async (req, res) => {
  try {
    const to = req.body?.to || process.env.ORDER_NOTIFY_EMAIL || process.env.SMTP_USER;
    if (!to) return res.status(400).json({ ok: false, error: 'No recipient set' });

    const transporter = createTransporter();
    const from = process.env.MAIL_FROM_NAME
      ? `"${process.env.MAIL_FROM_NAME}" <${process.env.SMTP_FROM || 'no-reply@rockcreekgranite.com'}>`
      : (process.env.SMTP_FROM || 'no-reply@rockcreekgranite.com');

    const info = await transporter.sendMail({
      from,
      to,
      subject: 'RCG mail transport test',
      text: 'If you received this, outbound email is working from the server.',
    });

    console.log('[mail] test sent:', info.messageId);
    res.json({ ok: true });
  } catch (e) {
    console.error('[mail] test failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Health ----------
app.get('/', (_req, res) => res.type('text/plain').send('ok'));
app.get('/.well-known/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});