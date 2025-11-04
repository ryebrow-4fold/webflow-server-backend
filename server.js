// server.js — Express + Stripe Checkout + Webhook + Gmail SMTP emails (ESM)
// Paste this whole file. Requires package.json { "type": "module" }
// Env you should set on Render:
//  FRONTEND_URL=https://www.rockcreekgranite.com
//  ALLOWED_ORIGINS=https://www.rockcreekgranite.com,https://rockcreekgranite.com,https://rockcreekgranite.webflow.io,https://preview.webflow.com
//  STRIPE_SECRET_KEY=sk_test_...
//  STRIPE_WEBHOOK_SECRET=whsec_...
//  ORDER_NOTIFY_EMAIL=orders@rockcreekgranite.com
//  MAIL_FROM_NAME="Rock Creek Granite"
//  SMTP_HOST=smtp.gmail.com
//  SMTP_PORT=465   (or 587)
//  SMTP_USER=orders@rockcreekgranite.com
//  SMTP_PASS=<16-char App Password>   (or SMTP_PASSWORD)
//  SMTP_SECURE=true   (if using port 465; omit/false for 587)
//  TEST_EMAIL_TOKEN=<make up a long random string>

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';

// ----------------- tiny helpers -----------------
const isTrue = (v) => String(v).toLowerCase() === 'true';
const cents = (usd) => Math.max(0, Math.round((+usd || 0) * 100));

// ---- metadata chunking to dodge Stripe 500-char limit ----
function encodeCfgForMeta(obj) {
  try { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); } catch { return ''; }
}
function splitMeta(key, value, chunkSize = 480) {
  const meta = {}; if (!value) return meta;
  if (value.length <= 500) { meta[key] = value; return meta; }
  const parts = Math.ceil(value.length / chunkSize);
  meta[`${key}_parts`] = String(parts);
  for (let i = 0; i < parts; i++) meta[`${key}_${i+1}`] = value.slice(i*chunkSize, (i+1)*chunkSize);
  return meta;
}
function reassembleCfgFromMeta(md) {
  if (!md) return null;
  if (md.cfg) { try { return JSON.parse(Buffer.from(md.cfg, 'base64').toString('utf8')); } catch { return null; } }
  const parts = Number(md.cfg_parts || 0); if (!parts) return null;
  let joined = ''; for (let i=1;i<=parts;i++) joined += md[`cfg_${i}`] || '';
  try { return JSON.parse(Buffer.from(joined, 'base64').toString('utf8')); } catch { return null; }
}

// ----------------- config -----------------
const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://www.rockcreekgranite.com';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || FRONTEND_URL)
  .split(',').map(s=>s.trim()).filter(Boolean);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', { apiVersion: '2024-06-20' });

console.log('[BOOT] FRONTEND_URL:', FRONTEND_URL);
console.log('[BOOT] Allowed origins:', ALLOWED_ORIGINS.join(', '));

// ----------------- mail transport -----------------
function createTransporter() {
  // Prefer explicit SMTP (Gmail) config
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS || process.env.SMTP_PASSWORD;
  const secure = isTrue(process.env.SMTP_SECURE) || port === 465;

  if (host && user && pass) {
    const t = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
    console.log(`[MAIL] Mode: smtp:${host}:${port}  From: ${process.env.SMTP_FROM || user}  As: ${process.env.MAIL_FROM_NAME || ''}`);
    return t;
  }

  // Fallback: basic non-auth (will usually fail) so we can surface a clear warning
  console.warn('[MAIL] No SMTP creds detected — emails will not send. Set SMTP_* env vars.');
  return nodemailer.createTransport({ jsonTransport: true });
}

const transporter = createTransporter();

// Verify SMTP on boot
(async () => {
  try {
    if (transporter?.verify) {
      await transporter.verify();
      console.log('[MAIL] SMTP verified ✓');
    }
  } catch (e) {
    console.error('[MAIL] SMTP verify failed:', e.message);
  }
})();

function fromHeader() {
  const name = process.env.MAIL_FROM_NAME || 'Rock Creek Granite';
  const addr = process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@rockcreekgranite.com';
  return `${name} <${addr}>`;
}

