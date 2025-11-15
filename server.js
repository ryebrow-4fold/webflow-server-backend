// server.js — Express + Stripe Checkout + Webhook + Email DXF + Diagnostics (ESM)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

// -------------------- Utilities: encode compact config into Stripe metadata --------------------
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
    try { return JSON.parse(Buffer.from(md.cfg, 'base64').toString('utf8')); } catch { return null; }
  }
  const parts = Number(md.cfg_parts || 0);
  if (!parts) return null;
  let joined = '';
  for (let i = 1; i <= parts; i++) joined += md[`cfg_${i}`] || '';
  try { return JSON.parse(Buffer.from(joined, 'base64').toString('utf8')); } catch { return null; }
}

// -------------------- Env & constants --------------------
const PORT = process.env.PORT || 3000;
const DEFAULT_FRONTEND = 'https://www.rockcreekgranite.com';
const FRONTEND_URL = process.env.FRONTEND_URL || DEFAULT_FRONTEND;

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || FRONTEND_URL)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const ORDER_NOTIFY_EMAIL = process.env.ORDER_NOTIFY_EMAIL || process.env.BUSINESS_EMAIL || '';
const FROM_EMAIL = process.env.SMTP_FROM || ORDER_NOTIFY_EMAIL || process.env.BUSINESS_EMAIL || '';
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Rock Creek Granite';

// Stripe
if (!process.env.STRIPE_SECRET_KEY) console.warn('[WARN] STRIPE_SECRET_KEY not set');
if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('[WARN] STRIPE_WEBHOOK_SECRET not set');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

// -------------------- Mail layer (Resend API preferred; SMTP fallback) --------------------
function currentMailMode() {
  if (process.env.RESEND_API_KEY) return { mode: 'resend-api' };
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD) {
    const port = Number(process.env.SMTP_PORT || 587);
    const secureEnv = String(process.env.SMTP_SECURE || '').toLowerCase();
    const secure = secureEnv ? secureEnv === 'true' : port === 465; // default true for 465
    return { mode: 'smtp', host: process.env.SMTP_HOST, port, secure };
  }
  return { mode: 'none' };
}

function makeMailer() {
  const mode = currentMailMode();

  if (mode.mode === 'resend-api') {
    const apiKey = process.env.RESEND_API_KEY;
    const endpoint = 'https://api.resend.com/emails';
    const from = FROM_NAME && FROM_EMAIL ? `${FROM_NAME} <${FROM_EMAIL}>` : (FROM_EMAIL || 'no-reply@localhost');

    return {
      mode,
      async send({ to, subject, text, html, bcc, attachments }) {
        const body = {
          from,
          to: Array.isArray(to) ? to : [to],
          subject,
          ...(text ? { text } : {}),
          ...(html ? { html } : {}),
          ...(bcc ? { bcc: Array.isArray(bcc) ? bcc : [bcc] } : {}),
          ...(attachments && attachments.length
            ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content })) }
            : {})
        };
        const resp = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!resp.ok) {
          const t = await resp.text().catch(() => '');
          throw new Error(`Resend API error: ${resp.status} ${t}`);
        }
        return await resp.json();
      }
    };
  }

  if (mode.mode === 'smtp') {
    const transporter = nodemailer.createTransport({
      host: mode.host,
      port: mode.port,
      secure: mode.secure,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    });
    const from = FROM_NAME && FROM_EMAIL ? `${FROM_NAME} <${FROM_EMAIL}>` : (FROM_EMAIL || process.env.SMTP_USER);

    return {
      mode,
      async send({ to, subject, text, html, bcc, attachments }) {
        await transporter.verify().catch(() => {}); // don’t throw on verify
        return transporter.sendMail({
          from,
          to,
          bcc,
          subject,
          text,
          html,
          attachments // [{ filename, content, contentType }]
        });
      }
    };
  }

  console.warn('[MAIL] No email provider configured');
  return {
    mode,
    async send() {
      throw new Error('Email not configured: set RESEND_API_KEY or SMTP_* env vars');
    }
  };
}

const mailer = makeMailer();

// -------------------- Express app --------------------
const app = express();
app.set('trust proxy', true);

// Log boot info
{
  const m = currentMailMode();
  const modeStr = m.mode === 'smtp' ? `smtp:${m.host}:${m.port}${m.secure ? ' (secure)' : ''}` : m.mode;
  console.log(`[MAIL] Mode: ${modeStr}  From: ${FROM_EMAIL || 'n/a'}  As: ${FROM_NAME || ''}`);
  console.log('[BOOT] FRONTEND_URL:', FRONTEND_URL);
  console.log('[BOOT] Allowed origins:', ALLOWED_ORIGINS.join(', '));
}

