// server.js — Express + Stripe Checkout + Webhook + Email (Resend API first, SMTP fallback)
// ESM build. Requires package.json { "type": "module" }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';

// ---- Safety: crash visibly if we miss async errors ----
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

// ---------- Helpers (metadata chunking <500 chars/field) ----------
function encodeCfgForMeta(obj) {
  try { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); } catch { return ''; }
}
function splitMeta(key, value, chunkSize = 480) {
  const meta = {};
  if (!value) return meta;
  if (value.length <= 500) { meta[key] = value; return meta; }
  const parts = Math.ceil(value.length / chunkSize);
  meta[`${key}_parts`] = String(parts);
  for (let i = 0; i < parts; i++) meta[`${key}_${i + 1}`] = value.slice(i * chunkSize, (i + 1) * chunkSize);
  return meta;
}
function reassembleCfgFromMeta(md) {
  if (!md) return null;
  if (md.cfg) {
    try { return JSON.parse(Buffer.from(md.cfg, 'base64').toString('utf8')); } catch { return null; }
  }
  const parts = Number(md.cfg_parts || 0);
  if (!parts) return null;
  let joined = '';
  for (let i = 1; i <= parts; i++) joined += md[`cfg_${i}`] || '';
  try { return JSON.parse(Buffer.from(joined, 'base64').toString('utf8')); } catch { return null; }
}

// ---------- Env ----------
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.rockcreekgranite.com';
const RAW_ALLOWED = (process.env.ALLOWED_ORIGINS || `${FRONTEND_URL},${FRONTEND_URL.replace('www.', '')}`).split(',');
const ALLOWED_ORIGINS = RAW_ALLOWED.map(s => s.trim()).filter(Boolean);

const FROM_EMAIL = process.env.SMTP_FROM || process.env.BUSINESS_EMAIL || 'orders@rockcreekgranite.com';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Rock Creek Granite';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

// ---------- Mailer: Resend API first, SMTP fallback ----------
function makeMailer() {
  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    console.log(`[MAIL] Mode: resend-api  From: ${FROM_EMAIL}  As: ${FROM_NAME}`);
    return {
      async send({ to, subject, text, bcc, attachments }) {
        // Resend accepts Buffer for attachments content
        await resend.emails.send({
          from: `${FROM_NAME} <${FROM_EMAIL}>`,
          to, bcc, subject, text,
          attachments: attachments?.map(a => ({ filename: a.filename, content: a.content }))
        });
      }
    };
  }

  // SMTP fallback (useful locally; Render often blocks SMTP egress)
  const SMTP_HOST = process.env.SMTP_HOST;
  const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
  const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || SMTP_PORT === 465;
  const SMTP_USER = process.env.SMTP_USER;
  const SMTP_PASSWORD = process.env.SMTP_PASSWORD || process.env.SMTP_PASS;

  if (SMTP_HOST && SMTP_USER && SMTP_PASSWORD) {
    const transporter = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_SECURE, auth: { user: SMTP_USER, pass: SMTP_PASSWORD } });
    console.log(`[MAIL] Mode: smtp:${SMTP_HOST}:${SMTP_PORT}  From: ${FROM_EMAIL}  As: ${FROM_NAME}`);
    return {
      async send({ to, subject, text, bcc, attachments }) {
        await transporter.sendMail({ from: FROM_NAME ? `"${FROM_NAME}" <${FROM_EMAIL}>` : FROM_EMAIL, to, bcc, subject, text, attachments });
      }
    };
  }

  console.warn('[MAIL] No email provider configured');
  return { async send() { console.warn('[MAIL] send() called but mailer not configured'); } };
}
const mailer = makeMailer();

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
console.log('[BOOT] FRONTEND_URL:', FRONTEND_URL);
console.log('[BOOT] Allowed origins:', ALLOWED_ORIGINS.join(', '));

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
        console.log('[stripe] checkout.session.completed', {
          id: session.id,
          email: session.customer_details?.email,
          amount_total: session.amount_total,
          cfg_summary: cfg ? { shape: cfg.shape, zip: cfg.zip } : null,
        });

        // Send internal order notification
        const notifyTo = process.env.ORDER_NOTIFY_EMAIL || FROM_EMAIL;
        const totalUSD = (Number(session.amount_total || 0) / 100).toFixed(2);
        const sumLines = [
          `Stripe Session: ${session.id}`,
          `Customer: ${session.customer_details?.email || 'N/A'}`,
          `Total: $${totalUSD} ${String(session.currency || 'usd').toUpperCase()}`,
          cfg ? `ZIP: ${cfg.zip}` : '',
          cfg ? `Shape: ${cfg.shape}` : '',
          cfg ? `Dims: ${JSON.stringify(cfg.dims)}` : '',
          cfg ? `Sinks: ${cfg.sinks?.length || 0}` : '',
          cfg ? `Edges: ${cfg.edges?.join(', ') || 'None'}` : '',
          cfg ? `Backsplash: ${cfg.backsplash ? 'Yes' : 'No'}` : ''
        ].filter(Boolean).join('\n');

        try {
          await mailer.send({ to: notifyTo, subject: `${process.env.NODE_ENV === 'production' ? '' : '[TEST] '}New RCG order ${session.id}`, text: sumLines });
          console.log('[MAIL] order notification sent ->', notifyTo);
        } catch (e) {
          console.error('[MAIL] order notification failed:', e);
        }

        // Send customer confirmation
        const custEmail = session.customer_details?.email;
        if (custEmail) {
          const conf = [
            'Thanks for your order with Rock Creek Granite!\n',
            'We\'ve received your payment and are preparing your cut sheet.\n',
            `Order: ${session.id}`,
            `Total: $${totalUSD}`,
            cfg ? `Shape: ${cfg.shape}` : '',
            cfg ? `Dims: ${JSON.stringify(cfg.dims)}` : ''
          ].filter(Boolean).join('\n');
          try {
            await mailer.send({ to: custEmail, subject: 'Your Rock Creek Granite order', text: conf });
            console.log('[MAIL] customer confirmation sent ->', custEmail);
          } catch (e) {
            console.error('[MAIL] customer confirmation failed:', e);
          }
        }
        break;
      }
      default: {
        // other events can be ignored or logged
        if (process.env.NODE_ENV !== 'production') console.log(`[stripe] ${event.type}`);
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.sendStatus(500);
  }

  res.json({ received: true });
});