async function sendInternalOrderEmail(session, cfg) {
  const to = process.env.ORDER_NOTIFY_EMAIL || 'orders@rockcreekgranite.com';
  const totalUSD = (session.amount_total/100).toFixed(2);
  const subjectPrefix = session.livemode ? '' : '[TEST] ';
  const subject = `${subjectPrefix}New order ${session.id}`;

  const lines = [
    `Stripe Session: ${session.id}`,
    `Customer: ${session.customer_details?.email || 'N/A'}`,
    `Total: $${totalUSD} ${String(session.currency||'usd').toUpperCase()}`,
    `ZIP: ${cfg?.zip || session.metadata?.zip || 'N/A'}`,
    `Shape: ${cfg?.shape || 'N/A'}`,
    `Dims: ${cfg?.dims ? JSON.stringify(cfg.dims) : 'N/A'}`,
    `Sinks: ${cfg?.sinks?.length || 0}`,
    `Edges: ${cfg?.edges?.join(', ') || 'None'}`,
    `Backsplash: ${cfg?.backsplash ? 'Yes' : 'No'}`,
  ].join('\n');

  console.log('[MAIL] → sending internal order email to', to);
  const info = await transporter.sendMail({ from: fromHeader(), to, subject, text: lines });
  console.log('[MAIL] internal sent:', info.messageId || info);
}

async function sendCustomerReceiptEmail(session, cfg) {
  const to = session.customer_details?.email;
  if (!to) { console.log('[MAIL] customer email skipped (missing customer email)'); return; }
  const subject = `We received your order – ${session.id}`;
  const text = [
    'Thanks for your order! Our team will review your custom countertop and follow up soon.',
    '',
    `Order: ${session.id}`,
    `Total: $${(session.amount_total/100).toFixed(2)} ${String(session.currency||'usd').toUpperCase()}`,
    `Ship ZIP: ${cfg?.zip || session.metadata?.zip || 'N/A'}`,
    '',
    'If you have questions, reply to this email.',
  ].join('\n');

  console.log('[MAIL] → sending customer receipt to', to);
  const info = await transporter.sendMail({ from: fromHeader(), to, subject, text });
  console.log('[MAIL] customer sent:', info.messageId || info);
}

// ----------------- app -----------------
const app = express();
app.set('trust proxy', true);

// Webhook MUST come before express.json()
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

        try { await sendInternalOrderEmail(session, cfg); } catch (e) { console.error('[MAIL] internal failed:', e); }
        try { await sendCustomerReceiptEmail(session, cfg); } catch (e) { console.error('[MAIL] customer failed:', e); }
        break;
      }
      default: {
        if (process.env.NODE_ENV !== 'production') console.log(`[stripe] ${event.type}`);
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    return res.sendStatus(500);
  }

  res.json({ received: true });
});

// CORS + JSON after webhook
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' }));

