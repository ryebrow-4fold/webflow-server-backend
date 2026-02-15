/* =============================
   RCG CONFIGURATOR (External JS) — SINGLE FILE
   - Mounts into: <div id="rcg-configurator-launch"></div>
   - Desktop: inline (no modal)
   - Mobile: scroll-revealed launch button -> fullscreen modal
   - Endpoints:
       - Checkout redirect: /config-checkout?cfg=...
       - Email DXF: POST /api/email-dxf
============================= */

(() => {
  // -----------------------------
  // Guard: don’t mount twice
  // -----------------------------
  if (window.__RCG_CONFIGURATOR_MOUNTED__) return;
  window.__RCG_CONFIGURATOR_MOUNTED__ = true;

  // -----------------------------
  // Mount element
  // -----------------------------
  const mount = document.getElementById('rcg-configurator-launch');
  if (!mount) {
    console.warn('[RCG] Missing #rcg-configurator-launch mount element.');
    return;
  }

  // Optional: allow logo via mount data attr
  // <div id="rcg-configurator-launch" data-logo="https://.../logo.png"></div>
  const LOGO_URL = mount.dataset.logo || '';

  // -----------------------------
  // Admin knobs
  // -----------------------------
  const MAX_LEN = 72;         // Rect L (in)
  const MAX_WID = 62;         // Rect W (in)
  const MAX_DIAM = 62;        // Circle Ø & polygon circumdiameter cap
  const MIN_SINK_EDGE = 4;    // min distance from piece edge (in)
  const MIN_SINK_GAP = 4;     // min distance between sinks (in)
  const DOLLARS_PER_SQFT = 55;
  const SINK_PRICES = { 'bath-oval': 80, 'bath-rect': 95, 'kitchen-rect': 150 };
  const DEFAULT_COLOR = 'bergen';
  const LBS_PER_SQFT = 10.9;
  const LTL_CWT_BASE = 35.9;
  const BUSINESS_EMAIL = 'orders@rockcreekgranite.com';
  const ORIGIN_ZIP_DEFAULT = mount.dataset.originZip || '63052';

  const DISTANCE_BANDS = [
    { max: 250,  mult: 1.00 },
    { max: 600,  mult: 1.25 },
    { max: 1000, mult: 1.50 },
    { max: 1500, mult: 1.70 },
    { max: Infinity, mult: 1.85 }
  ];

  const SECTION_TITLES = {
    1: 'Define your shape',
    2: 'Choose Polished Sides',
    3: 'Add Sinks & Faucet Holes',
    4: 'Select Stone & Ship'
  };

  // Cosentino swatches
  const COLORS = [
    { key: "laurent", name: "Laurent", url: "https://assetstools.cosentino.com/api/v1/bynder/color/PTL/detalle/PTL-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format" },
    { key: "rem",     name: "Rem",     url: "https://assetstools.cosentino.com/api/v1/bynder/color/RKC/detalle/RKC-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format" },
    { key: "bergen",  name: "Bergen",  url: "https://assetstools.cosentino.com/api/v1/bynder/color/BEK/detalle/BEK-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format" },
    { key: "kreta",   name: "Kreta",   url: "https://assetstools.cosentino.com/api/v1/bynder/color/KRE/detalle/KRE-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format" },
    { key: "sirius",  name: "Sirius",  url: "https://assetstools.cosentino.com/api/v1/bynder/color/RS5/detalle/RS5-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format" },
    { key: "kairos",  name: "Kairos",  url: "https://assetstools.cosentino.com/api/v1/bynder/color/KKC/detalle/KKC-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format" }
  ];

  const SINK_TEMPLATES = {
    'bath-oval':    { label: 'Bath Oval (17×14)',          w: 17, h: 14, shape: 'oval' },
    'bath-rect':    { label: 'Bath Rectangle (18×13)',     w: 18, h: 13, shape: 'rect' },
    'kitchen-rect': { label: 'Kitchen Stainless (22×16)',  w: 22, h: 16, shape: 'rect' }
  };

  // -----------------------------
  // Utilities
  // -----------------------------
  const el  = (sel, root=document) => root.querySelector(sel);
  const els = (sel, root=document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const fmt2 = (v) => (isFinite(v) ? Number(v).toFixed(2) : '0.00');
  const isMobile = () => window.matchMedia('(max-width: 980px)').matches;
  const isDesktop = () => window.matchMedia('(min-width: 981px)').matches;

  function areaSqft(shape, d) {
    switch (shape) {
      case 'rectangle': return (d.L * d.W) / 144;
      case 'circle':    return Math.PI * Math.pow(d.D / 2, 2) / 144;
      case 'polygon': {
        const n = d.n || 6, s = d.A || 12;
        const areaIn2 = (n * s * s) / (4 * Math.tan(Math.PI / n));
        return areaIn2 / 144;
      }
      default: return 0;
    }
  }

  function polyCircumDiam(n, s) {
    const R = s / (2 * Math.sin(Math.PI / n));
    return 2 * R;
  }

  function distanceBand(originZip, destZip) {
    const o = parseInt(String(originZip || ORIGIN_ZIP_DEFAULT).slice(0, 3), 10);
    const d = parseInt(String(destZip || '00000').slice(0, 3), 10);
    const approxMiles = Math.abs(o - d) * 20 + 100;
    return DISTANCE_BANDS.find(b => approxMiles <= b.max).mult;
  }

  function shippingEstimate(area, destZip, originZip = ORIGIN_ZIP_DEFAULT) {
    const weight = area * LBS_PER_SQFT;
    const cwt = Math.max(1, Math.ceil(weight / 100));
    const mult = distanceBand(originZip, destZip);
    const base = cwt * LTL_CWT_BASE * mult;
    const withPacking = base * 1.20;
    return { weight, cwt, mult, ltl: withPacking };
  }

  // -----------------------------
  // Render shell:
  // - Desktop inline container
  // - Mobile launch + modal container
  // - Single app DOM moved between inline & modal
  // -----------------------------
  mount.innerHTML = `
    <style>
      :root {
        --rcg-black:#0b0b0b;
        --rcg-yellow:#ffc400;
        --rcg-gray:#f3f3f0;
        --rcg-muted:#6b7280;
        --rcg-danger:#c1121f;
      }
      .rcg-root, .rcg-root * {
        font-family: 'Barlow', system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        box-sizing: border-box;
        border-radius: 0 !important;
      }

      /* -------- Desktop inline container (always visible on desktop) -------- */
      .rcg-inline-host{
        width:100%;
        position:relative;
      }

      /* -------- Mobile launch button (hidden until scrolled to section) -------- */
      .rcg-launch-wrap{
        width:100%;
        display:none;
        justify-content:center;
        margin: 10px 0 0;
      }
      .rcg-launch{
        background: var(--rcg-yellow);
        color:#000;
        font-weight:800;
        padding:14px 18px;
        border:none;
        cursor:pointer;
        width: min(520px, 100%);
        font-size: 16px;
      }
      .rcg-launch-wrap.rcg-visible{ display:flex; }

      /* -------- Mobile modal overlay -------- */
      .rcg-modal {
        position: fixed; inset: 0;
        z-index: 999999;
        background: rgba(0,0,0,.65);
        display: none;
        padding: 0;
      }
      .rcg-modal[aria-hidden="false"]{ display:flex; }
      .rcg-window {
        background: #fff;
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      /* Mobile top bar (white) */
      .rcg-topbar{
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding:10px 12px;
        background: #fff;
        color: #111;
        border-bottom: 1px solid #e6e6e6;
        gap:10px;
      }
      .rcg-topbar .left{ display:flex; align-items:center; gap:10px; min-width: 0; }
      .rcg-topbar .title{
        font-weight:800;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        max-width: 55vw;
        font-size: 14px;
      }
      .rcg-topbar .meta{
        font-size:12px;
        color: #555;
        white-space:nowrap;
      }
      .rcg-logo{
        width: 28px; height: 28px;
        object-fit: contain;
        display:none;
      }
      .rcg-logo.rcg-has{ display:block; }
      .rcg-close{
        appearance:none;
        border:1px solid rgba(0,0,0,.2);
        background: transparent;
        color:#111;
        padding:6px 10px;
        cursor:pointer;
        font-weight:700;
      }

      /* App layout (shared for desktop + mobile) */
      .rcg-app{
        width:100%;
        position: relative;
      }
      .rcg-body{
        width:100%;
        display:flex;
        flex-direction:column;
        min-height: 720px;
        position: relative;
        background:#fff;
        border: 1px solid #e5e5e5;
      }
      .rcg-preview{
        flex: 1;
        min-height: 0;
        background:#fff;
        position: relative;
        overflow: hidden;
        padding-bottom: calc(var(--rcg-sheet-h, 0px) * 0.55); /* mobile: reserve for bottom sheet */

}
      }
      .rcg-stage{
        width:100%;
        height:100%;
        display:block;
        touch-action: none;
      }

      .rcg-panel{
        background: var(--rcg-gray);
        padding: 12px;
        line-height: 1.2;
      }

      /* Panel header (drag handle on desktop) */
      .rcg-panel-handle{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        padding:10px 10px;
        background:#fff;
        border:1px solid #cfcfcf;
        margin-bottom:10px;
        user-select:none;
      }
      .rcg-panel-handle.desktop-draggable{ cursor: grab; }
      .rcg-panel-handle.desktop-draggable:active{ cursor: grabbing; }
      .rcg-panel-handle .step{ font-weight:800; min-width:0; }
      .rcg-panel-handle .step small{
        font-weight:700;
        color: var(--rcg-muted);
        margin-left:6px;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        max-width: 260px;
        display:inline-block;
        vertical-align:bottom;
      }

      .rcg-btn { background: var(--rcg-yellow); color:#000; font-weight:800; padding:10px 16px; border: none; cursor:pointer; }
      .rcg-btn[disabled]{ opacity: .5; cursor: not-allowed; }
      .rcg-btn.outline { background:#fff; color:#000; border:1px solid #000; }

      .rcg-title { font-size: 22px; font-weight:800; margin:0 0 8px; color:var(--rcg-black); display:flex; align-items:center; gap:8px }
      .rcg-sub { color: var(--rcg-muted); font-size: 13px; margin: 6px 0; line-height:1.2; font-weight:500 }
      .rcg-row { display:flex; gap:10px; align-items:center; flex-wrap:wrap }
      .rcg-input { width:110px; padding:8px 10px; border:1px solid #cfcfcf; background:#fff; color:var(--rcg-black); font-weight:600 }
      .rcg-input.invalid { color: var(--rcg-danger); border-color: var(--rcg-danger); }
      .rcg-label { font-weight:800; color: var(--rcg-black); }
      .rcg-hidden { display:none !important; }

      .shape-icons { display:flex; gap:12px; flex-wrap:nowrap }
      .shape-iso { width:160px; height:80px; background:transparent; border:none; padding:0; cursor:pointer; display:grid; place-items:center }
      .shape-iso svg { width:100%; height:100%; stroke:#000; stroke-width:1; fill:none }
      .shape-iso.active svg { stroke: var(--rcg-yellow); }
      @media (max-width: 640px){
        .shape-iso { width: calc(33.333% - 8px); height: calc((33.333% - 8px)/2); }
      }

      .sink-controls { display:flex; gap:10px; align-items:center; width:100%; }
      #rcg-sink-select { flex:1; min-width:220px; }
      .sink-chip { display:flex; align-items:center; gap:8px; padding:8px 12px; background:#fff; font-size:13px; border:1px solid #cfcfcf; flex-wrap:nowrap; overflow:hidden }
      .sink-chip button { border:1px solid #000; background:#fff; cursor:pointer; width:28px; height:28px; line-height:26px; font-weight:900 }
      .sink-chip .rcg-input { width:96px }
      .sink-chip select[data-spread]{ width:64px }

      /* Desktop floating panel */
      @media (min-width: 981px){
        .rcg-modal { display:none !important; }
        .rcg-launch-wrap{ display:none !important; }

        .rcg-body{
          min-height: 740px;
        }
        .rcg-panel{
          position:absolute;
          right:16px; top:16px;
          width:520px; max-width: min(520px, 92vw);
          box-shadow: 0 8px 20px rgba(0,0,0,.12);
          z-index: 50;
        }
      }

      /* Mobile bottom sheet */
      @media (max-width: 980px){
        .rcg-inline-host{ display:none; }
        .rcg-panel{
          position: absolute;
          left: 0; right: 0; bottom: 0;
          max-height: 38vh;          /* less intrusive */
          overflow: auto;
          border-top: 2px solid #ddd;
          padding-bottom: 18px;
        }
        .rcg-panel-handle{
          position: sticky;
          top: 0;
          z-index: 5;
        }
        .rcg-title{ font-size: 20px; }
      }
    </style>

    <div class="rcg-root">
      <!-- Mobile: launch button -->
      <div class="rcg-launch-wrap" id="rcg-launch-wrap">
        <button class="rcg-launch" id="rcg-open">Start Your Project Order</button>
      </div>

      <!-- Desktop: inline host -->
      <div class="rcg-inline-host" id="rcg-inline-host"></div>

      <!-- Mobile: modal -->
      <div class="rcg-modal" id="rcg-modal" aria-hidden="true">
        <div class="rcg-window">
          <div class="rcg-topbar">
            <div class="left">
              <img class="rcg-logo ${LOGO_URL ? 'rcg-has':''}" ${LOGO_URL ? `src="${LOGO_URL}"` : ''} alt="">
              <div class="title" style="position:absolute;left:-9999px;">Rock Creek Granite</div>
              <div class="meta" id="rcg-stepper-top">Step 1/4</div>
            </div>
            <button class="rcg-close" id="rcg-close">Close</button>
          </div>
          <div class="rcg-modal-body" id="rcg-modal-body"></div>
        </div>
      </div>
    </div>
  `;

  // -----------------------------
  // Build ONE app DOM (moved between inline & modal)
  // -----------------------------
  function appHTML() {
    return `
      <div class="rcg-app" id="rcg-app">
        <div class="rcg-body">
          <div class="rcg-preview">
            <svg id="rcg-svg" class="rcg-stage" viewBox="0 0 1400 600" preserveAspectRatio="xMidYMid meet"></svg>
          </div>

          <aside class="rcg-panel" id="rcg-panel">
            <div class="rcg-panel-handle" id="rcg-panel-handle" title="Drag to move (desktop)">
              <div class="step">
                <span id="rcg-stepper">Step 1/4</span>
                <small id="rcg-step-title">${SECTION_TITLES[1]}</small>
              </div>
              <div style="display:flex; gap:8px">
                <button class="rcg-btn outline" id="rcg-back">Back</button>
                <button class="rcg-btn" id="rcg-next">Next</button>
              </div>
            </div>

            <div id="rcg-step1" class="rcg-step">
              <div class="rcg-title">${SECTION_TITLES[1]}</div>
              <div class="shape-icons" id="shape-icons"></div>
              <div style="margin-top:10px" class="rcg-row" id="rcg-dims"></div>
              <div class="rcg-sub">Max size: 72" × 62" (rect) or 62" diameter (round/polygon).</div>
            </div>

            <div id="rcg-step2" class="rcg-step rcg-hidden">
              <div class="rcg-title">${SECTION_TITLES[2]}</div>
              <div class="rcg-sub" style="font-weight:800;color:#000">Select edges to be flat polished</div>
              <div class="rcg-sub">Tap each edge in the preview. Yellow = polished. Unpolished sides can receive optional 4" backsplash.</div>

              <div class="rcg-row" id="rcg-polish-choice" style="margin:8px 0 4px 0">
                <label style="display:flex;align-items:center;gap:6px"><input type="radio" name="rcg-polish" value="select" checked> I will select polished edges</label>
                <label style="display:flex;align-items:center;gap:6px"><input type="radio" name="rcg-polish" value="none"> No polished edges please</label>
              </div>

              <div class="rcg-row" style="margin-top:4px">
                <label class="rcg-label" for="rcg-backsplash">Add 4" Backsplash</label>
                <input id="rcg-backsplash" type="checkbox" style="width:18px;height:18px">
              </div>
              <div class="rcg-sub">If selected, 4" backsplash will be included for all non-polished sides.</div>
            </div>

            <div id="rcg-step3" class="rcg-step rcg-hidden">
              <div class="rcg-title">${SECTION_TITLES[3]}</div>

              <div id="rcg-sinks-block" class="rcg-hidden" style="margin-top:8px">
                <div class="sink-controls" style="margin-bottom:6px">
                  <button class="rcg-btn outline" id="rcg-add-sink" title="Add sink">+</button>
                  <select class="rcg-input" id="rcg-sink-select">
                    ${Object.entries(SINK_TEMPLATES).map(([k,t])=>`<option value="${k}">${t.label}</option>`).join('')}
                  </select>
                </div>

                <div id="rcg-sink-pills" style="display:grid; gap:8px"></div>
                <div class="rcg-sub">Sinks must be ≥ ${MIN_SINK_EDGE}" from edges and ≥ ${MIN_SINK_GAP}" from each other. Drag sinks in the preview.</div>
              </div>

              <div id="rcg-nonrect-note" class="rcg-sub">Sink placement is available for rectangles only.</div>
            </div>

            <div id="rcg-step4" class="rcg-step rcg-hidden">
              <div class="rcg-title">${SECTION_TITLES[4]}</div>

              <div class="rcg-row" style="margin-bottom:10px; width:100%">
                <label class="rcg-label">Stone</label>
                <select class="rcg-input" id="rcg-color" style="flex:1; min-width:220px">
                  ${COLORS.map(c => `<option value="${c.key}">${c.name}</option>`).join('')}
                </select>
              </div>

              <div class="rcg-row" style="margin-top:8px">
                <label class="rcg-label">ZIP</label>
                <input class="rcg-input" id="rcg-zip" placeholder="ZIP code" maxlength="5" inputmode="numeric" pattern="\\d{5}">
                <button class="rcg-btn" id="rcg-checkout">Checkout</button>
              </div>

              <div class="rcg-row" style="margin-top:6px">
                <input class="rcg-input" id="rcg-email" style="flex:1; min-width:220px" placeholder="Email (optional) — Send me the DXF" type="email">
                <button class="rcg-btn outline" id="rcg-email-dxf" title="Email DXF cut sheet">Email DXF</button>
              </div>

              <div class="rcg-sub">Checkout continues to Stripe. DXF email uses your existing /api/email-dxf endpoint.</div>
            </div>
          </aside>
        </div>
      </div>
    `;
  }

  const inlineHost = el('#rcg-inline-host', mount);
  const modal = el('#rcg-modal', mount);
  const modalBody = el('#rcg-modal-body', mount);
  const openBtn = el('#rcg-open', mount);
  const closeBtn = el('#rcg-close', mount);
  const launchWrap = el('#rcg-launch-wrap', mount);

  const appWrap = document.createElement('div');
  appWrap.innerHTML = appHTML();
  const appRoot = appWrap.firstElementChild;

  function attachAppToDesktop() {
    if (!inlineHost.contains(appRoot)) inlineHost.appendChild(appRoot);
  }
  function attachAppToModal() {
    if (!modalBody.contains(appRoot)) modalBody.appendChild(appRoot);
  }

  function openModal() {
    attachAppToModal();
    modal.setAttribute('aria-hidden', 'false');
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    // mobile padding sync
    syncMobilePreviewInset();
  }
  function closeModal() {
    modal.setAttribute('aria-hidden', 'true');
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }

  // Desktop default: inline
  attachAppToDesktop();

  // On resize: move app between containers
  function syncMode() {
    if (isDesktop()) {
      closeModal();
      attachAppToDesktop();
      // Desktop drag handle should be active
      setHandleMode();
      // clear mobile padding
      const preview = el('.rcg-preview', appRoot);
      if (preview) preview.style.removeProperty('--rcg-sheet-h');
    } else {
      // mobile: keep inline hidden via CSS; app stays inline until opened
      setHandleMode();
    }
  }
  window.addEventListener('resize', syncMode);

  // Mobile scroll reveal of button
  (function setupScrollReveal() {
    const applyVisibility = (show) => {
      if (!launchWrap) return;
      if (isDesktop()) {
        launchWrap.classList.remove('rcg-visible');
        return;
      }
      launchWrap.classList.toggle('rcg-visible', !!show);
    };

    // default hidden on mobile until in view
    applyVisibility(false);

    const obs = new IntersectionObserver((entries) => {
      const e = entries[0];
      applyVisibility(e && e.isIntersecting);
    }, { root: null, threshold: 0.15 });

    obs.observe(mount);

    window.addEventListener('resize', () => applyVisibility(false));
  })();

  // Buttons
  if (openBtn) openBtn.addEventListener('click', () => {
    if (!isMobile()) return;
    openModal();
  });
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    step: 1,
    shape: null,       // 'rectangle' | 'circle' | 'polygon'
    dims: {},
    sinks: [],
    color: DEFAULT_COLOR,
    edges: [],         // ['top','right','bottom','left']
    area: 0,
    activeIcon: 'square',
    backsplash: false,
    polishMode: 'select'
  };

  // -----------------------------
  // Shape icons (EXACT SVG DATA retained)
  // -----------------------------
  const ICONS = ['square', 'circle', 'polygon'];
  function isoIcon(name) {
    if (name === 'square')  return '<svg viewBox="0 0 64 32"><path d="M14 10 L34 5 L54 10 L34 15 Z"/><path d="M14 10 L14 24 L34 29 L34 15 M54 10 L54 24 L34 29"/></svg>';
    if (name === 'circle')  return '<svg viewBox="0 0 64 32"><ellipse cx="32" cy="10" rx="18" ry="5"/><path d="M14 10 v10 c0 4 8 7 18 7 s18-3 18-7 V10"/></svg>';
    return '<svg viewBox="0 0 64 32">\
      <g>\
          <path d="M40 5l12 6-11 5H25L14 11 26 5Zl12 6V22L41 28H25L14 22V11l11 5V28H41V16"/>\
      </g>\
    </svg>';
  }
  function renderShapeIcons(container) {
    container.innerHTML = ICONS.map(s => `<button class="shape-iso" data-icon="${s}" aria-label="${s}">${isoIcon(s)}</button>`).join('');
    els('[data-icon]', container).forEach(btn => btn.onclick = () => setShapeFromIcon(btn.dataset.icon));
  }

  // -----------------------------
  // SVG Scene
  // -----------------------------
  const svg = el('#rcg-svg', appRoot);
  const ns = 'http://www.w3.org/2000/svg';

  const defs = document.createElementNS(ns, 'defs');
  const clip = document.createElementNS(ns, 'clipPath');
  clip.setAttribute('id', 'rcgClip');

  const gridG = document.createElementNS(ns, 'g'); gridG.setAttribute('opacity', '0.08');
  const imageG = document.createElementNS(ns, 'g');
  const shapeG = document.createElementNS(ns, 'g');
  const sinksG = document.createElementNS(ns, 'g');
  const dimsG  = document.createElementNS(ns, 'g');
  const edgesG = document.createElementNS(ns, 'g');
  const hotG   = document.createElementNS(ns, 'g');

  defs.appendChild(clip);
  svg.append(defs, gridG, imageG, shapeG, sinksG, edgesG, hotG, dimsG);
  dimsG.setAttribute('pointer-events', 'none');

  function drawGrid() {
    gridG.innerHTML = '';
    for (let x = 0; x <= 1400; x += 40) {
      const l = document.createElementNS(ns, 'line');
      l.setAttribute('x1', x); l.setAttribute('y1', 0);
      l.setAttribute('x2', x); l.setAttribute('y2', 600);
      l.setAttribute('stroke', 'black'); l.setAttribute('stroke-width', '1');
      gridG.appendChild(l);
    }
    for (let y = 0; y <= 600; y += 40) {
      const l = document.createElementNS(ns, 'line');
      l.setAttribute('x1', 0); l.setAttribute('y1', y);
      l.setAttribute('x2', 1400); l.setAttribute('y2', y);
      l.setAttribute('stroke', 'black'); l.setAttribute('stroke-width', '1');
      gridG.appendChild(l);
    }
  }
  drawGrid();

  function getScale() {
    const pad = 40;
    const maxW = 1400 - pad * 2;
    const maxH = 600 - pad * 2;

    let widthIn = 36, heightIn = 25.5;
    if (state.shape === 'rectangle') { widthIn = state.dims.L || 36; heightIn = state.dims.W || 25.5; }
    if (state.shape === 'circle')    { const d = state.dims.D || 30; widthIn = d; heightIn = d; }
    if (state.shape === 'polygon')   { const n = state.dims.n || 6; const A = state.dims.A || 12; const diam = polyCircumDiam(n, A); widthIn = diam; heightIn = diam; }

    const s = Math.min(maxW / widthIn, maxH / heightIn) * 0.95;
    const wpx = widthIn * s, hpx = heightIn * s;
    const remX = 1400 - wpx;
    const remY = 600 - hpx;

    const cx = remX * 0.5;
    const cy = remY * 0.5;
    return { s, cx, cy, widthIn, heightIn };
  }

  function label(text, x, y) {
    const t = document.createElementNS(ns, 'text');
    t.textContent = text;
    t.setAttribute('x', x);
    t.setAttribute('y', y);

    const mobile = isMobile();
    const fontSize = mobile ? 30 : 16;
    const strokeW  = mobile ? 5 : 3;

    t.setAttribute('font-size', String(fontSize));
    t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', '#111');
    t.setAttribute('stroke', '#fff');
    t.setAttribute('stroke-width', String(strokeW));
    t.setAttribute('paint-order', 'stroke');
    dimsG.appendChild(t);
  }

  function drawShape() {
    imageG.innerHTML = ''; shapeG.innerHTML = ''; edgesG.innerHTML = '';
    dimsG.innerHTML = ''; sinksG.innerHTML = ''; hotG.innerHTML = '';

    const { s, cx, cy, widthIn, heightIn } = getScale();
    let pathEl;
    let bbox = { x: cx, y: cy, width: widthIn * s, height: heightIn * s };

    if (state.shape === 'rectangle') {
      pathEl = document.createElementNS(ns, 'rect');
      pathEl.setAttribute('x', bbox.x);
      pathEl.setAttribute('y', bbox.y);
      pathEl.setAttribute('width', bbox.width);
      pathEl.setAttribute('height', bbox.height);
    } else if (state.shape === 'circle') {
      pathEl = document.createElementNS(ns, 'circle');
      pathEl.setAttribute('cx', cx + bbox.width / 2);
      pathEl.setAttribute('cy', cy + bbox.height / 2);
      pathEl.setAttribute('r', (widthIn * s) / 2);
    } else if (state.shape === 'polygon') {
      const n = state.dims.n || 6;
      const A = state.dims.A || 12;
      const R = (polyCircumDiam(n, A) / 2) * s;
      const cxp = cx + bbox.width / 2, cyp = cy + bbox.height / 2;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const ang = i * (2 * Math.PI / n);
        pts.push([cxp + R * Math.cos(ang), cyp + R * Math.sin(ang)]);
      }
      pathEl = document.createElementNS(ns, 'polygon');
      pathEl.setAttribute('points', pts.map(p => p.join(',')).join(' '));
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
      bbox = { x: minx, y: miny, width: maxx - minx, height: maxy - miny };
    } else {
      return;
    }

    // clip path
    clip.innerHTML = '';
    clip.appendChild(pathEl.cloneNode(true));

    // texture on step 4+
    const showTexture = (state.step >= 4 && !!state.color);
    if (showTexture) {
      const col = COLORS.find(x => x.key === state.color);
      if (col && col.url) {
        const img = document.createElementNS(ns, 'image');
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', col.url);
        img.setAttribute('x', bbox.x); img.setAttribute('y', bbox.y);
        img.setAttribute('width', bbox.width); img.setAttribute('height', bbox.height);
        img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        img.setAttribute('clip-path', 'url(#rcgClip)');
        imageG.appendChild(img);
      }
    }

    // outline
    const outline = pathEl.cloneNode(true);
    outline.setAttribute('fill', showTexture ? 'none' : '#ffffff');
    outline.setAttribute('stroke', '#111');
    outline.setAttribute('stroke-width', '2');
    shapeG.appendChild(outline);

    // edges + hot zones (rectangle only)
    if (state.shape === 'rectangle') {
      const ex = bbox.x, ey = bbox.y, ew = bbox.width, eh = bbox.height;
      const band = Math.max(18, Math.min(36, Math.min(ew, eh) * 0.14)); // slightly easier to tap

      function drawEdge(x1, y1, x2, y2, key) {
        const active = state.edges.includes(key);
        const seg = document.createElementNS(ns, 'line');
        seg.setAttribute('x1', x1); seg.setAttribute('y1', y1);
        seg.setAttribute('x2', x2); seg.setAttribute('y2', y2);
        seg.setAttribute('stroke', active ? 'var(--rcg-yellow)' : '#111');
        seg.setAttribute('stroke-width', active ? (isMobile()? '8':'6') : '2');
        edgesG.appendChild(seg);
      }

      drawEdge(ex, ey, ex + ew, ey, 'top');
      drawEdge(ex + ew, ey, ex + ew, ey + eh, 'right');
      drawEdge(ex, ey + eh, ex + ew, ey + eh, 'bottom');
      drawEdge(ex, ey, ex, ey + eh, 'left');

      if (state.step === 2) {
        const zones = [
          { key: 'top', x: ex, y: ey, w: ew, h: band },
          { key: 'bottom', x: ex, y: ey + eh - band, w: ew, h: band },
          { key: 'left', x: ex, y: ey, w: band, h: eh },
          { key: 'right', x: ex + ew - band, y: ey, w: band, h: eh }
        ];
        zones.forEach(z => {
          const r = document.createElementNS(ns, 'rect');
          r.setAttribute('x', z.x); r.setAttribute('y', z.y);
          r.setAttribute('width', z.w); r.setAttribute('height', z.h);
          r.setAttribute('fill', 'transparent');
          r.setAttribute('pointer-events', 'all');
          r.style.cursor = 'pointer';
          r.addEventListener('click', () => {
            const i = state.edges.indexOf(z.key);
            if (i > -1) state.edges.splice(i, 1);
            else state.edges.push(z.key);
            drawShape(); updateNav();
          });
          hotG.appendChild(r);
        });
      }
    }

    // dimension labels
    if (state.shape === 'rectangle') {
      label(`${fmt2(state.dims.L || 0)}" (L)`, bbox.x + bbox.width / 2, Math.max(28, bbox.y - 20));
      label(`${fmt2(state.dims.W || 0)}" (W)`, Math.max(36, bbox.x - 40), bbox.y + bbox.height / 2);
    } else if (state.shape === 'circle') {
      label(`${fmt2(state.dims.D || 0)}" Ø`, bbox.x + bbox.width / 2, Math.max(28, bbox.y - 20));
    } else if (state.shape === 'polygon') {
      label(`${state.dims.n || 6}-sides, ${fmt2(state.dims.A || 0)}" side`, bbox.x + bbox.width / 2, Math.max(28, bbox.y - 20));
    }

    // sinks (rectangle only)
    if (state.shape === 'rectangle' && state.sinks.length) {
      const toPx = v => v * s;
      const toIn = v => v / s;
      const rectX = bbox.x, rectY = bbox.y;

      state.sinks.forEach((snk, idx) => {
        const tpl = SINK_TEMPLATES[snk.key]; if (!tpl) return;
        const halfW = tpl.w / 2, halfH = tpl.h / 2;

        let cxIn = clamp(snk.x, halfW + MIN_SINK_EDGE, (state.dims.L - halfW) - MIN_SINK_EDGE);
        let cyIn = clamp(snk.y, halfH + MIN_SINK_EDGE, (state.dims.W - halfH) - MIN_SINK_EDGE);

        function violates(x, y) {
          return state.sinks.some((o, j) => j !== idx && (() => {
            const t = SINK_TEMPLATES[o.key];
            const dx = Math.abs(x - o.x);
            const dy = Math.abs(y - o.y);
            const minDx = (tpl.w / 2 + t.w / 2 + MIN_SINK_GAP);
            const minDy = (tpl.h / 2 + t.h / 2 + MIN_SINK_GAP);
            return (dx < minDx && dy < minDy);
          })());
        }

        if (violates(cxIn, cyIn)) { cxIn = snk.x; cyIn = snk.y; }
        snk.x = cxIn; snk.y = cyIn;

        const gx = rectX + toPx(cxIn - halfW);
        const gy = rectY + toPx(cyIn - halfH);
        const gw = toPx(tpl.w), gh = toPx(tpl.h);

        let node;
        if (tpl.shape === 'oval') {
          node = document.createElementNS(ns, 'ellipse');
          node.setAttribute('cx', gx + gw / 2);
          node.setAttribute('cy', gy + gh / 2);
          node.setAttribute('rx', gw / 2);
          node.setAttribute('ry', gh / 2);
        } else {
          node = document.createElementNS(ns, 'rect');
          node.setAttribute('x', gx); node.setAttribute('y', gy);
          node.setAttribute('width', gw); node.setAttribute('height', gh);
          node.setAttribute('rx', '4');
        }
        node.setAttribute('fill', 'rgba(255,255,255,0.001)');
        node.setAttribute('stroke', '#d00');
        node.setAttribute('stroke-width', isMobile()? '3' : '2');
        node.style.cursor = 'grab';
        sinksG.appendChild(node);

        // faucet holes preview (1.25" Ø)
        const holeR = toPx(1.25 / 2);
        const holeY = (ny - (gh / 2)) - toPx(2);
        const holesNow = [];
        
        if (snk.faucet === '3' && (snk.spread === 4 || snk.spread === 8)) {
            const off = toPx((snk.spread / 2));
            holesNow.push([nx - off, holeY], [nx, holeY], [nx + off, holeY]);
        } else {
            holesNow.push([nx, holeY]);
        }
        
        const holeEls = Array.from(sinksG.querySelectorAll(`circle[data-sinkhole="${snk.id}"]`));
        holeEls.forEach((c, i) => {
            const pt = holesNow[i];
            
            if (!pt) { c.remove(); return; }
            c.setAttribute('cx', pt[0]);
            c.setAttribute('cy', pt[1]);
            c.setAttribute('r', holeR);
        });

        if (snk.faucet === '3' && (snk.spread === 4 || snk.spread === 8)) {
          const off = toPx((snk.spread / 2));
          holes.push([centerX - off, holeY], [centerX, holeY], [centerX + off, holeY]);
        } else {
          holes.push([centerX, holeY]);
        }

        holes.forEach(([hx, hy]) => {
          const c = document.createElementNS(ns, 'circle');
          c.setAttribute('data-sinkhole', snk.id);
          c.setAttribute('data-hole-idx', String(holeIdx));
          c.setAttribute('cx', hx);
          c.setAttribute('cy', hy);
          c.setAttribute('r', holeR);
          c.setAttribute('fill', 'rgba(255,255,255,0.6)');
          c.setAttribute('stroke', '#111');
          c.setAttribute('stroke-width', isMobile()? '3' : '2');
          sinksG.appendChild(c);
        });

        // drag
        let dragging = false, ox = 0, oy = 0;
        let nodeCenterX = gx + gw / 2, nodeCenterY = gy + gh / 2;

        function svgPoint(evt) {
          const p = svg.createSVGPoint();
          if (evt.touches && evt.touches[0]) {
            p.x = evt.touches[0].clientX; p.y = evt.touches[0].clientY;
          } else {
            p.x = evt.clientX; p.y = evt.clientY;
          }
          return p.matrixTransform(svg.getScreenCTM().inverse());
        }

        function onDown(e) {
          if (state.step !== 3) return;
          dragging = true;
          node.style.cursor = 'grabbing';
          const pt = svgPoint(e);
          ox = pt.x - nodeCenterX;
          oy = pt.y - nodeCenterY;
          e.preventDefault();
        }
        function onMove(e) {
          if (!dragging) return;
          const pt = svgPoint(e);

          let nx = clamp(
            pt.x - ox,
            rectX + gw / 2 + toPx(MIN_SINK_EDGE),
            rectX + bbox.width - gw / 2 - toPx(MIN_SINK_EDGE)
          );
          let ny = clamp(
            pt.y - oy,
            rectY + gh / 2 + toPx(MIN_SINK_EDGE),
            rectY + bbox.height - gh / 2 - toPx(MIN_SINK_EDGE)
          );

          const xin = toIn(nx - rectX);
          const yin = toIn(ny - rectY);

          let collide = false;
          state.sinks.forEach((o, j) => {
            if (j === idx) return;
            const tt = SINK_TEMPLATES[o.key];
            const dx = Math.abs(xin - o.x);
            const dy = Math.abs(yin - o.y);
            const minDx = (tpl.w / 2 + tt.w / 2 + MIN_SINK_GAP);
            const minDy = (tpl.h / 2 + tt.h / 2 + MIN_SINK_GAP);
            if (dx < minDx && dy < minDy) collide = true;
          });

          if (!collide) {
  nodeCenterX = nx; nodeCenterY = ny;
  snk.x = xin; snk.y = yin;

  // Move the element live (smooth)
  if (tpl.shape === 'oval') {
    node.setAttribute('cx', nx);
    node.setAttribute('cy', ny);
  } else {
    node.setAttribute('x', nx - (gw / 2));
    node.setAttribute('y', ny - (gh / 2));
  }

  // Also move faucet hole preview circles (we can tag them for this)
  // (See the small tag patch below.)
}
        }
        function onUp() {
          dragging = false;
          node.style.cursor = 'grab';
          drawShape();
        }

        node.addEventListener('mousedown', onDown);
        node.addEventListener('touchstart', onDown, { passive: false });
        window.addEventListener('mousemove', onMove);
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('mouseup', onUp);
        window.addEventListener('touchend', onUp);
      });
    }
  }

  // -----------------------------
  // Steps + navigation
  // -----------------------------
  function visibleStepCount() { return 4; }

  function updateStepHints() {
    const isRect = state.shape === 'rectangle';
    const sinksBlock = el('#rcg-sinks-block', appRoot);
    const note = el('#rcg-nonrect-note', appRoot);
    if (sinksBlock) sinksBlock.classList.toggle('rcg-hidden', !isRect);
    if (note) note.style.display = isRect ? 'none' : 'block';
  }

  function goto(step) {
    state.step = clamp(step, 1, visibleStepCount());
    els('.rcg-step', appRoot).forEach((s, i) => s.classList.toggle('rcg-hidden', i !== state.step - 1));

    el('#rcg-stepper', appRoot).textContent = `Step ${state.step}/4`;
    const top = el('#rcg-stepper-top', mount);
    if (top) top.textContent = `Step ${state.step}/4`;
    el('#rcg-step-title', appRoot).textContent = SECTION_TITLES[state.step] || '';

    drawShape();
    updateNav();
    updateStepHints();
    // mobile inset updates (sheet changes per step)
    syncMobilePreviewInset();
  }

  function updateNav() {
    const back = el('#rcg-back', appRoot);
    const next = el('#rcg-next', appRoot);

    back.style.visibility = state.step === 1 ? 'hidden' : 'visible';
    next.style.display = state.step === 4 ? 'none' : 'inline-block';

    let disableNext = false;
    if (state.step === 2 && state.shape === 'rectangle') {
      disableNext = (state.polishMode === 'select' && state.edges.length === 0);
    }
    next.disabled = disableNext;
  }

  el('#rcg-back', appRoot).onclick = () => goto(state.step - 1);
  el('#rcg-next', appRoot).onclick = () => {
    if (state.step === 1) { if (state.shape === 'rectangle') goto(2); else goto(4); return; }
    if (state.step === 2) { goto(3); return; }
    if (state.step === 3) { goto(4); return; }
  };

  // polish radios
  els('input[name="rcg-polish"]', appRoot).forEach(r => r.addEventListener('change', () => {
    state.polishMode = r.value;
    if (state.polishMode === 'none') state.edges = [];
    drawShape(); updateNav();
  }));

  // backsplash
  const backsplashToggle = el('#rcg-backsplash', appRoot);
  if (backsplashToggle) backsplashToggle.addEventListener('change', () => {
    state.backsplash = backsplashToggle.checked;
  });

  // stone dropdown
  const colorSel = el('#rcg-color', appRoot);
  if (colorSel) {
    colorSel.value = DEFAULT_COLOR;
    colorSel.addEventListener('change', () => { state.color = colorSel.value; drawShape(); });
  }

  // -----------------------------
  // Step 1 dim inputs
  // -----------------------------
  function buildDimInputs() {
    const h = el('#rcg-dims', appRoot);
    if (!state.shape) {
      h.innerHTML = '<div class="rcg-sub">Choose a shape to set measurements.</div>';
      return;
    }

    if (state.shape === 'rectangle') {
      h.innerHTML = `
        <label class="rcg-label">L (in)</label><input class="rcg-input" id="dim-L" type="number" step="0.125" min="1" max="${MAX_LEN}" value="36.00">
        <label class="rcg-label">W (in)</label><input class="rcg-input" id="dim-W" type="number" step="0.125" min="1" max="${MAX_WID}" value="25.50">`;
    } else if (state.shape === 'circle') {
      h.innerHTML = `<label class="rcg-label">Diameter (in)</label><input class="rcg-input" id="dim-D" type="number" step="0.125" min="1" max="${MAX_DIAM}" value="30.00">`;
    } else {
      const n = clamp(state.dims.n || 6, 5, 18);
      const sMax = (MAX_DIAM * Math.sin(Math.PI / n)).toFixed(2);
      h.innerHTML = `
        <label class="rcg-label">Sides</label><input class="rcg-input" id="dim-N" type="number" step="1" min="5" max="18" value="${n}">
        <label class="rcg-label">Side (in)</label><input class="rcg-input" id="dim-A" type="number" step="0.125" min="1" max="${sMax}" value="${(state.dims.A || 12).toFixed(2)}">
        <span class="rcg-sub">Max side ≈ ${sMax}" (to keep size ≤ ${MAX_DIAM}")</span>`;
    }

    const onInput = () => { readDims(); drawShape(); };
    h.oninput = onInput;

    h.onchange = () => {
      ['#dim-L', '#dim-W', '#dim-D', '#dim-A'].forEach(sel => {
        const i = el(sel, appRoot);
        if (i && i.value !== '') i.value = fmt2(i.value);
      });
      if (el('#dim-N', appRoot)) {
        const n = parseInt(el('#dim-N', appRoot).value || '6', 10);
        const sMax = (MAX_DIAM * Math.sin(Math.PI / n)).toFixed(2);
        const a = el('#dim-A', appRoot);
        if (a) {
          a.max = sMax;
          if (parseFloat(a.value) > parseFloat(sMax)) a.value = sMax;
        }
      }
      readDims(); drawShape();
    };

    readDims();
  }

  function readDims() {
    const L = parseFloat(el('#dim-L', appRoot)?.value || 0);
    const W = parseFloat(el('#dim-W', appRoot)?.value || 0);
    const D = parseFloat(el('#dim-D', appRoot)?.value || 0);
    const A = parseFloat(el('#dim-A', appRoot)?.value || 0);
    const N = parseInt(el('#dim-N', appRoot)?.value || 0, 10);

    if (state.shape === 'rectangle') state.dims = { L: clamp(L, 1, MAX_LEN), W: clamp(W, 1, MAX_WID) };
    else if (state.shape === 'circle') state.dims = { D: clamp(D, 1, MAX_DIAM) };
    else {
      const n = clamp(N || 6, 5, 18);
      const sMax = MAX_DIAM * Math.sin(Math.PI / n);
      state.dims = { n, A: clamp(A || 12, 1, sMax) };
    }
    state.area = areaSqft(state.shape, state.dims);
  }

  function setShapeFromIcon(icon) {
    state.activeIcon = icon;
    state.shape = (icon === 'square') ? 'rectangle' : icon;

    state.sinks = [];
    state.edges = [];
    state.backsplash = false;
    state.polishMode = 'select';

    els('[data-icon]', appRoot).forEach(b => b.classList.toggle('active', b.dataset.icon === icon));
    buildDimInputs();
    updateStepHints();
    drawShape();
    updateNav();
  }

  // -----------------------------
  // Step 3 sinks UI
  // -----------------------------
  const addBtn = el('#rcg-add-sink', appRoot);
  const selSink = el('#rcg-sink-select', appRoot);
  const sinkPills = el('#rcg-sink-pills', appRoot);

  function sinkFits(template) {
    if (state.shape !== 'rectangle') return false;
    const L = state.dims.L || 0, W = state.dims.W || 0;
    return (template.w + 2 * MIN_SINK_EDGE <= L) && (template.h + 2 * MIN_SINK_EDGE <= W);
  }

  function canPlaceSecond(template) {
    if (!sinkFits(template)) return false;
    const L = state.dims.L, W = state.dims.W;
    const halfW = template.w / 2, halfH = template.h / 2;
    const xmin = MIN_SINK_EDGE + halfW, xmax = L - MIN_SINK_EDGE - halfW;
    const ymin = MIN_SINK_EDGE + halfH, ymax = W - MIN_SINK_EDGE - halfH;
    if (xmin > xmax || ymin > ymax) return false;

    const first = state.sinks[0]; if (!first) return true;
    const t1 = SINK_TEMPLATES[first.key];
    const minDx = halfW + t1.w / 2 + MIN_SINK_GAP;
    const minDy = halfH + t1.h / 2 + MIN_SINK_GAP;

    function ok(x, y) {
      const dx = Math.abs(x - first.x), dy = Math.abs(y - first.y);
      return x >= xmin && x <= xmax && y >= ymin && y <= ymax && (dx >= minDx || dy >= minDy);
    }

    const cx = (xmin + xmax) / 2, cy = (ymin + ymax) / 2;
    const cands = [
      { x: xmin, y: cy }, { x: xmax, y: cy }, { x: cx, y: ymin }, { x: cx, y: ymax },
      { x: xmin, y: ymin }, { x: xmin, y: ymax }, { x: xmax, y: ymin }, { x: xmax, y: ymax }
    ];
    return cands.some(p => ok(p.x, p.y));
  }

  function suggestSecondPosition(template) {
    const L = state.dims.L, W = state.dims.W;
    const halfW = template.w / 2, halfH = template.h / 2;
    const xmin = MIN_SINK_EDGE + halfW, xmax = L - MIN_SINK_EDGE - halfW;
    const ymin = MIN_SINK_EDGE + halfH, ymax = W - MIN_SINK_EDGE - halfH;
    const s1 = state.sinks[0]; if (!s1) return { x: (xmin + xmax) / 2, y: (ymin + ymax) / 2 };

    const t1 = SINK_TEMPLATES[s1.key];
    const minDx = halfW + t1.w / 2 + MIN_SINK_GAP;
    const minDy = halfH + t1.h / 2 + MIN_SINK_GAP;

    function ok(x, y) {
      const dx = Math.abs(x - s1.x), dy = Math.abs(y - s1.y);
      return x >= xmin && x <= xmax && y >= ymin && y <= ymax && (dx >= minDx || dy >= minDy);
    }

    const tries = [
      { x: L - s1.x, y: s1.y },
      { x: s1.x, y: W - s1.y },
      { x: L - s1.x, y: W - s1.y },
      { x: clamp(s1.x + minDx, xmin, xmax), y: s1.y },
      { x: clamp(s1.x - minDx, xmin, xmax), y: s1.y },
      { x: s1.x, y: clamp(s1.y + minDy, ymin, ymax) },
      { x: s1.x, y: clamp(s1.y - minDy, ymin, ymax) },
      { x: (xmin + xmax) / 2, y: (ymin + ymax) / 2 }
    ];
    for (const p of tries) if (ok(p.x, p.y)) return p;
    return null;
  }

  function sinkPillHTML(s) {
    const opts = ['1', '3'].map(v => `<option value="${v}" ${s.faucet === v ? 'selected' : ''}>${v}-hole</option>`).join('');
    const spreadOpts = s.faucet === '3'
      ? `<option value="4" ${s.spread == 4 ? 'selected' : ''}>4"</option><option value="8" ${s.spread == 8 ? 'selected' : ''}>8"</option>`
      : `<option value="" selected>–</option>`;
    const spread = `<select class="rcg-input" data-spread="${s.id}" ${s.faucet === '3' ? '' : 'disabled'}>${spreadOpts}</select>`;

    return `<div class="sink-chip" data-id="${s.id}">
      <strong>${SINK_TEMPLATES[s.key].label}</strong>
      <span style="flex:1"></span>
      <label>Faucet</label>
      <select class="rcg-input" data-faucet="${s.id}">${opts}</select>
      ${spread}
      <button title="Remove sink">×</button>
    </div>`;
  }

  function refreshSinkPills() {
    if (!sinkPills) return;
    sinkPills.innerHTML = state.sinks.map(s => sinkPillHTML(s)).join('');

    els('.sink-chip button', sinkPills).forEach(btn => btn.onclick = () => {
      const id = btn.parentElement.getAttribute('data-id');
      state.sinks = state.sinks.filter(x => x.id !== id);
      drawShape(); refreshSinkPills();
    });

    els('[data-faucet]', sinkPills).forEach(sel => sel.onchange = () => {
      const id = sel.getAttribute('data-faucet');
      const s = state.sinks.find(x => x.id === id); if (!s) return;
      s.faucet = sel.value;
      if (s.faucet === '1') s.spread = null;
      refreshSinkPills(); drawShape();
    });

    els('[data-spread]', sinkPills).forEach(sel => sel.onchange = () => {
      const id = sel.getAttribute('data-spread');
      const s = state.sinks.find(x => x.id === id); if (!s) return;
      s.spread = parseInt(sel.value || '0', 10) || null;
      drawShape();
    });
  }

  if (addBtn) addBtn.onclick = () => {
    if (state.shape !== 'rectangle') return;
    const key = selSink.value;
    const tpl = SINK_TEMPLATES[key];

    if (!sinkFits(tpl)) return alert('That sink will not fit this piece with 4" edge clearance.');
    if (state.sinks.length === 1 && !canPlaceSecond(tpl)) return alert('There is not enough room to add a second sink with required clearances.');
    if (state.sinks.length >= 2) return alert('You can add up to 2 sinks.');

    const L = state.dims.L || 48, W = state.dims.W || 24;
    let pos;

    if (state.sinks.length === 0) {
      pos = {
        x: clamp(L * 0.5, MIN_SINK_EDGE + tpl.w / 2, L - MIN_SINK_EDGE - tpl.w / 2),
        y: clamp(W * 0.35, MIN_SINK_EDGE + tpl.h / 2, W - MIN_SINK_EDGE - tpl.h / 2)
      };
    } else {
      const suggested = suggestSecondPosition(tpl);
      if (!suggested) return alert('There is not enough room to add a second sink with required clearances.');
      pos = suggested;
    }

    state.sinks.push({ id: uid(), key, ...pos, faucet: '1', spread: null });
    drawShape(); refreshSinkPills();
  };

  // -----------------------------
  // Pricing + config payload
  // -----------------------------
  function taxRateByZip(zip) {
    if (!/^\d{5}$/.test(zip)) return 0;
    if (/^63/.test(zip)) return 0.0825;
    if (/^62/.test(zip)) return 0.0875;
    return 0.0700;
  }

  function backsplashSqft() {
    if (state.shape !== 'rectangle' || !state.backsplash) return 0;
    const L = state.dims.L || 0, W = state.dims.W || 0;
    const unpol = ['top', 'right', 'bottom', 'left'].filter(k => !state.edges.includes(k));
    const lenMap = { top: L, bottom: L, left: W, right: W };
    const areaIn2 = unpol.reduce((sum, k) => sum + (lenMap[k] || 0) * 4, 0);
    return areaIn2 / 144;
  }

  function computePricing(zip) {
    const area = state.area;
    const material = area * DOLLARS_PER_SQFT;
    const sinks = (state.shape === 'rectangle') ? state.sinks.reduce((acc, s) => acc + (SINK_PRICES[s.key] || 0), 0) : 0;
    const bpsf = backsplashSqft() * DOLLARS_PER_SQFT;
    const ship = shippingEstimate(area + backsplashSqft(), zip, ORIGIN_ZIP_DEFAULT);
    const taxRate = taxRateByZip(zip);
    const services = material + sinks + bpsf + ship.ltl;
    const tax = services * taxRate;
    const total = services + tax;
    return { material, sinks, backsplash: bpsf, ship, taxRate, tax, total, services };
  }

  function encodeCfg(obj) {
    try { return encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(obj))))); }
    catch { return ''; }
  }

  function currentConfig() {
    const zip = (el('#rcg-zip', appRoot)?.value || '').trim();
    const p = computePricing(zip || ORIGIN_ZIP_DEFAULT);
    return {
      shape: state.shape,
      dims: state.dims,
      sinks: state.shape === 'rectangle' ? state.sinks : [],
      color: state.color,
      edges: (state.shape === 'rectangle' && state.polishMode === 'select') ? state.edges : [],
      backsplash: state.shape === 'rectangle' ? !!state.backsplash : false,
      zip: zip,
      pricing: {
        product: +p.material.toFixed(2),
        sink_addon: +p.sinks.toFixed(2),
        backsplash: +p.backsplash.toFixed(2),
        shipping: +p.ship.ltl.toFixed(2),
        services: +p.services.toFixed(2),
        tax_rate: p.taxRate,
        tax: +p.tax.toFixed(2),
        total: +p.total.toFixed(2)
      },
      weight_lb: +p.ship.weight.toFixed(1),
      cwt: p.ship.cwt,
      mult: p.ship.mult
    };
  }

  // Checkout
  el('#rcg-checkout', appRoot).onclick = () => {
    const zip = (el('#rcg-zip', appRoot).value || '').trim();
    if (!/^\d{5}$/.test(zip)) return alert('Enter a valid 5-digit ZIP to continue.');
    const payload = currentConfig();
    window.location.assign('/config-checkout?cfg=' + encodeCfg(payload));
  };

  // -----------------------------
  // DXF Builder (inches)
  // -----------------------------
  function buildDXF(cfg) {
    const out = [];
    const push = (...a) => out.push(...a.map(String));
    const sec = (name) => push('0', 'SECTION', '2', name);
    const endsec = () => push('0', 'ENDSEC');

    const header = () => { sec('HEADER'); push('9', '$INSUNITS', '70', '1'); endsec(); }; // inches
    const start = () => { header(); sec('TABLES'); endsec(); sec('ENTITIES'); };
    const finish = () => { endsec(); push('0', 'EOF'); return out.join('\n'); };

    const lwpoly = (pts, closed, layer='CUT') => {
      push('0','LWPOLYLINE','8',layer,'90',pts.length,'70',closed ? '1':'0');
      pts.forEach(([x,y]) => { push('10', (+x).toFixed(4), '20', (+y).toFixed(4)); });
    };
    const circle = (x,y,r,layer='HOLES') => {
      push('0','CIRCLE','8',layer,'10',(+x).toFixed(4),'20',(+y).toFixed(4),'40',(+r).toFixed(4));
    };
    const text = (x,y,h,msg,layer='TEXT') => {
      push('0','TEXT','8',layer,'10',(+x).toFixed(4),'20',(+y).toFixed(4),'40',(+h).toFixed(3),'1',String(msg));
    };
    const rect = (x,y,w,h,layer='CUT') => lwpoly([[x,y],[x+w,y],[x+w,y+h],[x,y+h]], true, layer);
    const ellipsePoly = (cx,cy,rx,ry,seg=96) => {
      const pts=[];
      for(let i=0;i<seg;i++){
        const t=i/seg*2*Math.PI;
        pts.push([cx+rx*Math.cos(t), cy+ry*Math.sin(t)]);
      }
      return pts;
    };

    start();
    const shape = cfg.shape;
    const d = cfg.dims;
    let bbox=[0,0,0,0];

    if(shape==='rectangle'){
      rect(0,0,d.L,d.W,'CUT'); bbox=[0,0,d.L,d.W];
      text(d.L/2, d.W+2.0, 0.35, `Rectangle ${d.L}" × ${d.W}"`, 'TEXT');
    } else if(shape==='circle'){
      circle(d.D/2, d.D/2, d.D/2, 'CUT'); bbox=[0,0,d.D,d.D];
      text(d.D/2, d.D+2.0, 0.35, `Circle Ø ${d.D}"`, 'TEXT');
    } else if(shape==='polygon'){
      const n=d.n||6; const s=d.A;
      const R = s/(2*Math.sin(Math.PI/n));
      const cx=R, cy=R;
      const pts=[]; for(let i=0;i<n;i++){ const ang=i*(2*Math.PI/n); pts.push([cx+R*Math.cos(ang), cy+R*Math.sin(ang)]); }
      lwpoly(pts, true, 'CUT'); bbox=[0,0,2*R,2*R];
      text(R, 2*R+2.0, 0.35, `${n}-gon, side ${s}"`, 'TEXT');
    }

    // Backsplash OUTSIDE slab with 1" gap
    if(shape==='rectangle' && cfg.backsplash){
      const polished = cfg.edges || [];
      const sides=['top','right','bottom','left'];
      const unpol = sides.filter(k => !polished.includes(k));
      const gap=1;
      const L=d.L, W=d.W;
      unpol.forEach(side=>{
        if(side==='top')    rect(0, W+gap, L, 4, 'BACKSPLASH');
        if(side==='bottom') rect(0, -gap-4, L, 4, 'BACKSPLASH');
        if(side==='left')   rect(-gap-4, 0, 4, W, 'BACKSPLASH');
        if(side==='right')  rect(L+gap, 0, 4, W, 'BACKSPLASH');
      });
    }

    // Sink cutouts + faucet holes
    if(shape==='rectangle' && Array.isArray(cfg.sinks)){
      cfg.sinks.forEach(s=>{
        const tpl = SINK_TEMPLATES[s.key];
        if(!tpl) return;

        const x0 = s.x - tpl.w/2;
        const y0 = s.y - tpl.h/2;

        if(tpl.shape==='oval') lwpoly(ellipsePoly(s.x, s.y, tpl.w/2, tpl.h/2, 120), true, 'CUT');
        else rect(x0, y0, tpl.w, tpl.h, 'CUT');

        // Faucet holes: 1 or 3, Ø1.25", 2" above sink cutout
        const r = 1.25/2;
        const holeY = y0 - 2;
        const cx = s.x;

        if(s.faucet==='3' && (s.spread===4 || s.spread===8)){
          const off = (s.spread/2);
          circle(cx - off, holeY, r, 'HOLES');
          circle(cx,       holeY, r, 'HOLES');
          circle(cx + off, holeY, r, 'HOLES');
        } else {
          circle(cx, holeY, r, 'HOLES');
        }
      });
    }

    // Polished edges note
    if(shape==='rectangle'){
      const edges = (cfg.edges||[]).map(e=>e[0].toUpperCase()+e.slice(1)).join(', ') || 'None';
      text(0, (bbox[3]||0)+6, 0.35, `Polished edges: ${edges}`, 'TEXT');
    }

    return finish();
  }

  // Email DXF (client -> server)
  el('#rcg-email-dxf', appRoot).onclick = async () => {
    try{
      const email = (el('#rcg-email', appRoot)?.value || '').trim();
      if(!email){ alert('Enter an email address to send the DXF.'); return; }

      const cfg = currentConfig();
      const dxfText = buildDXF(cfg);
      const dxfBase64 = btoa(unescape(encodeURIComponent(dxfText)));

      const res = await fetch('/api/email-dxf', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({
          to: email,
          bcc: BUSINESS_EMAIL,
          subject: 'Rock Creek Granite – Your DXF Cut Sheet',
          config: cfg,
          dxfBase64
        })
      });

      if(!res.ok){
        const t = await res.text();
        throw new Error(t || 'Email failed');
      }
      alert('DXF sent. Please check your inbox.');
    } catch(err){
      console.error(err);
      alert('Sorry — unable to send the DXF right now.');
    }
  };

  // -----------------------------
  // Desktop: draggable panel (smooth, no “cursor hop”)
  // -----------------------------
  const panel = el('#rcg-panel', appRoot);
  const handle = el('#rcg-panel-handle', appRoot);

  function setHandleMode() {
    if (!handle) return;
    handle.classList.toggle('desktop-draggable', isDesktop());
  }

  (function enablePanelDrag(){
    if(!panel || !handle) return;

    let dragging = false;
    let grabOffsetX = 0;
    let grabOffsetY = 0;

    function getBoundsRect() {
      // constrain within the whole configurator body so it never disappears
      const body = el('.rcg-body', appRoot);
      return body ? body.getBoundingClientRect() : document.documentElement.getBoundingClientRect();
    }

    function onDown(e){
      if(!isDesktop()) return;
      dragging = true;

      const pr = panel.getBoundingClientRect();
      grabOffsetX = e.clientX - pr.left;
      grabOffsetY = e.clientY - pr.top;

      handle.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';

      // switch to left/top positioning (removes "right" anchoring)
      panel.style.right = 'auto';

      e.preventDefault();
    }

    function onMove(e){
      if(!dragging) return;

      const bounds = getBoundsRect();
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;

      // desired top-left (absolute in viewport)
      let left = e.clientX - grabOffsetX;
      let top  = e.clientY - grabOffsetY;

      // constrain inside bounds
      const minL = bounds.left + 8;
      const minT = bounds.top + 8;
      const maxL = bounds.right - pw - 8;
      const maxT = bounds.bottom - ph - 8;

      left = clamp(left, minL, maxL);
      top  = clamp(top,  minT, maxT);

      // convert viewport coords to parent-relative coords
      const parent = panel.offsetParent || panel.parentElement;
      const parentRect = parent.getBoundingClientRect();
      panel.style.left = `${Math.round(left - parentRect.left)}px`;
      panel.style.top  = `${Math.round(top  - parentRect.top)}px`;
    }

    function onUp(){
      dragging = false;
      handle.style.cursor = isDesktop() ? 'grab' : '';
      document.body.style.userSelect = '';
    }

    handle.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  })();

  // -----------------------------
  // Mobile: keep preview tappable above bottom sheet
  // -----------------------------
  let ro = null;
  function syncMobilePreviewInset() {
    const preview = el('.rcg-preview', appRoot);
    const panel = el('#rcg-panel', appRoot);
    if(!preview || !panel) return;

    const apply = () => {
      if(!isMobile()){
        preview.style.removeProperty('--rcg-sheet-h');
        return;
      }
      const h = panel.getBoundingClientRect().height || 0;
      preview.style.setProperty('--rcg-sheet-h', `${Math.ceil(h)}px`);
    };

    apply();
    if (ro) ro.disconnect();
    ro = new ResizeObserver(apply);
    ro.observe(panel);
  }

  // -----------------------------
  // Init
  // -----------------------------
  renderShapeIcons(el('#shape-icons', appRoot));
  setHandleMode();
  window.addEventListener('resize', () => { setHandleMode(); syncMobilePreviewInset(); });

  setShapeFromIcon('square');
  refreshSinkPills();
  goto(1);

  // If user opens modal later, ensure inset is correct
  syncMode();

})();