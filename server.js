// server.js — Express + Stripe Checkout + Webhook + Resend email + DXF (ESM)
// Requires package.json: { "type": "module" }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

// Find the best available customer email from a Checkout Session
async function getCustomerEmailFromSession(session) {
  // 1) Most common: collected by Checkout
  if (session?.customer_details?.email) return session.customer_details.email;

  // 2) Provided when creating the session
  if (session?.customer_email) return session.customer_email;

  // 3) Fallback: fetch the Customer object if present
  try {
    if (typeof session?.customer === 'string' && session.customer.startsWith('cus_')) {
      const cust = await stripe.customers.retrieve(session.customer);
      if (!cust.deleted && cust.email) return cust.email;
    }
  } catch (e) {
    console.warn('[mail] could not retrieve customer email from customer id:', e.message || e);
  }

  return null; // nothing found
}

// ---------------------------- Boot guards & logging ----------------------------
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  process.exit(1);
});

// ---------------------------- Config & App ------------------------------------
const PORT = process.env.PORT || 3000;
const DEFAULT_FRONTEND = 'https://www.rockcreekgranite.com';
const FRONTEND_URL = process.env.FRONTEND_URL || DEFAULT_FRONTEND;

const defaultAllowed = [FRONTEND_URL, FRONTEND_URL.replace('www.', '')]
  .filter((v, i, a) => a.indexOf(v) === i);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : defaultAllowed).map(s => s.trim()).filter(Boolean);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
if (!STRIPE_SECRET_KEY) console.warn('[WARN] STRIPE_SECRET_KEY not set');
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('[WARN] STRIPE_WEBHOOK_SECRET not set');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.SMTP_FROM || process.env.BUSINESS_EMAIL || 'orders@rockcreekgranite.com';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'Rock Creek Granite';
const MAIL_MODE = RESEND_API_KEY ? 'resend-api' : 'none';
const ORDER_NOTIFY_EMAIL = process.env.ORDER_NOTIFY_EMAIL || 'orders@rockcreekgranite.com';

const app = express();
app.set('trust proxy', true);

console.log('[MAIL] Mode:', MAIL_MODE, ' From:', MAIL_FROM, ' As:', MAIL_FROM_NAME);
console.log('[BOOT] FRONTEND_URL:', FRONTEND_URL);
console.log('[BOOT] Allowed origins:', ALLOWED_ORIGINS.join(', '));

// ---------------------------- Helpers: pricing & metadata ----------------------
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
    case 'circle':    { const D = +d.D || 0; return (Math.PI * Math.pow(D/2, 2)) / 144; }
    case 'polygon':   { const n = +d.n || 6; const s = +d.A || 12; const areaIn2 = (n * s * s) / (4 * Math.tan(Math.PI/n)); return areaIn2/144; }
    default: return 0;
  }
}
function distanceBand(originZip, destZip) {
  const o = parseInt(String(originZip || '63052').slice(0,3), 10);
  const d = parseInt(String(destZip || '00000').slice(0,3), 10);
  const approxMiles = Math.abs(o - d) * 20 + 100;
  return DISTANCE_BANDS.find(b => approxMiles <= b.max).mult;
}
function shippingEstimate(area, destZip, originZip='63052') {
  const weight = area * LBS_PER_SQFT;
  const cwt = Math.max(1, Math.ceil(weight / 100));
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
  const areaIn2 = unpol.reduce((sum,k)=> sum + (lenMap[k] || 0) * 4, 0);
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

// ----- metadata chunking (stay under Stripe 500-char limit per value) -----
function encodeCfgForMeta(obj) {
  try { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); }
  catch { return ''; }
}
function splitMeta(key, value, chunkSize=480) {
  const meta = {};
  if (!value) return meta;
  if (value.length <= 500) { meta[key] = value; return meta; }
  const parts = Math.ceil(value.length / chunkSize);
  meta[`${key}_parts`] = String(parts);
  for (let i=0; i<parts; i++) meta[`${key}_${i+1}`] = value.slice(i*chunkSize, (i+1)*chunkSize);
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
  for (let i=1; i<=parts; i++) joined += md[`cfg_${i}`] || '';
  try { return JSON.parse(Buffer.from(joined, 'base64').toString('utf8')); }
  catch { return null; }
}

