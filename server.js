// server.js — Express + Stripe Checkout + Webhook + Email DXF (single mailer, ESM)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

// -------------------- Boot logs & safety --------------------
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

// -------------------- Env --------------------
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.rockcreekgranite.com';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || FRONTEND_URL)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

const MAIL_FROM = process.env.SMTP_FROM || process.env.BUSINESS_EMAIL || 'orders@rockcreekgranite.com';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Rock Creek Granite';

function envBool(v, def=false) {
  if (v == null) return def;
  const s = String(v).toLowerCase();
  if (['1','true','yes','y','on'].includes(s)) return true;
  if (['0','false','no','n','off'].includes(s)) return false;
  return def;
}

// -------------------- ONE mailer for whole app --------------------
let mail = { transporter: null, describe: '[none]' };

async function buildMailer() {
  const haveSMTP = !!process.env.SMTP_HOST && !!process.env.SMTP_USER && !!process.env.SMTP_PASS;

  if (haveSMTP) {
    const secure = process.env.SMTP_SECURE
      ? envBool(process.env.SMTP_SECURE, true)
      : String(process.env.SMTP_PORT) === '465';
    const port = Number(process.env.SMTP_PORT || (secure ? 465 : 587));
    const host = process.env.SMTP_HOST;

    const transporter = nodemailer.createTransport({
      host,
      port,
      secure, // true => port 465 TLS; false => 587 STARTTLS
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      // Optional hardening:
      tls: { rejectUnauthorized: true },
    });

    mail = {
      transporter,
      fromHeader: `"${MAIL_FROM_NAME}" <${MAIL_FROM}>`,
      describe: `smtp:${host}:${port}`,
    };

    try {
      await transporter.verify();
      console.log(`[MAIL] Mode: ${mail.describe}  From: ${MAIL_FROM}  As: ${MAIL_FROM_NAME}`);
    } catch (err) {
      console.error('[MAIL] SMTP verify failed:', err.message);
    }
    return;
  }

  console.warn('[MAIL] No email provider configured');
  mail = { transporter: null, fromHeader: MAIL_FROM, describe: '[none]' };
}

await buildMailer();

// Simple helper to guarantee we always use the same transporter
async function sendMail({ to, bcc, subject, text, html, attachments }) {
  if (!mail.transporter) throw new Error('Mail not configured');
  return mail.transporter.sendMail({
    from: mail.fromHeader,
    to,
    bcc,
    subject,
    text,
    html,
    attachments,
  });
}

// -------------------- Express --------------------
const app = express();
app.set('trust proxy', true);

// Webhook MUST be raw (before json)
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

        // Optional: email the shop inbox with a simple summary
        try {
          const to = process.env.ORDER_NOTIFY_EMAIL || 'orders@rockcreekgranite.com';
          const total = (session.amount_total / 100).toFixed(2);
          const lines = [
            `Stripe Session: ${session.id}`,
            `Customer: ${session.customer_details?.email || 'N/A'}`,
            `Total: $${total} ${String(session.currency || 'usd').toUpperCase()}`,
          ].join('\n');

          if (mail.transporter) {
            await sendMail({
              to,
              subject: `${process.env.NODE_ENV === 'production' ? '' : '[TEST] '}New RCG order ${session.id}`,
              text: lines,
            });
          } else {
            console.warn('[MAIL] Skipped order notify email (mailer not configured)');
          }
        } catch (e) {
          console.error('Order notify email failed:', e.message);
        }

        console.log('[stripe] checkout.session.completed', {
          id: session.id,
          email: session.customer_details?.email,
          amount_total: session.amount_total,
        });
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

// Now enable CORS & JSON
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

// -------------------- Pricing helpers (unchanged from your build) --------------------
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
    case 'circle': { const D = +d.D || 0; return (Math.PI * Math.pow(D/2,2)) / 144; }
    case 'polygon': {
      const n = +d.n || 6, s = +d.A || 12;
      const areaIn2 = (n * s * s) / (4 * Math.tan(Math.PI / n));
      return areaIn2 / 144;
    }
    default: return 0;
  }
}
function distanceBand(originZip, destZip) {
  const o = parseInt(String(originZip || '63052').slice(0,3),10);
  const d = parseInt(String(destZip || '00000').slice(0,3),10);
  const approxMiles = Math.abs(o - d) * 20 + 100;
  return DISTANCE_BANDS.find(b => approxMiles <= b.max).mult;
}
function shippingEstimate(area, destZip, originZip='63052') {
  const weight = area * LBS_PER_SQFT;
  const cwt = Math.max(1, Math.ceil(weight/100));
  const mult = distanceBand(originZip, destZip);
  const base = cwt * LTL_CWT_BASE * mult;
  return { weight, cwt, mult, ltl: base * 1.2 };
}
function backsplashSqft(cfg) {
  if (!cfg || cfg.shape !== 'rectangle' || !cfg.backsplash) return 0;
  const L = +cfg.dims?.L || 0, W = +cfg.dims?.W || 0;
  const edges = Array.isArray(cfg.edges) ? cfg.edges : [];
  const unpol = ['top','right','bottom','left'].filter(k => !edges.includes(k));
  const lenMap = { top:L, bottom:L, left:W, right:W };
  const areaIn2 = unpol.reduce((sum,k)=> sum + (lenMap[k]||0)*4, 0);
  return areaIn2/144;
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
    ? (cfg?.sinks || []).reduce((acc,s)=> acc + (SINK_PRICES[s.key]||0), 0)
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

    // Compact config into metadata in the future if needed; kept minimal here
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: `${FRONTEND_URL}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/configurator?canceled=1`,
      customer_email: email || undefined,
      shipping_address_collection: { allowed_countries: ['US'] },
    });

    res.json({ id: session.id, url: session.url });
  } catch (e) {
    console.error('create-checkout-session failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// -------------------- Email DXF --------------------
app.post('/api/email-dxf', async (req, res) => {
  try {
    const { to, bcc, subject, config, dxfBase64 } = req.body || {};
    if (!to || !dxfBase64) return res.status(400).json({ error: 'Missing to or dxfBase64' });
    if (!mail.transporter) return res.status(500).json({ error: 'Mail not configured' });

    const buf = Buffer.from(dxfBase64, 'base64');
    const summary =
      `Shape: ${config?.shape}\n` +
      `Size: ${JSON.stringify(config?.dims)}\n` +
      `Polished: ${Array.isArray(config?.edges) ? config.edges.join(', ') : 'None'}\n` +
      `Backsplash: ${config?.backsplash ? 'Yes' : 'No'}\n` +
      `Sinks: ${(config?.sinks || []).length}`;

    await sendMail({
      to,
      bcc,
      subject: subject || 'RCG DXF',
      text: `Attached is your DXF cut sheet.\n\n${summary}`,
      attachments: [{ filename: 'RCG_CutSheet.dxf', content: buf, contentType: 'application/dxf' }],
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('email-dxf failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// -------------------- Utility APIs --------------------
app.get('/api/checkout-session', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
    const session = await stripe.checkout.sessions.retrieve(id, {
      expand: ['line_items', 'payment_intent', 'customer']
    });
    return res.json({ ok: true, session });
  } catch (e) {
    console.error('GET /api/checkout-session failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Health
app.get('/', (_req, res) => res.type('text/plain').send('ok'));
app.get('/.well-known/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// -------------------- Start --------------------
console.log('[BOOT] FRONTEND_URL:', FRONTEND_URL);
console.log('[BOOT] Allowed origins:', ALLOWED_ORIGINS.join(', '));
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});