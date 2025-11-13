// server.js — Express + Stripe Checkout + Webhook + Email via Resend API (ESM)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

/* =========================================
   Boot / Env
========================================= */
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.rockcreekgranite.com';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || FRONTEND_URL)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Rock Creek Granite';
const FROM_EMAIL = process.env.SMTP_FROM || process.env.BUSINESS_EMAIL || 'no-reply@rockcreekgranite.com';
const ORDER_NOTIFY_EMAIL = process.env.ORDER_NOTIFY_EMAIL || process.env.BUSINESS_EMAIL || FROM_EMAIL;

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

/* =========================================
   Express app
========================================= */
const app = express();
app.set('trust proxy', true);

// Stripe webhook MUST come before express.json()
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

        // Reassemble compact config from metadata
        const cfg = reassembleCfgFromMeta(session.metadata);
        console.log('[stripe] checkout.session.completed', {
          id: session.id,
          email: session.customer_details?.email,
          amount_total: session.amount_total,
          cfg_summary: cfg ? { shape: cfg.shape, zip: cfg.zip } : null,
        });

        // Send order emails (fire-and-forget)
        const userEmail = session.customer_details?.email;
        const totalUSD = (Number(session.amount_total || 0) / 100).toFixed(2);
        const currency = String(session.currency || 'usd').toUpperCase();

        const summaryLines = [
          `Stripe Session: ${session.id}`,
          `Customer: ${userEmail || 'N/A'}`,
          `Total: $${totalUSD} ${currency}`,
          `ZIP: ${cfg?.zip || session.metadata?.zip || 'N/A'}`,
          `Shape: ${cfg?.shape || 'N/A'}`,
          `Dims: ${cfg?.dims ? JSON.stringify(cfg.dims) : 'N/A'}`,
          `Sinks: ${cfg?.sinks?.length || 0}`,
          `Edges: ${cfg?.edges?.join(', ') || 'None'}`,
          `Backsplash: ${cfg?.backsplash ? 'Yes' : 'No'}`,
        ].join('\n');

        // Internal notification
        safeSendEmail({
          to: ORDER_NOTIFY_EMAIL,
          subject: `New RCG order ${session.id}`,
          text: summaryLines,
        }).catch(e => console.error('[mail] internal notify failed:', e));

        // Customer confirmation (simple)
        if (userEmail) {
          const customerText = [
            `Thanks for your order!`,
            ``,
            `Order: ${session.id}`,
            `Total: $${totalUSD} ${currency}`,
            `We'll follow up with next steps shortly.`,
          ].join('\n');

          safeSendEmail({
            to: userEmail,
            subject: 'Rock Creek Granite — Order received',
            text: customerText,
          }).catch(e => console.error('[mail] customer confirm failed:', e));
        }

        break;
      }
      default:
        // Log other events in non-prod if you like
        break;
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.sendStatus(500);
  }

  res.json({ received: true });
});

// After webhook: CORS + JSON
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true); // server-to-server
    const ok = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

/* =========================================
   Pricing helpers (match client logic)
========================================= */
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
    case 'polygon': {
      const n = +d.n || 6; const s = +d.A || 12;
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

/* =========================================
   Metadata helpers (config chunking)
========================================= */
function encodeCfgForMeta(obj) {
  try { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); }
  catch { return ''; }
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

/* =========================================
   Email via Resend (HTTPS API)
========================================= */
// NOTE: Render blocks SMTP ports; use HTTPS email APIs instead. (Resend)
// https://community.render.com/t/port-25-being-blocked/12331  (Render staff)
// Resend API reference (attachments supported): https://resend.com/docs/api-reference/emails/send-email

function mailMode() {
  if (RESEND_API_KEY) return `resend-api`;
  return 'none';
}
console.log(`[MAIL] Mode: ${mailMode()}  From: ${FROM_EMAIL}  As: ${MAIL_FROM_NAME}`);

async function sendEmailViaResend({ to, bcc, subject, text, html, attachments }) {
  if (!RESEND_API_KEY) throw new Error('Mail not configured');
  // Resend expects arrays for to/bcc or a single string.
  const payload = {
    from: `${MAIL_FROM_NAME} <${FROM_EMAIL}>`,
    to,
    bcc,
    subject,
    text,
    html,
    // attachments: [{ filename, content, contentType }]
    attachments: Array.isArray(attachments) && attachments.length
      ? attachments.map(a => ({ filename: a.filename, content: a.content, contentType: a.contentType }))
      : undefined,
  };
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error('[Resend] send failed:', resp.status, json);
    throw new Error(json?.message || `Resend error ${resp.status}`);
  }
  return json;
}

async function safeSendEmail(opts) {
  if (mailMode() === 'resend-api') return sendEmailViaResend(opts);
  throw new Error('Mail not configured');
}

/* =========================================
   Routes
========================================= */

// Create Stripe Checkout Session
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

    // Compact config into metadata (no pricing)
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

// Read a Checkout Session for Thank-You page
app.get('/api/checkout-session', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    const session = await stripe.checkout.sessions.retrieve(id, {
      expand: ['line_items', 'payment_intent', 'customer'],
    });
    return res.json({ ok: true, session });
  } catch (e) {
    console.error('GET /api/checkout-session failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Email DXF (uses Resend API)
app.post('/api/email-dxf', async (req, res) => {
  try {
    const { to, bcc, subject, config, dxfBase64 } = req.body || {};
    if (!to || !dxfBase64) return res.status(400).json({ error: 'Missing to or dxfBase64' });

    const summary = `Shape: ${config?.shape}
Size: ${JSON.stringify(config?.dims)}
Polished: ${Array.isArray(config?.edges) ? config.edges.join(', ') : 'None'}
Backsplash: ${config?.backsplash ? 'Yes' : 'No'}
Sinks: ${(config?.sinks || []).length}`;

    await safeSendEmail({
      to,
      bcc,
      subject: subject || 'RCG DXF',
      text: `Attached is your DXF cut sheet.\n\n${summary}`,
      attachments: [
        { filename: 'RCG_CutSheet.dxf', content: dxfBase64, contentType: 'application/dxf' },
      ],
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('email-dxf failed:', e);
    res.status(500).json({ error: e.message });
  }
});

/* =========================================
   Health + Start
========================================= */
app.get('/', (_req, res) => res.type('text/plain').send('ok'));
app.get('/.well-known/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

console.log('[BOOT] FRONTEND_URL:', FRONTEND_URL);
console.log('[BOOT] Allowed origins:', ALLOWED_ORIGINS.join(', '));

app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});