// ---------------------------- Faucet helpers (emails) -------------------------
function faucetDesc(s) {
  const n = parseInt(s?.faucet ?? 1, 10) || 1;
  if (n === 1) return '1-hole';
  const spread = +s?.spread || (n === 3 ? 8 : 0);
  return n === 3 ? `3-hole ${spread}" spread` : `${n}-hole`;
}
function sinksFaucetList(cfg) {
  const list = (cfg?.sinks || []).map((s, i) => {
    const name = s?.key || s?.type || `sink-${i+1}`;
    return `Sink ${i+1} (${name}): ${faucetDesc(s)}`;
  });
  return list.length ? list.join('\n') : 'None';
}

// --- DXF generator with faucet holes, splash outside, polished edges ---
function makeDxfAttachmentFromConfig(cfg, orderId = '') {
  if (!cfg || cfg.shape !== 'rectangle') {
    const txt = 'RCG ORDER (non-rectangle)';
    const dxf = ['0','SECTION','2','ENTITIES','0','TEXT','8','0','10','0','20','0','40','12','1',txt,'0','ENDSEC','0','EOF'].join('\n');
    return { filename: `RCG_${(orderId || '').split('_').pop().slice(-8) || 'order'}.dxf`, content: Buffer.from(dxf,'utf8').toString('base64') };
  }

  // ---------- config ----------
  const L = +cfg?.dims?.L || 0; // inches
  const W = +cfg?.dims?.W || 0;
  const sinks = Array.isArray(cfg?.sinks) ? cfg.sinks : [];
  const edges = Array.isArray(cfg?.edges) ? cfg.edges : [];
  const backsplash = !!cfg?.backsplash;

  // Faucet defaults
  const HOLE_D = 1.375; // 1-3/8"
  const HOLE_R = HOLE_D / 2;
  const FAUCET_SETBACK = 2; // 2" behind sink cutout
  const OVAL_SEGMENTS = 72;

  // Fallback (shrink 0.5" from your full sizes)
  const FALLBACK = {
    'bath-oval':    { type:'oval', w:16.5, h:13.5 },
    'bath-rect':    { type:'rect', w:17.5, h:12.5 },
    'kitchen-rect': { type:'rect', w:21.5, h:15.5 },
  };

  // ---------- DXF helpers ----------
  const out = [];
  const push = (...a) => out.push(...a);

  function line(layer, x1,y1,x2,y2){ push('0','LINE','8',layer,'10',x1,'20',y1,'11',x2,'21',y2); }
  function circle(layer, cx,cy,r){ push('0','CIRCLE','8',layer,'10',cx,'20',cy,'40',r); }
  function lwpoly(layer, pts, closed){
    push('0','LWPOLYLINE','8',layer,'90',String(pts.length),'70', closed? '1':'0');
    for (const [x,y] of pts){ push('10',x,'20',y); }
  }
  function rect(layer, x, y, w, h){ lwpoly(layer, [[x,y],[x+w,y],[x+w,y+h],[x,y+h]], true); }
  function oval(layer, cx, cy, rx, ry, segs = OVAL_SEGMENTS){
    const pts = [];
    for (let i=0;i<segs;i++){
      const t = (i/segs)*Math.PI*2;
      pts.push([cx + rx*Math.cos(t), cy + ry*Math.sin(t)]);
    }
    lwpoly(layer, pts, true);
  }

  // ---------- ENTITIES ----------
  push('0','SECTION','2','ENTITIES');

  // Slab outline (0,0) to (L,W)
  rect('SLAB', 0, 0, L, W);

  // Polished edges
  if (edges.includes('top'))    line('POLISHED', 0, W, L, W);
  if (edges.includes('bottom')) line('POLISHED', 0, 0, L, 0);
  if (edges.includes('left'))   line('POLISHED', 0, 0, 0, W);
  if (edges.includes('right'))  line('POLISHED', L, 0, L, W);

  // External backsplash (4" tall), 1" above slab
  if (backsplash) { rect('SPLASH', 0, W + 1, L, 4); }

  // Sinks & faucet holes
  for (const s of sinks) {
    const sx = +s.x || 0;
    const sy = +s.y || 0;

    const key = s.key || '';
    const t   = s.type || (FALLBACK[key]?.type) || 'rect';
    const w   = +s.cutoutW || FALLBACK[key]?.w || 16;
    const h   = +s.cutoutH || FALLBACK[key]?.h || 13;
    const rx  = w/2, ry = h/2;

    // cutout
    if (t === 'oval') { oval('CUTOUT', sx, sy, rx, ry); }
    else { rect('CUTOUT', sx - rx, sy - ry, w, h); }

    // faucet holes
    const faucet = parseInt(s.faucet == null ? 1 : s.faucet, 10) || 1;
    const spread = +s.spread || (faucet === 3 ? 8 : 0);
    const yTopOfSink = sy + ry;
    const holeY = yTopOfSink + FAUCET_SETBACK;

    if (faucet === 1) {
      circle('FAUCET', sx, holeY, HOLE_R);
    } else if (faucet === 3) {
      const half = spread / 2;
      circle('FAUCET', sx, holeY, HOLE_R);
      circle('FAUCET', sx - half, holeY, HOLE_R);
      circle('FAUCET', sx + half, holeY, HOLE_R);
    } else {
      const gap = 1.25; // generic spacing
      const total = (faucet-1)*gap;
      for (let i=0;i<faucet;i++){
        const x = sx - total/2 + i*gap;
        circle('FAUCET', x, holeY, HOLE_R);
      }
    }
  }

  push('0','ENDSEC','0','EOF');

  const short = (orderId||'').split('_').pop().slice(-8);
  return {
    filename: `RCG_${short || 'order'}.dxf`,
    content: Buffer.from(out.join('\n'), 'utf8').toString('base64')
  };
}

