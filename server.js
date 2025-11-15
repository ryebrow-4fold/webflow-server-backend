// server.js — Express + Stripe Checkout + Webhook + Email DXF (ESM)
// Requires package.json: { "type": "module" }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

// --- Mail config & helper (force Resend API if key is present) ---
const MAIL_FROM = process.env.SMTP_FROM || process.env.BUSINESS_EMAIL || 'orders@rockcreekgranite.com';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Rock Creek Granite';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

const MAIL_MODE = RESEND_API_KEY ? 'resend-api' : 'none';
console.log('[MAIL] Mode:', MAIL_MODE, ' From:', MAIL_FROM, ' As:', MAIL_FROM_NAME);

/**
 * sendEmail({ to, bcc, subject, text, attachments? })
 * attachments: [{ filename, content (base64) }]
 */
async function sendEmail({ to, bcc, subject, text, attachments = [] }) {
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY missing; cannot send email via Resend');
  }

  // Resend HTTP API — no SMTP ports involved
  const body = {
    from: `${MAIL_FROM_NAME} <${MAIL_FROM}>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    text,
  };

  if (bcc) body.bcc = Array.isArray(bcc) ? bcc : [bcc];
  if (attachments?.length) {
    // Resend expects base64 content
    body.attachments = attachments.map(a => ({
      filename: a.filename,
      content: a.content, // base64 string
    }));
  }

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errTxt = await resp.text().catch(() => '');
    throw new Error(`Resend API failed: ${resp.status} ${resp.statusText} ${errTxt}`);
  }
  const json = await resp.json();
  return json; // { id: '...' }
}

// ------------------------- BOOT LOGS -------------------------
console.log('[BOOT] FRONTEND_URL:', process.env.FRONTEND_URL || '(unset)');
console.log(
  '[BOOT] Allowed origins:',
  (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_URL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .join(', ')
);

// ------------------------- APP & BASIC CONFIG -------------------------
const app = express();
app.set('trust proxy', true);

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.rockcreekgranite.com';
const DEFAULT_ALLOWED = [FRONTEND_URL, FRONTEND_URL.replace('www.', '')];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : DEFAULT_ALLOWED
).map(s => s.trim()).filter(Boolean);

// --- Lightweight request log for health pings (helps confirm Render is hitting us)
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/healthz' || req.path === '/.well-known/health') {
    console.log('[HEALTH]', req.method, req.path);
  }
  next();
});

// --- Health endpoints: unprotected, super fast, always 200
app.get('/healthz', (_req, res) => {
  res.type('text/plain').send('ok'); // Render can use this path
});

app.get('/.well-known/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Keep root simple too — also returns 200 quickly
app.get('/', (_req, res) => {
  res.type('text/plain').send('ok');
});

// --- Diagnostics (optional; handy during setup)
app.get('/__diag', (_req, res) => {
  res.json({
    node: process.version,
    port: process.env.PORT,
    env: process.env.NODE_ENV,
    frontend_url: process.env.FRONTEND_URL,
    mail_mode: process.env.RESEND_API_KEY ? 'resend-api'
              : (process.env.SMTP_HOST ? `smtp:${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 'default'}` : 'none'),
    allowed_origins: (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    now: new Date().toISOString(),
  });
});

// ------------------------- HEALTH & DIAG (place RIGHT AFTER app) -------------------------
app.get('/.well-known/health', (_req, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
});

app.get('/__diag', (_req, res) => {
  const mailMode = process.env.RESEND_API_KEY
    ? 'resend-smtp'
    : (process.env.SMTP_HOST
        ? `smtp:${process.env.SMTP_HOST}:${process.env.SMTP_PORT || '(default)'}`
        : 'none');

  res.json({
    ok: true,
    node: process.versions.node,
    env: process.env.NODE_ENV || 'unset',
    port: process.env.PORT || '(unset)',
    frontend_url: process.env.FRONTEND_URL || '(unset)',
    allowed_origins: ALLOWED_ORIGINS,
    mail_mode: mailMode,
  });
});

app.get('/__diag', (req, res) => {
  res.json({
    mail_mode: MAIL_MODE,
    from: MAIL_FROM,
    from_name: MAIL_FROM_NAME,
    has_resend_key: !!RESEND_API_KEY,
  });
});

// ------------------------- MAILER -------------------------
function createTransporter() {
  // Prefer Resend via SMTP if RESEND_API_KEY is present (no extra deps needed)
  if (process.env.RESEND_API_KEY) {
    const transporter = nodemailer.createTransport({
      host: 'smtp.resend.com',
      port: 465,        // use 465 to avoid any fallback to localhost:587
      secure: true,
      auth: { user: 'resend', pass: process.env.RESEND_API_KEY },
    });
    console.log(
      `[MAIL] Mode: resend-smtp  From: ${process.env.SMTP_FROM || process.env.BUSINESS_EMAIL || '(unset)'}  As: ${process.env.MAIL_FROM_NAME || '(unset)'}`
    );
    // Fire and forget verify (no top-level await)
    (async () => {
      try { await transporter.verify(); }
      catch (e) { console.warn('[MAIL] SMTP verify failed:', e.message); }
    })();
    return transporter;
  }

  // Fallback: custom SMTP (e.g., Gmail SMTP with App Password)
  if (process.env.SMTP_HOST) {
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || port === 465;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: (process.env.SMTP_USER && process.env.SMTP_PASSWORD)
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    });
    console.log(
      `[MAIL] Mode: smtp:${process.env.SMTP_HOST}:${port}  From: ${process.env.SMTP_FROM || process.env.BUSINESS_EMAIL || '(unset)'}  As: ${process.env.MAIL_FROM_NAME || '(unset)'}`
    );
    (async () => {
      try { await transporter.verify(); }
      catch (e) { console.warn('[MAIL] SMTP verify failed:', e.message); }
    })();
    return transporter;
  }

  console.warn('[MAIL] No email provider configured');
  return null;
}

const mailer = createTransporter();

// ------------------------- STRIPE -------------------------
if (!process.env.STRIPE_SECRET_KEY) console.warn('[WARN] STRIPE_SECRET_KEY not set');
if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('[WARN] STRIPE_WEBHOOK_SECRET not set');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2024-06-20',
});

// ------------------------- HELPERS (metadata + pricing) -------------------------
function encodeCfgForMeta(obj) {
  try {
    const json = JSON.stringify(obj);
    return Buffer.from(json, 'utf8').toString('base64'); // compact base64
  } catch { return ''; }
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
    case 'circle':    { const D = +d.D || 0; return (Math.PI * Math.pow(D / 2, 2)) / 144; }
    case 'polygon':   { const n = +d.n || 6, s = +d.A || 12; const areaIn2 = (n * s * s) / (4 * Math.tan(Math.PI / n)); return areaIn2 / 144; }
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
  const unpol = ['top','right','bottom','left'].filter(k => !edges.includes(k));
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

// ------------------------- STRIPE WEBHOOK (BEFORE express.json) -------------------------
app.post(
  '/api/checkout-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('Webhook verify failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
  const session = event.data.object;

  // (optional) Re-assemble config from metadata if you use splitMeta earlier
  const meta = session.metadata || {};
  let cfg = null;
  try {
    if (meta.cfg) {
      cfg = JSON.parse(Buffer.from(meta.cfg, 'base64').toString('utf8'));
    } else if (meta.cfg_parts) {
      let joined = '';
      const parts = Number(meta.cfg_parts || 0);
      for (let i = 1; i <= parts; i++) joined += meta[`cfg_${i}`] || '';
      cfg = JSON.parse(Buffer.from(joined, 'base64').toString('utf8'));
    }
  } catch { /* ignore */ }

  const customerEmail = session.customer_details?.email || session.customer_email || null;
  const totalUSD = (session.amount_total / 100).toFixed(2);
  const currency = String(session.currency || 'usd').toUpperCase();

  const summaryLines = [
    `Thanks for your order!`,
    ``,
    `Order ID: ${session.id}`,
    `Total: $${totalUSD} ${currency}`,
    `ZIP: ${cfg?.zip || meta.zip || 'N/A'}`,
    `Shape: ${cfg?.shape || 'N/A'}`,
    `Dims: ${cfg?.dims ? JSON.stringify(cfg.dims) : 'N/A'}`,
    `Sinks: ${cfg?.sinks?.length || 0}`,
    `Edges: ${cfg?.edges?.join(', ') || 'None'}`,
    `Backsplash: ${cfg?.backsplash ? 'Yes' : 'No'}`,
  ].join('\n');

  // 1) Customer confirmation (if we have an email)
  if (customerEmail) {
    try {
      await sendEmail({
        to: customerEmail,
        subject: 'Rock Creek Granite — Order Confirmation',
        text: summaryLines,
      });
      console.log('[MAIL] customer confirmation sent to', customerEmail);
    } catch (e) {
      console.error('[MAIL] customer confirmation failed:', e);
    }
  }

  // 2) Internal order notification
  const shopInbox = process.env.ORDER_NOTIFY_EMAIL || 'orders@rockcreekgranite.com';
  try {
    await sendEmail({
      to: shopInbox,
      subject: `New RCG order ${session.id}`,
      text: summaryLines,
    });
    console.log('[MAIL] internal order sent to', shopInbox);
  } catch (e) {
    console.error('[MAIL] internal order failed:', e);
  }

  break;
}
        default:
          // keep logs in non-prod for visibility
          if (process.env.NODE_ENV !== 'production') console.log(`[stripe] ${event.type}`);
      }
    } catch (e) {
      console.error('Webhook handler error:', e);
      return res.sendStatus(500);
    }
    res.json({ received: true });
  }
);

// ------------------------- CORS + JSON (AFTER webhook) -------------------------
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server
    const ok = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

// ------------------------- API: email-dxf -------------------------
app.post('/api/email-dxf', async (req, res) => {
  try {
    const { to, bcc, subject, config, dxfBase64 } = req.body || {};
    if (!to || !dxfBase64) {
      return res.status(400).json({ error: 'Missing to or dxfBase64' });
    }

    const summary = [
      `Shape: ${config?.shape || 'N/A'}`,
      `Size: ${config?.dims ? JSON.stringify(config.dims) : 'N/A'}`,
      `Polished: ${Array.isArray(config?.edges) ? config.edges.join(', ') : 'None'}`,
      `Backsplash: ${config?.backsplash ? 'Yes' : 'No'}`,
      `Sinks: ${(config?.sinks || []).length}`,
    ].join('\n');

    await sendEmail({
      to,
      bcc,
      subject: subject || 'RCG DXF',
      text: `Attached is your DXF cut sheet.\n\n${summary}`,
      attachments: [{ filename: 'RCG_CutSheet.dxf', content: dxfBase64 }], // base64
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('email-dxf failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ------------------------- API: create checkout session -------------------------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { config, email } = req.body || {};
    if (!config) return res.status(400).json({ error: 'Missing config' });

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

    // Compact config for metadata (no pricing fields)
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

// ------------------------- ROOTS -------------------------
app.get('/', (_req, res) => res.type('text/plain').send('ok'));

// ------------------------- START -------------------------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