// -------------------- Stripe Webhook (must be BEFORE express.json) --------------------
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
          cfg_summary: cfg ? { shape: cfg.shape, zip: cfg.zip } : null
        });

        // Send internal order email to your shop inbox
        if (ORDER_NOTIFY_EMAIL) {
          const total = (session.amount_total / 100).toFixed(2);
          const currency = String(session.currency || 'usd').toUpperCase();
          const summaryLines = [
            `Stripe Session: ${session.id}`,
            `Customer: ${session.customer_details?.email || 'N/A'}`,
            `Total: $${total} ${currency}`,
            `ZIP: ${cfg?.zip || session.metadata?.zip || 'N/A'}`,
            `Shape: ${cfg?.shape || 'N/A'}`,
            `Dims: ${cfg?.dims ? JSON.stringify(cfg.dims) : 'N/A'}`,
            `Sinks: ${cfg?.sinks?.length || 0}`,
            `Edges: ${cfg?.edges?.join(', ') || 'None'}`,
            `Backsplash: ${cfg?.backsplash ? 'Yes' : 'No'}`
          ].join('\n');

          try {
            await mailer.send({
              to: ORDER_NOTIFY_EMAIL,
              subject: `${process.env.NODE_ENV === 'production' ? '' : '[TEST] '}New RCG order ${session.id}`,
              text: summaryLines
            });
          } catch (e) {
            console.error('[MAIL] Order email failed:', e);
          }
        }

        break;
      }

      default:
        // Other events can be handled here if needed
        if (process.env.NODE_ENV !== 'production') console.log(`[stripe] ${event.type}`);
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.sendStatus(500);
  }

  res.json({ received: true });
});

// -------------------- CORS & JSON (after webhook) --------------------
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server, CLI, curl
    const ok = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  }
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

// -------------------- Pricing (mirror of client) --------------------
const DOLLARS_PER_SQFT = 55;
const LBS_PER_SQFT = 10.9;
const LTL_CWT_BASE = 35.9;
const DISTANCE_BANDS = [
  { max: 250, mult: 1.0 },
  { max: 600, mult: 1.25 },
  { max: 1000, mult: 1.5 },
  { max: 1500, mult: 1.7 },
  { max: Infinity, mult: 1.85 }
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

// -------------------- Stripe: create Checkout Session --------------------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { config, email } = req.body || {};
    if (!config) return res.status(400).json({ error: 'Missing config' });

    // Server-authored pricing
    const p = computePricing(config);

    const line_items = [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Custom Porcelain Countertop',
            description: 'Material, fabrication, sinks, backsplash (if selected), packaging & LTL shipping'
          },
          unit_amount: Math.max(0, Math.round(p.services * 100))
        },
        quantity: 1
      }
    ];
    if (p.tax > 0) {
      line_items.push({
        price_data: {
          currency: 'usd',
          product_data: { name: 'Sales Tax' },
          unit_amount: Math.max(0, Math.round(p.tax * 100))
        },
        quantity: 1
      });
    }

    // Compact config for metadata
    const compactCfg = {
      shape: config.shape,
      dims: config.dims,
      sinks: Array.isArray(config.sinks)
        ? config.sinks.map(s => ({
            key: s.key,
            x: Number(s.x?.toFixed?.(2) ?? s.x),
            y: Number(s.y?.toFixed?.(2) ?? s.y),
            faucet: s.faucet ?? '1',
            spread: s.spread ?? null
          }))
        : [],
      color: config.color,
      edges: Array.isArray(config.edges) ? config.edges : [],
      backsplash: !!config.backsplash,
      zip: String(config.zip || '')
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
      shipping_address_collection: { allowed_countries: ['US'] }
    });

    res.json({ id: session.id, url: session.url });
  } catch (e) {
    console.error('create-checkout-session failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Let the thank-you page read the session
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

// -------------------- Email DXF --------------------
app.post('/api/email-dxf', async (req, res) => {
  try {
    const { to, bcc, subject, config, dxfBase64 } = req.body || {};
    if (!to || !dxfBase64) return res.status(400).json({ error: 'Missing to or dxfBase64' });

    const b64 = dxfBase64.replace(/^data:.*?;base64,/, '');
    const attachment = { filename: 'RCG_CutSheet.dxf', content: b64, contentType: 'application/dxf' };

    const summary = `Shape: ${config?.shape}
Size: ${JSON.stringify(config?.dims)}
Polished: ${Array.isArray(config?.edges) ? config.edges.join(', ') : 'None'}
Backsplash: ${config?.backsplash ? 'Yes' : 'No'}
Sinks: ${(config?.sinks || []).length}`;

    await mailer.send({
      to,
      bcc,
      subject: subject || 'RCG DXF',
      text: `Attached is your DXF cut sheet.\n\n${summary}`,
      attachments: [attachment]
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('email-dxf failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// -------------------- Diagnostics & health --------------------
app.get('/__diag', (_req, res) => {
  const m = currentMailMode();
  res.json({
    ok: true,
    mail_mode: m.mode,
    mail_details: m,
    has_resend_key: !!process.env.RESEND_API_KEY,
    frontend_url: FRONTEND_URL,
    allowed_origins: ALLOWED_ORIGINS,
    commit: process.env.RENDER_GIT_COMMIT || process.env.VERCEL_GIT_COMMIT_SHA || process.env.COMMIT || null
  });
});

app.get('/', (_req, res) => res.type('text/plain').send('ok'));
app.get('/.well-known/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});