// ---------------------------- Mail (Resend HTTP) ------------------------------
/**
 * sendEmail({ to, bcc, subject, text, html, attachments?, replyTo? })
 * attachments: [{ filename, content (base64) }]
 */
async function sendEmail({ to, bcc, subject, text, html, attachments = [], replyTo }) {
  if (MAIL_MODE !== 'resend-api') {
    throw new Error('RESEND_API_KEY missing; cannot send email');
  }

  const toList = Array.isArray(to) ? to : [to];
  const formattedTo = toList
    .map(addr => String(addr || '').trim())
    .filter(addr => /<.+@.+>/.test(addr) || /.+@.+\..+/.test(addr));

  if (!formattedTo.length) {
    throw new Error('Invalid "to" field; must be "email@example.com" or "Name <email@example.com>"');
  }

  const body = {
    from: `${MAIL_FROM_NAME} <${MAIL_FROM}>`,
    to: formattedTo,
    subject,
    ...(text ? { text } : {}),
    ...(html ? { html } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(bcc ? { bcc: Array.isArray(bcc) ? bcc : [bcc] } : {}),
    ...(attachments.length
      ? { attachments: attachments.map(a => ({ filename: a.filename, content: a.content })) }
      : {}),
    headers: { 'List-Unsubscribe': `<mailto:${ORDER_NOTIFY_EMAIL}>` },
    tags: [{ name: 'rcg-order' }],
  };

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
  return resp.json();
}

// ---------------------------- Tiny HTML templates -----------------------------
function renderCustomerEmailHTML(cfg, session) {
  // helpers
  const money = v => `$${((v || 0) / 100).toFixed(2)}`;
  const total = session.amount_total || 0;
  const currency = String(session.currency || 'usd').toUpperCase();
  const zip = (cfg?.zip || '').toString();
  const shape = cfg?.shape || 'N/A';
  const dims =
    cfg?.shape === 'rectangle'
      ? `${cfg?.dims?.L}" × ${cfg?.dims?.W}"`
      : cfg?.shape === 'circle'
      ? `${cfg?.dims?.D}" Ø`
      : cfg?.shape
      ? `${cfg?.dims?.n}-sides, ${cfg?.dims?.A}" side`
      : 'N/A';
  const edges = (cfg?.edges || []).join(', ') || 'None';
  const sinks = (cfg?.sinks || []).length;
  const backsplash = cfg?.backsplash ? 'Yes' : 'No';
  const color = cfg?.color || 'N/A';
  const brand = process.env.MAIL_FROM_NAME || 'Rock Creek Granite';
  const orderId = session.id;

  // preheader is hidden preview text many inboxes show next to subject
  const preheader = `Thanks—your order ${orderId} was received. Total ${money(total)} ${currency}.`;

  // Your SVG logo (remote) — most clients will load it; alt text included as fallback
  const logoUrl = 'https://cdn.prod.website-files.com/634cb6e50d8312e63b8d5ee1/67a16defcff775964e6f48ed_RCG_consumerLogo.svg';

  return `
  <div style="background:#f6f7f9;margin:0;padding:0;">
    <!-- Preheader (hidden) -->
    <div style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0;">
      ${preheader}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;">
      <tr>
        <td align="center" style="padding:24px 12px;">
          <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="width:640px;max-width:100%;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e7eb;">
            <!-- Header -->
            <tr>
              <td style="padding:18px 20px;background:#111;color:#fff;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <img src="${logoUrl}" width="160" alt="${brand}" style="display:block;max-width:160px;">
                    </td>
                    <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#ddd;">
                      Order&nbsp;<strong>${orderId}</strong>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Title -->
            <tr>
              <td style="padding:22px 20px 10px 20px;font-family:Arial,Helvetica,sans-serif;">
                <div style="font-size:18px;font-weight:700;color:#111;margin:0 0 6px;">Thanks — payment received!</div>
                <div style="font-size:14px;color:#333;margin:0;">We’ve started your fabrication ticket. Here’s a quick summary:</div>
              </td>
            </tr>

            <!-- Summary table -->
            <tr>
              <td style="padding:6px 20px 18px 20px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;">
                  <tr>
                    <td style="padding:8px 0;width:40%;color:#555;">Total Paid</td>
                    <td style="padding:8px 0;"><strong>${money(total)} ${currency}</strong></td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#555;">Ship ZIP</td>
                    <td style="padding:8px 0;">${zip || 'N/A'}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#555;">Shape</td>
                    <td style="padding:8px 0;">${shape}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#555;">Size</td>
                    <td style="padding:8px 0;">${dims}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#555;">Polished edges</td>
                    <td style="padding:8px 0;">${edges}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#555;">Sinks</td>
                    <td style="padding:8px 0;">${sinks}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#555;">Backsplash</td>
                    <td style="padding:8px 0;">${backsplash}</td>
                  </tr>
                  <tr>
                    <td style="padding:8px 0;color:#555;">Stone</td>
                    <td style="padding:8px 0;">${color}</td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="padding:16px 20px 20px 20px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#666;border-top:1px solid #eee;">
                Questions? Reply to this email or contact <a href="mailto:${process.env.ORDER_NOTIFY_EMAIL || 'orders@rockcreekgranite.com'}" style="color:#444;text-decoration:none;">${process.env.ORDER_NOTIFY_EMAIL || 'orders@rockcreekgranite.com'}</a>.<br>
                <span style="color:#999;display:inline-block;margin-top:8px;">© ${new Date().getFullYear()} ${brand}</span>
              </td>
            </tr>
          </table>

          <!-- small spacer -->
          <div style="height:20px;line-height:20px;">&nbsp;</div>
        </td>
      </tr>
    </table>
  </div>
  `;
}

function renderInternalEmailHTML(cfg, session) {
  const money = v => `$${(v/100).toFixed(2)}`;
  const lines = [
    `Stripe Session: ${session.id}`,
    `Customer: ${session.customer_details?.email || 'N/A'}`,
    `Total: ${money(session.amount_total || 0)} ${String(session.currency || 'usd').toUpperCase()}`,
    `ZIP: ${cfg?.zip || 'N/A'}`,
    `Shape: ${cfg?.shape || 'N/A'}`,
    `Dims: ${cfg?.dims ? JSON.stringify(cfg.dims) : 'N/A'}`,
    `Sinks: ${(cfg?.sinks || []).length}`,
    `Edges: ${(cfg?.edges || []).join(', ') || 'None'}`,
    `Backsplash: ${cfg?.backsplash ? 'Yes' : 'No'}`,
    `Color: ${cfg?.color || 'N/A'}`,
    `Faucets:\n${sinksFaucetList(cfg)}`
  ];

  return `
  <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:16px;color:#111">
    <div style="padding:12px 0 16px;border-bottom:2px solid #eee;display:flex;align-items:center;gap:10px">
      <div style="width:10px;height:10px;background:#111;border-radius:2px"></div>
      <div style="font-size:18px;font-weight:800">NEW RCG ORDER</div>
    </div>
    <pre style="white-space:pre-wrap;background:#fafafa;border:1px solid #eee;padding:12px 14px;margin:14px 0;font-size:13px;line-height:1.4">${lines.join('\n')}</pre>
  </div>
  `;
}

// ---------- Stripe Webhook (must stay BEFORE express.json) ----------
app.post(
  '/api/checkout-webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
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

          // ---- Reassemble compact config from Stripe metadata ----
          const md = session.metadata || {};
          let config = null;
          try {
            config = reassembleCfgFromMeta(md);
          } catch {
            config = null;
          }

          // ---- Friendly fields for emails ----
          const orderId = session.id;
          const currency = String(session.currency || 'usd').toUpperCase();
          const orderTotalUSD = ((session.amount_total || 0) / 100).toFixed(2);

          // NEW: robust customer email lookup (helper you added above)
          // Also fall back to metadata if present.
          const customerEmail =
            (await getCustomerEmailFromSession(session)) ||
            md.customer_email ||
            md.email ||
            '';

          // ================== INTERNAL EMAIL (orders@) ==================
          try {
  const shortId = orderId.replace('cs_test_', '').replace('cs_live_', '').slice(0, 10);

  const internalSubject =
    `${process.env.NODE_ENV === 'production' ? '' : '[TEST] '}New Order — ${shortId}`;

  const internalHtml = `
  <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;background:#ffffff">
    <div style="padding:20px 0;text-align:center;border-bottom:2px solid #eee">
      <img src="https://cdn.prod.website-files.com/634cb6e50d8312e63b8d5ee1/67a16defcff775964e6f48ed_RCG_consumerLogo.svg"
           alt="Rock Creek Granite"
           style="height:48px" />
    </div>

    <div style="padding:20px">
      <h2 style="margin:0 0 14px;font-size:18px;color:#111">
        New Countertop Order
      </h2>

      <div style="background:#fafafa;border:1px solid #eee;padding:14px">
        <div><strong>Order ID:</strong> ${shortId}</div>
        <div><strong>Stripe Session:</strong> ${orderId}</div>
        <div><strong>Customer:</strong> ${customerEmail || 'N/A'}</div>
        <div><strong>Total:</strong> $${orderTotalUSD} ${currency}</div>
        <div><strong>ZIP:</strong> ${config?.zip || 'N/A'}</div>
        <div><strong>Shape:</strong> ${config?.shape || 'N/A'}</div>
        <div><strong>Stone:</strong> ${config?.color || 'N/A'}</div>
        <div><strong>Sinks:</strong> ${(config?.sinks || []).length}</div>
        <div><strong>Edges:</strong> ${(config?.edges || []).join(', ') || 'None'}</div>
        <div><strong>Backsplash:</strong> ${config?.backsplash ? 'Yes' : 'No'}</div>
      </div>

      <p style="margin-top:18px;font-size:13px;color:#666">
        This order was generated via the online configurator.
      </p>
    </div>
  </div>
  `;

  const dxfAttachment = makeDxfAttachmentFromConfig(config, shortId);

  await sendEmail({
    to: process.env.ORDER_NOTIFY_EMAIL || 'orders@rockcreekgranite.com',
    subject: internalSubject,
    html: internalHtml,
    text: `New order ${shortId}\nCustomer: ${customerEmail}\nTotal: $${orderTotalUSD} ${currency}`,
    attachments: dxfAttachment ? [dxfAttachment] : [],
    replyTo: process.env.ORDER_NOTIFY_EMAIL || 'orders@rockcreekgranite.com',
  });

  console.log('[mail] internal branded order email sent');
} catch (e) {
  console.error('[mail] internal order email failed:', e);
}

// ================== CUSTOMER EMAIL (designed) ==================
const isValidEmail = (s) => /.+@.+\..+/.test(String(s || '').trim());

if (isValidEmail(customerEmail)) {
  try {
    const customerSubject = `${
      process.env.NODE_ENV === 'production' ? '' : '[TEST] '
    }Thanks! We received your order — ${orderId}`;

    // HTML comes from your template function (paste the new template into that function)
    const customerHtml = renderCustomerEmailHTML(config, session);

    // Plain-text fallback (helps deliverability + non-HTML clients)
    const customerText =
      `Thanks — we received your order!\n\n` +
      `Order #: ${orderId}\n` +
      `Total: $${orderTotalUSD} ${currency}\n` +
      `Ship ZIP: ${config?.zip || md.zip || 'N/A'}\n` +
      `Shape: ${config?.shape || 'N/A'}\n`;

    await sendEmail({
      to: customerEmail, // sends to the purchaser
      subject: customerSubject,
      html: customerHtml,
      text: customerText,
      replyTo: process.env.ORDER_NOTIFY_EMAIL || 'orders@rockcreekgranite.com',
    });

    console.log('[mail] customer email sent ->', customerEmail);
  } catch (e) {
    console.error('[mail] customer email failed:', e);
  }
} else {
  console.log('[mail] no valid customer email found; skipping customer send', {
    session_id: orderId,
    customerEmail,
    has_customer_details: !!session.customer_details,
    session_customer: session.customer || null,
  });
}
          // ---- Log compact summary
          console.log('[stripe] checkout.session.completed', {
            id: orderId,
            email: customerEmail || '(none)',
            amount_total: session.amount_total,
            cfg_summary: config ? { shape: config.shape, zip: config?.zip || md.zip || '' } : null
          });

          break;
        }

        default: {
          if (process.env.NODE_ENV !== 'production') {
            console.log(`[stripe] ${event.type}`);
          }
        }
      }
    } catch (e) {
      console.error('Webhook handler error:', e);
      return res.sendStatus(500);
    }

    // Always acknowledge the webhook
    res.json({ received: true });
  }
);

