// server.js — Express + Stripe Checkout + Webhook + Resend email (ESM)
// Requires package.json: { "type": "module" }

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';

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

// allowed origins: comma-separated
const defaultAllowed = [FRONTEND_URL, FRONTEND_URL.replace('www.', '')]
  .filter((v, i, a) => a.indexOf(v) === i);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : defaultAllowed).map(s => s.trim()).filter(Boolean);

// Stripe
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
if (!STRIPE_SECRET_KEY) console.warn('[WARN] STRIPE_SECRET_KEY not set');
const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// Webhook secret
if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('[WARN] STRIPE_WEBHOOK_SECRET not set');

// Resend (mail) — HTTP API only (no SMTP here)
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

// metadata chunking (stay under Stripe 500-char limit per value)
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

// ---------------------------- Mail (Resend HTTP) ------------------------------
/**
 * sendEmail({ to, bcc, subject, text, html, attachments?, replyTo? })
 * attachments: [{ filename, content (base64) }]
 */
async function sendEmail({ to, bcc, subject, text, html, attachments = [], replyTo }) {
  if (MAIL_MODE !== 'resend-api') {
    throw new Error('RESEND_API_KEY missing; cannot send email');
  }
  // Format "to" to pass Resend validation
  const toList = Array.isArray(to) ? to : [to];
  const formattedTo = toList
    .filter(Boolean)
    .map(addr => /<.+@.+>/.test(addr) || /.+@.+\..+/.test(addr) ? addr : null)
    .filter(Boolean);

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
  const money = v => `$${(v/100).toFixed(2)}`;
  const total = session.amount_total || 0;
  const zip = (cfg?.zip || '').toString();
  const dims = cfg?.shape === 'rectangle'
    ? `${cfg?.dims?.L}" × ${cfg?.dims?.W}"`
    : (cfg?.shape === 'circle'
      ? `${cfg?.dims?.D}" Ø`
      : `${cfg?.dims?.n}-sides, ${cfg?.dims?.A}" side`);
  const edges = (cfg?.edges || []).join(', ') || 'None';
  const sinks = (cfg?.sinks || []).length;

  return `
  <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:16px;color:#111">
    <div style="padding:12px 0 16px;border-bottom:2px solid #eee;display:flex;align-items:center;gap:10px">
      <div style="width:10px;height:10px;background:#ffc400;border-radius:2px"></div>
      <div style="font-size:18px;font-weight:700">Rock Creek Granite — Order Confirmation</div>
    </div>
    <p style="font-size:15px;line-height:1.5;margin:16px 0">Thanks for your order! We’ve received your payment and started your fabrication ticket.</p>
    <div style="background:#fafafa;border:1px solid #eee;padding:12px 14px;margin:12px 0">
      <div><strong>Stripe Session:</strong> ${session.id}</div>
      <div><strong>Total Paid:</strong> ${money(total)}</div>
      <div><strong>Ship ZIP:</strong> ${zip}</div>
      <div><strong>Shape:</strong> ${cfg?.shape || 'N/A'}</div>
      <div><strong>Size:</strong> ${dims || 'N/A'}</div>
      <div><strong>Polished edges:</strong> ${edges}</div>
      <div><strong>Sinks:</strong> ${sinks}</div>
      <div><strong>Backsplash:</strong> ${cfg?.backsplash ? 'Yes' : 'No'}</div>
      <div><strong>Stone:</strong> ${cfg?.color || 'N/A'}</div>
    </div>
    <p style="font-size:14px;color:#333">We’ll follow up with your production timeline and shipping details shortly.</p>
    <p style="font-size:13px;color:#666;margin-top:22px">Questions? Reply to this email or call (555) 555-5555.</p>
  </div>`;
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
  ];
  return `
  <div style="font-family:Arial,sans-serif;max-width:680px;margin:0 auto;padding:16px;color:#111">
    <div style="padding:12px 0 16px;border-bottom:2px solid #eee;display:flex;align-items:center;gap:10px">
      <div style="width:10px;height:10px;background:#111;border-radius:2px"></div>
      <div style="font-size:18px;font-weight:800">NEW RCG ORDER</div>
    </div>
    <pre style="white-space:pre-wrap;background:#fafafa;border:1px solid #eee;padding:12px 14px;margin:14px 0;font-size:13px;line-height:1.4">${lines.join('\n')}</pre>
  </div>`;
}