// -------------- pricing (server-authoritative) --------------
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
    case 'rectangle': return ((+d.L||0) * (+d.W||0)) / 144;
    case 'circle': { const D = +d.D||0; return (Math.PI * Math.pow(D/2,2))/144; }
    case 'polygon': { const n=+d.n||6, s=+d.A||12; const areaIn2 = (n*s*s)/(4*Math.tan(Math.PI/n)); return areaIn2/144; }
    default: return 0;
  }
}
function distanceBand(originZip, destZip) { const o=parseInt(String(originZip||'63052').slice(0,3),10); const d=parseInt(String(destZip||'00000').slice(0,3),10); const miles=Math.abs(o-d)*20+100; return DISTANCE_BANDS.find(b=>miles<=b.max).mult; }
function shippingEstimate(area, destZip, originZip='63052') { const weight=area*LBS_PER_SQFT; const cwt=Math.max(1, Math.ceil(weight/100)); const mult=distanceBand(originZip, destZip); const base=cwt*LTL_CWT_BASE*mult; return { weight, cwt, mult, ltl: base*1.2 }; }
function backsplashSqft(cfg) { if(!cfg||cfg.shape!=='rectangle'||!cfg.backsplash) return 0; const L=+cfg.dims?.L||0, W=+cfg.dims?.W||0; const edges=Array.isArray(cfg.edges)?cfg.edges:[]; const unpol=['top','right','bottom','left'].filter(k=>!edges.includes(k)); const lenMap={top:L,bottom:L,left:W,right:W}; const areaIn2=unpol.reduce((s,k)=>s+(lenMap[k]||0)*4,0); return areaIn2/144; }
function taxRateByZip(zip){ if(!/^[0-9]{5}$/.test(zip||'')) return 0.07; if(/^63/.test(zip)) return 0.0825; if(/^62/.test(zip)) return 0.0875; return 0.07; }
function computePricing(cfg){ const area=areaSqft(cfg?.shape, cfg?.dims); const material=area*DOLLARS_PER_SQFT; const sinks=cfg?.shape==='rectangle' ? (cfg?.sinks||[]).reduce((a,s)=>a+(SINK_PRICES[s.key]||0),0) : 0; const bpsf=backsplashSqft(cfg)*DOLLARS_PER_SQFT; const ship=shippingEstimate(area+backsplashSqft(cfg), cfg?.zip||''); const taxRate=taxRateByZip(cfg?.zip); const services=material+sinks+bpsf+ship.ltl; const tax=services*taxRate; const total=services+tax; return { area, material, sinks, backsplash: bpsf, ship, taxRate, tax, total, services }; }

// -------------- create checkout session --------------
app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const { config, email } = req.body || {};
    if (!config) return res.status(400).json({ error: 'Missing config' });

    const p = computePricing(config);
    const line_items = [
      { price_data: { currency:'usd', product_data:{ name:'Custom Porcelain Countertop', description:'Material, fabrication, sinks, backsplash (if selected), packaging & LTL shipping' }, unit_amount: cents(p.services) }, quantity: 1 },
    ];
    if (p.tax > 0) line_items.push({ price_data: { currency:'usd', product_data:{ name:'Sales Tax' }, unit_amount: cents(p.tax) }, quantity: 1 });

    const compactCfg = {
      shape: config.shape,
      dims: config.dims,
      sinks: Array.isArray(config.sinks) ? config.sinks.map(s=>({ key:s.key, x:Number(s.x?.toFixed?.(2) ?? s.x), y:Number(s.y?.toFixed?.(2) ?? s.y), faucet:s.faucet ?? '1', spread:s.spread ?? null })) : [],
      color: config.color,
      edges: Array.isArray(config.edges)?config.edges:[],
      backsplash: !!config.backsplash,
      zip: String(config.zip||''),
    };
    const cfgB64 = encodeCfgForMeta(compactCfg);
    const metadata = { zip: String(config.zip||''), ...splitMeta('cfg', cfgB64) };

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

// -------------- thank-you helper --------------
app.get('/api/checkout-session', async (req, res) => {
  try {
    const id = req.query.id;
    if (!id) return res.status(400).json({ ok:false, error:'missing id' });
    const session = await stripe.checkout.sessions.retrieve(id, { expand:['line_items','payment_intent','customer'] });
    return res.json({ ok:true, session });
  } catch (e) {
    console.error('GET /api/checkout-session failed:', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// -------------- diagnostics: test email endpoint --------------
// Call like: POST /api/test-email?to=you@example.com&token=YOUR_TOKEN
app.post('/api/test-email', async (req, res) => {
  try {
    const { to, token } = { to: req.query.to, token: req.query.token };
    if (!to) return res.status(400).json({ ok:false, error:'missing to' });
    if (!process.env.TEST_EMAIL_TOKEN || token !== process.env.TEST_EMAIL_TOKEN) {
      return res.status(401).json({ ok:false, error:'unauthorized' });
    }
    const info = await transporter.sendMail({ from: fromHeader(), to, subject:'RCG test email', text:'This is a test from Render.' });
    res.json({ ok:true, messageId: info.messageId || String(info) });
  } catch (e) {
    console.error('test-email failed:', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

// -------------- health --------------
app.get('/', (_req, res) => res.type('text/plain').send('ok'));
app.get('/.well-known/health', (_req, res) => res.json({ ok:true, ts:new Date().toISOString() }));

// -------------- start --------------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