// ---------------------------- CORS + JSON (after webhook) ---------------------
const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    const ok = ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin);
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '5mb' })); // after webhook raw

// ---------------------------- API: Create Checkout Session --------------------
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

    // compact metadata (no pricing); include sink cutout sizes & types + faucet params
    const compactCfg = {
      shape: config.shape,
      dims: config.dims,
      sinks: Array.isArray(config.sinks)
        ? config.sinks.map(s => ({
            key: s.key,
            type: s.type,               // 'rect' | 'oval' if provided by client
            cutoutW: s.cutoutW,         // inches (optional)
            cutoutH: s.cutoutH,         // inches (optional)
            x: Number(s.x?.toFixed?.(2) ?? s.x),
            y: Number(s.y?.toFixed?.(2) ?? s.y),
            faucet: s.faucet ?? 1,
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

// ---------------------------- API: Read a Checkout Session --------------------
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

// ---------------------------- API: Email DXF (client-provided base64) ---------
app.post('/api/email-dxf', async (req, res) => {
  try {
    const { to, bcc, subject, config, dxfBase64 } = req.body || {};
    if (!to || !dxfBase64) return res.status(400).json({ error: 'Missing to or dxfBase64' });

    const dimsTxt =
      config?.shape === 'rectangle'
        ? `${config?.dims?.L}" × ${config?.dims?.W}"`
        : config?.shape === 'circle'
        ? `${config?.dims?.D}" Ø`
        : (config?.shape ? `${config?.dims?.n}-sides, ${config?.dims?.A}" side` : 'N/A');

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;padding:16px;color:#111;">
        <h2 style="margin:0 0 12px;">${MAIL_FROM_NAME} — DXF attached</h2>
        <p style="margin:0 0 10px;">Auto-generated DXF cut sheet is attached.</p>
        <ul style="margin:0;padding-left:16px">
          <li>Shape: ${config?.shape || 'N/A'}</li>
          <li>Size: ${dimsTxt}</li>
        </ul>
      </div>`;
    const text = `DXF attached.\nShape: ${config?.shape || 'N/A'}\nSize: ${dimsTxt}\n`;

    const att = { filename: 'RCG_CutSheet.dxf', content: dxfBase64 };

    await sendEmail({ to, subject: subject || 'RCG DXF', html, text, attachments: [att] });
    if (bcc) {
      await sendEmail({ to: bcc, subject: subject || 'RCG DXF (copy)', html, text, attachments: [att] });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('email-dxf failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------- API: Email DXF from URL -------------------------
app.post('/api/email-dxf-from-url', async (req, res) => {
  try {
    const { to, bcc, subject, config, dxfUrl } = req.body || {};
    if (!to || !dxfUrl) return res.status(400).json({ error: 'Missing "to" or "dxfUrl"' });

    const r = await fetch(dxfUrl);
    if (!r.ok) return res.status(400).json({ error: `Unable to fetch DXF: ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    const base64 = buf.toString('base64');

    const summary =
      `Shape: ${config?.shape}\n` +
      `Size: ${JSON.stringify(config?.dims)}\n` +
      `Polished: ${Array.isArray(config?.edges) ? config.edges.join(', ') : 'None'}\n` +
      `Backsplash: ${config?.backsplash ? 'Yes' : 'No'}\n` +
      `Sinks: ${(config?.sinks || []).length}`;

    await sendEmail({
      to,
      bcc,
      subject: subject || 'RCG DXF',
      text: `Attached is your DXF cut sheet.\n\n${summary}`,
      html: `<pre style="font-family:monospace;white-space:pre-wrap">${summary}</pre>`,
      attachments: [{ filename: 'RCG_CutSheet.dxf', content: base64 }],
      replyTo: ORDER_NOTIFY_EMAIL,
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('email-dxf-from-url failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------- Diagnostics & Health ----------------------------
app.get('/.well-known/mail-debug', async (req, res) => {
  try {
    if (MAIL_MODE !== 'resend-api') return res.status(500).json({ ok:false, error: 'RESEND_API_KEY missing' });
    const to = req.query.to || ORDER_NOTIFY_EMAIL;
    const r = await sendEmail({
      to,
      subject: '[RCG] Mail debug OK',
      text: 'This is a test email from /.well-known/mail-debug',
      html: '<strong>Mail debug OK</strong>',
    });
    res.json({ ok: true, to, r });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
});

app.get('/.well-known/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get('/', (_req, res) => res.type('text/plain').send('ok'));

// ---------------------------- Start -------------------------------------------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});