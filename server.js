// server.js — Express + Stripe Checkout + Webhook + Email DXF (ESM)
// Requires package.json: { "type": "module" }


import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import nodemailer from 'nodemailer';


// ---------------- Helpers (metadata chunking to avoid 500-char Stripe limit) ----------------
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
try {
return JSON.parse(Buffer.from(md.cfg, 'base64').toString('utf8'));
} catch {
return null;
}
}
const parts = Number(md.cfg_parts || 0);
if (!parts) return null;
let joined = '';
for (let i = 1; i <= parts; i++) joined += md[`cfg_${i}`] || '';
try {
return JSON.parse(Buffer.from(joined, 'base64').toString('utf8'));
} catch {
return null;
}
}


// ---------------- Env & App ----------------
const PORT = process.env.PORT || 3000;
const DEFAULT_FRONTEND = 'https://www.rockcreekgranite.com';
const FRONTEND_URL = process.env.FRONTEND_URL || DEFAULT_FRONTEND;
const DEFAULT_ALLOWED = [FRONTEND_URL, FRONTEND_URL.replace('www.', '')];
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
? process.env.ALLOWED_ORIGINS.split(',')
: DEFAULT_ALLOWED)
.map((s) => s.trim())
.filter(Boolean);


if (!process.env.STRIPE_SECRET_KEY) console.warn('[WARN] STRIPE_SECRET_KEY not set');
if (!process.env.STRIPE_WEBHOOK_SECRET) console.warn('[WARN] STRIPE_WEBHOOK_SECRET not set');
if (!process.env.SMTP_HOST && !process.env.RESEND_API_KEY) {
console.warn('[WARN] No SMTP creds or RESEND_API_KEY set — /api/email-dxf will fail.');
}