// ---------- CORS + JSON (after webhook) ----------
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server
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
    case 'polygon': { const n = +d.n || 6; const s = +d.A || 12; const in2 = (n * s * s) / (4 * Math.tan(Math.PI / n)); return in2 / 144; }
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
  const L = +cfg.dims?.L || 0; const W = +cfg.dims?.W || 0; const edges = Array.isArray(cfg.edges) ? cfg.edges : [];
  const unpol = ['top', 'right', 'bottom', 'left'].filter(k => !edges.includes(k));
  const lenMap = { top: L, bottom: L, left: W, right: W };
  const in2 = unpol.reduce((sum, k) => sum + (lenMap[k] || 0) * 4, 0);
  return in2 / 144;
}
function taxRateByZip(zip) {
  if (!/\d{5}/.test(String(zip || ''))) return 0.07;
  if (/^63/.test(zip)) return 0.0825;
  if (/^62/.test(zip)) return 0.0875;
  return 0.07;
}
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

// ---------- Create Checkout Session ----------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { config, email } = req.body || {};
    if (!config) return res.status(400).json({ error: 'Missing config' });

    const p = computePricing(config);
    const line_items = [
      {
        price_data: {
          currency: 'usd',
          product_data: { name: 'Custom Porcelain Countertop', description: 'Material, fabrication, sinks, backsplash (if selected), packaging & LTL shipping' },
          unit_amount: Math.max(0, Math.round(p.services * 100)),
        },
        quantity: 1,
      },
    ];
    if (p.tax > 0) {
      line_items.push({
        price_data: { currency: 'usd', product_data: { name: 'Sales Tax' }, unit_amount: Math.max(0, Math.round(p.tax * 100)) },
        quantity: 1,
      });
    }

    // compact config for metadata (no pricing)
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
    const meta = { zip: String(config.zip || ''), ...splitMeta('cfg', cfgB64) };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: `${FRONTEND_URL}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/configurator?canceled=1`,
      customer_email: email || undefined,
      metadata: meta,
      shipping_address_collection: { allowed_countries: ['US'] },
    });

    res.json({ id: session.id, url: session.url });
  } catch (e) {
    console.error('create-checkout-session failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Thank-you page helper ----------
app.get('/api/checkout-session', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    const session = await stripe.checkout.sessions.retrieve(id, { expand: ['line_items', 'payment_intent', 'customer'] });
    return res.json({ ok: true, session });
  } catch (e) {
    console.error('GET /api/checkout-session failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Email DXF (HTTPS mailer) ----------
app.post('/api/email-dxf', async (req, res) => {
  try {
    const { to, bcc, subject, config, dxfBase64 } = req.body || {};
    if (!to || !dxfBase64) return res.status(400).json({ error: 'Missing to or dxfBase64' });
    const buf = Buffer.from(dxfBase64, 'base64');

    const summary = `Shape: ${config?.shape}\n` +
      `Size: ${JSON.stringify(config?.dims)}\n` +
      `Polished: ${Array.isArray(config?.edges) ? config.edges.join(', ') : 'None'}\n` +
      `Backsplash: ${config?.backsplash ? 'Yes' : 'No'}\n` +
      `Sinks: ${(config?.sinks || []).length}`;

    await mailer.send({
      to,
      bcc,
      subject: subject || 'RCG DXF',
      text: `Attached is your DXF cut sheet.\n\n${summary}`,
      attachments: [{ filename: 'RCG_CutSheet.dxf', content: buf }],
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('email-dxf failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- Health ----------
app.get('/', (_req, res) => res.type('text/plain').send('ok'));
app.get('/.well-known/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