// ------------------- Scaled DXF with splash, polished edges & cutouts ---------

// Default sink sizes (inches). If the client passes sizes, those override.
// We shrink each dimension by 0.5" for the actual cutout.
const DEFAULT_SINK_SIZES = {
  'bath-oval':   { w: 17, h: 14, type: 'oval' },
  'bath-rect':   { w: 18, h: 13, type: 'rect' },
  'kitchen-rect':{ w: 22, h: 16, type: 'rect' },
};

function getSinkCutoutDims(sink) {
  // If client provided explicit cutout dims, prefer them
  const w0 = Number(sink?.cutoutW || sink?.w || 0);
  const h0 = Number(sink?.cutoutH || sink?.h || 0);
  const t0 = sink?.type;
  if (w0 > 0 && h0 > 0) {
    return { w: Math.max(0, w0 - 0.5), h: Math.max(0, h0 - 0.5), type: t0 || 'rect' };
  }
  // Otherwise fallback to defaults by key
  const d = DEFAULT_SINK_SIZES[sink?.key] || null;
  if (!d) return null;
  return { w: Math.max(0, d.w - 0.5), h: Math.max(0, d.h - 0.5), type: d.type };
}

// --- Scaled DXF generator: 1:1 inches; draws outline, OUTSIDE 4" backsplash with 1" gap,
//     polished edges, and sink cutouts (oval/rect) on proper layers.
function makeDxfAttachmentFromConfig(cfg, orderId = 'order') {
  try {
    const ENT = [];
    const push = (...a) => { for (const v of a) ENT.push(String(v)); };

    // Header with inches
    const header = [
      '0','SECTION','2','HEADER',
      '9','$INSUNITS','70','1', // 1 = Inches
      '0','ENDSEC',
      '0','SECTION','2','ENTITIES'
    ];

    const addRectOutline = (x0,y0,w,h,layer,closed=true) => {
      const n = 4;
      push('0','LWPOLYLINE','8',layer,'90',n,'70', closed ? '1' : '0',
           '10',x0,'20',y0,
           '10',x0+w,'20',y0,
           '10',x0+w,'20',y0+h,
           '10',x0,'20',y0+h);
    };
    const addLine = (x1,y1,x2,y2,layer) => {
      push('0','LINE','8',layer,'10',x1,'20',y1,'11',x2,'21',y2);
    };
    const addEllipse = (cx,cy,rx,ry,layer) => {
      const major = rx >= ry ? rx : ry;
      const ratio = major ? ((rx>=ry ? ry : rx) / major) : 1;
      const majorX = (rx >= ry) ? major : 0;
      const majorY = (rx >= ry) ? 0 : major;
      push('0','ELLIPSE','8',layer,
           '10',cx,'20',cy,'30','0',
           '11',majorX,'21',majorY,'31','0',
           '40',ratio,'41','0','42',String(2*Math.PI));
    };

    let drewAnything = false;

    if (cfg?.shape === 'rectangle') {
      const L = Math.max(0, Number(cfg?.dims?.L) || 0);
      const W = Math.max(0, Number(cfg?.dims?.W) || 0);
      // Slab outline (origin bottom-left)
      addRectOutline(0, 0, L, W, 'OUTLINE', true);
      drewAnything = true;

      // Polished edges (draw lines along polished sides)
      const edges = Array.isArray(cfg?.edges) ? cfg.edges : [];
      if (edges.includes('bottom')) addLine(0, 0, L, 0, 'POLISHED');
      if (edges.includes('top'))    addLine(0, W, L, W, 'POLISHED');
      if (edges.includes('left'))   addLine(0, 0, 0, W, 'POLISHED');
      if (edges.includes('right'))  addLine(L, 0, L, W, 'POLISHED');

      // OUTSIDE 4" backsplash with 1" gap on *unpolished* sides
      // gap = 1", depth = 4"
      if (cfg?.backsplash) {
        const GAP = 1, DEPTH = 4;
        const unpol = ['top','right','bottom','left'].filter(k => !edges.includes(k));
        for (const side of unpol) {
          if (side === 'bottom') addRectOutline(0, -(GAP+DEPTH), L, DEPTH, 'BACKSPLASH');        // y: -5..-1
          if (side === 'top')    addRectOutline(0, W + GAP,      L, DEPTH, 'BACKSPLASH');        // y: W+1..W+5
          if (side === 'left')   addRectOutline(-(GAP+DEPTH), 0, DEPTH, W, 'BACKSPLASH');        // x: -5..-1
          if (side === 'right')  addRectOutline(L + GAP, 0,      DEPTH, W, 'BACKSPLASH');        // x: L+1..L+5
        }
      }

      // Sink cutouts on layer CUTOUT
      const sinks = Array.isArray(cfg?.sinks) ? cfg.sinks : [];
      for (const s of sinks) {
        const cx = Number(s?.x);
        const cy = Number(s?.y);
        if (!isFinite(cx) || !isFinite(cy)) continue;

        const dims = getSinkCutoutDims(s);
        if (!dims || dims.w <= 0 || dims.h <= 0) continue;

        if (dims.type === 'oval') {
          const rx = dims.w / 2;
          const ry = dims.h / 2;
          addEllipse(cx, cy, rx, ry, 'CUTOUT');
        } else {
          const x0 = cx - dims.w / 2;
          const y0 = cy - dims.h / 2;
          addRectOutline(x0, y0, dims.w, dims.h, 'CUTOUT');
        }
      }
    } else if (cfg?.shape === 'circle') {
      const D = Math.max(0, Number(cfg?.dims?.D) || 0);
      const R = D / 2;
      addEllipse(R, R, R, R, 'OUTLINE');
      drewAnything = true;
    } else if (cfg?.shape === 'polygon') {
      const n = Math.max(3, Number(cfg?.dims?.n) || 0);
      const s = Math.max(0, Number(cfg?.dims?.A) || 0);
      if (n >= 3 && s > 0) {
        const R = s / (2 * Math.sin(Math.PI / n));
        const verts = [];
        for (let i = 0; i < n; i++) {
          const ang = (2 * Math.PI * i) / n;
          const x = R * Math.cos(ang);
          const y = R * Math.sin(ang);
          verts.push([x, y]);
        }
        const minX = Math.min(...verts.map(v => v[0]));
        const minY = Math.min(...verts.map(v => v[1]));
        const shifted = verts.map(([x,y]) => [x - minX, y - minY]);

        push('0','LWPOLYLINE','8','OUTLINE','90',n,'70','1');
        for (const [x,y] of shifted) push('10',x,'20',y);
        drewAnything = true;
      }
    }

    if (!drewAnything) {
      const label = `RCG ORDER — ${cfg?.shape || 'N/A'}`;
      push('0','TEXT','8','0','10','0','20','0','40','1','1',label);
    }

    const footer = ['0','ENDSEC','0','EOF'];
    const dxf = header.concat(ENT).concat(footer).join('\n');

    // Shortened order id in filename
    const shortId = String(orderId || 'order').replace(/[^A-Za-z0-9_-]+/g, '').slice(-8) || 'order';
    return {
      filename: `RCG_Order_${shortId}.dxf`,
      content: Buffer.from(dxf, 'utf8').toString('base64')
    };
  } catch {
    return null;
  }
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

          // -------- Reassemble compact config from Stripe metadata --------
          const md = session.metadata || {};
          const parts = Number(md.cfg_parts || 0);
          let cfgB64 = md.cfg || '';
          if (!cfgB64 && parts > 0) {
            let joined = '';
            for (let i = 1; i <= parts; i++) joined += md[`cfg_${i}`] || '';
            cfgB64 = joined;
          }
          let config = null;
          try { config = cfgB64 ? JSON.parse(Buffer.from(cfgB64, 'base64').toString('utf8')) : null; }
          catch { config = null; }

          // -------- Friendly fields for emails --------
          const orderId = session.id;
          const orderTotalUSD = (session.amount_total / 100).toFixed(2);
          const currency = String(session.currency || 'usd').toUpperCase();
          const customerEmail = session.customer_details?.email || '';
          const customerName = session.customer_details?.name || '';
          const zip = config?.zip || md.zip || '';

          const dimsTxt =
            config?.shape === 'rectangle'
              ? `${config?.dims?.L}" × ${config?.dims?.W}"`
              : config?.shape === 'circle'
              ? `${config?.dims?.D}" Ø`
              : config?.shape
              ? `${config?.dims?.n}-sides, ${config?.dims?.A}" side`
              : 'N/A';

          const brandName = process.env.MAIL_FROM_NAME || 'Rock Creek Granite';

          // --- Email bodies
          const internalSubject = `${process.env.NODE_ENV === 'production' ? '' : '[TEST] '}Order confirmed — ${orderId}`;
          const internalHtml = renderInternalEmailHTML(config || {}, session);
          const internalText =
            `New order confirmed\n\n` +
            `Stripe Session: ${orderId}\n` +
            `Customer: ${customerEmail || 'N/A'}\n` +
            `Total: $${orderTotalUSD} ${currency}\n` +
            `ZIP: ${zip || 'N/A'}\n` +
            `Shape: ${config?.shape || 'N/A'}\n` +
            `Size: ${dimsTxt}\n` +
            `Sinks: ${config?.sinks?.length || 0}\n` +
            `Edges: ${Array.isArray(config?.edges) ? config.edges.join(', ') : 'None'}\n` +
            `Backsplash: ${config?.backsplash ? 'Yes' : 'No'}\n`;

          // -------- Attach DXF (generated server-side)
          const dxfAttachment = makeDxfAttachmentFromConfig(config, orderId);

          // ================== INTERNAL EMAIL ==================
          try {
            await sendEmail({
              to: ORDER_NOTIFY_EMAIL,
              subject: internalSubject,
              html: internalHtml,
              text: internalText,
              attachments: dxfAttachment ? [dxfAttachment] : []
            });
            console.log('[mail] internal order email sent', dxfAttachment ? 'with DXF' : '(no DXF)');
          } catch (e) {
            console.error('[mail] internal order email failed:', e);
          }

          // ================== CUSTOMER EMAIL ==================
          if (customerEmail) {
            try {
              await sendEmail({
                to: customerEmail,
                subject: `${process.env.NODE_ENV === 'production' ? '' : '[TEST] '}Thanks! We received your order — ${orderId}`,
                html: renderCustomerEmailHTML(config || {}, session),
                text:
                  `Thanks — we received your order!\n\n` +
                  `Order #: ${orderId}\n` +
                  `Total: $${orderTotalUSD} ${currency}\n` +
                  `Ship ZIP: ${zip || 'N/A'}\n` +
                  `Shape: ${config?.shape || 'N/A'}\n` +
                  `Size: ${dimsTxt}\n` +
                  `Sinks: ${config?.sinks?.length || 0}\n` +
                  `Backsplash: ${config?.backsplash ? 'Yes' : 'No'}\n`
              });
              console.log('[mail] customer email sent ->', customerEmail);
            } catch (e) {
              console.error('[mail] customer email failed:', e);
            }
          } else {
            console.log('[mail] no customer email on session; skipping customer send');
          }

          // -------- Log compact summary
          console.log('[stripe] checkout.session.completed', {
            id: orderId,
            email: customerEmail,
            amount_total: session.amount_total,
            cfg_summary: config ? { shape: config.shape, zip } : null
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

    // Compact metadata (no pricing). If the embed includes per-sink cutout sizes/types,
    // keep them so server doesn't need updates when sizes change in the client.
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
            // optional (if provided by the configurator):
            cutoutW: s.cutoutW ?? s.w ?? undefined,
            cutoutH: s.cutoutH ?? s.h ?? undefined,
            type: s.type ?? undefined // 'oval' | 'rect'
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
        : (config?.shape
            ? `${config?.dims?.n}-sides, ${config?.dims?.A}" side`
            : 'N/A');

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;padding:16px;color:#111;">
        <h2 style="margin:0 0 12px;">Rock Creek Granite — DXF attached</h2>
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
      try {
        await sendEmail({ to: bcc, subject: subject || 'RCG DXF (copy)', html, text, attachments: [att] });
      } catch (e) {
        console.error('[mail] DXF email bcc failed:', e);
      }
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
    const r = await sendEmail({ to, subject: '[RCG] Mail debug OK', text: 'This is a test', html: '<strong>Mail debug OK</strong>' });
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
