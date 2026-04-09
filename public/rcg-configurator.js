/* =============================
   RCG CONFIGURATOR - PRODUCTION BUILD
   - Mounts into: <div id="rcg-configurator-launch"></div>
   - Desktop: inline
   - Mobile: launch button -> fullscreen modal
   - Checkout redirect: /config-checkout?cfg=...
   - Email DXF: POST /api/email-dxf
   Improvements:
   - mount guard scoped to the mount node
   - preloader preserved and hidden only after real boot
   - no requestIdleCallback delay on first paint
   - emits rcg:ready and rcg:error events for the embed wrapper
   - does not block checkout redirect on DXF email
============================= */

(() => {
  const mount = document.getElementById('rcg-configurator-launch');
  if (!mount) return;

  if (mount.dataset.rcgMounted === '1') return;
  mount.dataset.rcgMounted = '1';
  mount.dataset.rcgStatus = 'booting';

  function emit(name, detail) {
    try {
      mount.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (err) {
      // no-op
    }
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail || {} }));
    } catch (err) {
      // no-op
    }
  }

  const preload = mount.querySelector('[data-rcg-preload]');
  function setPreloadMessage(message) {
    if (!preload) return;
    const sub = preload.querySelector('.rcg-preload-sub');
    if (sub && message) sub.textContent = message;
  }

  function setPreloadCta(html) {
    if (!preload) return;
    const cta = preload.querySelector('.rcg-preload-cta');
    if (cta && html) cta.innerHTML = html;
  }

  function hidePreload() {
    if (!preload) return;
    preload.classList.add('rcg-preload--done');
    preload.addEventListener('transitionend', () => {
      try { preload.remove(); } catch (err) {}
    }, { once: true });
    setTimeout(() => {
      try { preload.remove(); } catch (err) {}
    }, 450);
  }

  function failBoot(message) {
    mount.dataset.rcgStatus = 'error';
    setPreloadMessage(message || 'The configurator could not be loaded right now.');
    setPreloadCta('<a href="https://www.rockcreekgranite.com/configurator" target="_blank" rel="noopener">Open in new tab</a>');
    emit('rcg:error', { message: message || 'boot failed' });
  }

  const LOGO_URL = mount.dataset.logo || '';

  const MAX_LEN = 72;
  const MAX_WID = 60;
  const MAX_DIAM = 60;

  const MIN_SINK_EDGE = 4;
  const MIN_SINK_GAP = 4;

  const DOLLARS_PER_SQFT = 55;
  const SINK_PRICES = { 'bath-oval': 80, 'bath-rect': 95, 'kitchen-rect': 150 };
  const DEFAULT_COLOR = 'bergen';

  const LBS_PER_SQFT = 10.9;
  const LTL_CWT_BASE = 35.9;
  const BUSINESS_EMAIL = 'orders@rockcreekgranite.com';
  const ORIGIN_ZIP_DEFAULT = mount.dataset.originZip || '63052';

  const DISTANCE_BANDS = [
    { max: 250, mult: 1.00 },
    { max: 600, mult: 1.25 },
    { max: 1000, mult: 1.50 },
    { max: 1500, mult: 1.70 },
    { max: Infinity, mult: 1.85 }
  ];

  const STEP_LABELS = {
    1: 'Define your shape',
    2: 'Choose Polished Sides',
    3: 'Add Sinks and Faucet Holes',
    4: 'Select Stone and Ship'
  };

  const STEP_INSTRUCTIONS = {
    1: 'Select your starting geometry',
    2: 'Select edges to be flat polished',
    3: 'Include and position sinks',
    4: 'Preview your stone color'
  };

  const COLORS = [
    { key: 'laurent', name: 'Laurent', url: 'https://assetstools.cosentino.com/api/v1/bynder/color/PTL/detalle/PTL-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format' },
    { key: 'rem',     name: 'Rem',     url: 'https://assetstools.cosentino.com/api/v1/bynder/color/RKC/detalle/RKC-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format' },
    { key: 'bergen',  name: 'Bergen',  url: 'https://assetstools.cosentino.com/api/v1/bynder/color/BEK/detalle/BEK-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format' },
    { key: 'kreta',   name: 'Kreta',   url: 'https://assetstools.cosentino.com/api/v1/bynder/color/KRE/detalle/KRE-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format' },
    { key: 'sirius',  name: 'Sirius',  url: 'https://assetstools.cosentino.com/api/v1/bynder/color/RS5/detalle/RS5-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format' },
    { key: 'kairos',  name: 'Kairos',  url: 'https://assetstools.cosentino.com/api/v1/bynder/color/KKC/detalle/KKC-thumb.jpg?w=988&h=868&q=80,format&fit=crop&auto=format' }
  ];

  const COLOR_PAGES = {
    laurent: 'https://www.rockcreekgranite.com/colors/laurent',
    rem: 'https://www.rockcreekgranite.com/colors/rem',
    bergen: 'https://www.rockcreekgranite.com/colors/bergen',
    kreta: 'https://www.rockcreekgranite.com/colors/kreta',
    sirius: 'https://www.rockcreekgranite.com/colors/sirius',
    kairos: 'https://www.rockcreekgranite.com/colors/kairos'
  };

  const SINK_TEMPLATES = {
    'bath-oval': { label: 'Bath Oval (17x14)', w: 17, h: 14, shape: 'oval' },
    'bath-rect': { label: 'Bath Rectangle (18x13)', w: 18, h: 13, shape: 'rect' },
    'kitchen-rect': { label: 'Kitchen Stainless (22x16)', w: 22, h: 16, shape: 'rect' }
  };

  const el = (sel, root) => (root || document).querySelector(sel);
  const els = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const uid = () => Math.random().toString(36).slice(2, 9);
  const fmt2 = (v) => (isFinite(v) ? Number(v).toFixed(2) : '0.00');
  const isMobile = () => window.matchMedia('(max-width: 980px)').matches;
  const isDesktop = () => window.matchMedia('(min-width: 981px)').matches;

  function areaSqft(shape, d) {
    switch (shape) {
      case 'rectangle': return (d.L * d.W) / 144;
      case 'circle': return Math.PI * Math.pow(d.D / 2, 2) / 144;
      case 'polygon': {
        const n = d.n || 6;
        const s = d.A || 12;
        return ((n * s * s) / (4 * Math.tan(Math.PI / n))) / 144;
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
    return DISTANCE_BANDS.find((b) => approxMiles <= b.max).mult;
  }

  function shippingEstimate(area, destZip, originZip) {
    const weight = area * LBS_PER_SQFT;
    const cwt = Math.max(1, Math.ceil(weight / 100));
    const mult = distanceBand(originZip || ORIGIN_ZIP_DEFAULT, destZip);
    const base = cwt * LTL_CWT_BASE * mult;
    return { weight, cwt, mult, ltl: base * 1.20 };
  }

  const CSS = `
    :root{
      --rcg-black:#0b0b0b;
      --rcg-yellow:#ffc400;
      --rcg-gray:#f3f3f0;
      --rcg-muted:#6b7280;
    }

    #rcg-configurator-launch{ position:relative; }

    #rcg-configurator-launch [data-rcg-preload].rcg-preload--done{
      opacity:0;
      transform:translateY(6px);
      pointer-events:none;
    }

    .rcg-root, .rcg-root *{
      font-family:'Barlow', system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      box-sizing:border-box;
      border-radius:0 !important;
    }

    .rcg-inline-host{ width:100%; position:relative; }
    .rcg-launch-wrap{ width:100%; justify-content:center; margin:10px 0 0; display:none; }
    .rcg-launch{
      background:var(--rcg-yellow);
      color:#000;
      font-weight:900;
      padding:14px 18px;
      border:none;
      cursor:pointer;
      width:min(520px,100%);
      font-size:16px;
    }

    .rcg-modal{ position:fixed; inset:0; z-index:999999; background:rgba(0,0,0,.65); display:none; padding:0; }
    .rcg-modal[aria-hidden="false"]{ display:flex; }
    .rcg-window{ background:#fff; width:100%; height:100%; display:flex; flex-direction:column; overflow:hidden; }

    .rcg-topbar{
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding:10px 12px;
      background:#fff;
      color:#111;
      border-bottom:1px solid #e6e6e6;
      gap:10px;
    }
    .rcg-topbar .left{ display:flex; align-items:center; gap:10px; min-width:0; }
    .rcg-topbar .meta{ font-size:12px; color:#555; white-space:nowrap; font-weight:900; }
    .rcg-logo{ width:64px; height:64px; object-fit:contain; display:none; }
    .rcg-logo.rcg-has{ display:block; }
    .rcg-close{
      appearance:none;
      border:1px solid rgba(0,0,0,.2);
      background:transparent;
      color:#111;
      width:44px;
      height:44px;
      display:flex;
      align-items:center;
      justify-content:center;
      cursor:pointer;
      font-weight:900;
    }

    .rcg-app{ width:100%; position:relative; }
    .rcg-body{
      width:100%;
      display:flex;
      flex-direction:column;
      min-height:720px;
      position:relative;
      background:#fff;
      border:1px solid #e5e5e5;
      overflow:hidden;
    }
    .rcg-preview{ flex:1; min-height:0; background:#fff; position:relative; overflow:hidden; }
    .rcg-stage{ width:100%; height:100%; display:block; touch-action:none; }

    .rcg-panel{ background:var(--rcg-gray); padding:12px; line-height:1.2; }
    .rcg-panel-handle{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      padding:10px;
      background:#fff;
      border:1px solid #cfcfcf;
      margin-bottom:10px;
      user-select:none;
    }

    .rcg-btn{
      background:var(--rcg-yellow);
      color:#000;
      font-weight:900;
      padding:10px 16px;
      border:none;
      cursor:pointer;
      height:44px;
      display:inline-flex;
      align-items:center;
      justify-content:center;
    }
    .rcg-btn[disabled]{ opacity:.5; cursor:not-allowed; }
    .rcg-btn.outline{ background:#fff; color:#000; border:1px solid #000; }
    .rcg-icon-btn{ width:44px; padding:0; font-size:22px; line-height:1; }

    .rcg-title{ font-size:22px; font-weight:900; margin:0 0 8px; color:var(--rcg-black); display:flex; align-items:center; gap:10px; }
    .rcg-sub{ color:var(--rcg-muted); font-size:13px; margin:6px 0; line-height:1.2; font-weight:500; }
    .rcg-row{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .rcg-input{ width:110px; padding:8px 10px; border:1px solid #cfcfcf; background:#fff; color:#111; font-weight:600; height:44px; }
    .rcg-label{ font-weight:900; color:#111; }
    .rcg-hidden{ display:none !important; }

    .shape-icons{ display:flex; gap:12px; flex-wrap:nowrap; }
    .shape-iso{ width:160px; height:80px; background:transparent; border:none; padding:0; cursor:pointer; display:grid; place-items:center; }
    .shape-iso svg{ width:100%; height:100%; stroke:#000; stroke-width:1; fill:none; }
    .shape-iso.active svg{ stroke:var(--rcg-yellow); }
    @media (max-width:640px){
      .shape-iso{ width:calc(33.333% - 8px); height:calc((33.333% - 8px)/2); }
    }

    .rcg-step4-title{ justify-content:flex-start; flex-wrap:wrap; gap:10px; width:100%; }
    #rcg-color-link{
      display:inline-flex;
      align-items:center;
      justify-content:center;
      height:22px;
      padding:0 10px;
      border:1px solid #d7d7d3;
      background:rgba(255,255,255,0.35);
      color:#111;
      font-weight:900;
      font-size:13px;
      line-height:1;
      white-space:nowrap;
      text-decoration:none !important;
      border-radius:999px;
    }
    #rcg-color-link:hover{ background:rgba(255,255,255,0.55); opacity:1; }
    #rcg-color-link:active{ transform:translateY(1px); }
    #rcg-color-link span{ margin-left:6px; }

    .rcg-edge-status{
      display:flex;
      align-items:flex-start;
      gap:10px;
      background:#fff;
      border:1px solid #cfcfcf;
      padding:10px;
      margin:6px 0 0;
    }
    .rcg-edge-icon{ display:inline-flex; gap:4px; width:26px; height:26px; flex:0 0 auto; align-items:center; justify-content:center; }
    .rcg-edge-icon .line{ display:inline-block; height:18px; }
    .rcg-edge-icon .thin{ width:3px; background:#111; }
    .rcg-edge-icon .thick{ width:6px; background:var(--rcg-yellow); }
    .rcg-edge-status .txt .t{ font-weight:900; font-size:13px; color:#111; line-height:1.1; }
    .rcg-edge-status .txt .s{ margin-top:2px; font-weight:600; font-size:12px; color:var(--rcg-muted); line-height:1.2; }

    .rcg-callout{
      position:absolute;
      left:12px;
      top:12px;
      background:#111;
      color:#fff;
      padding:10px 12px;
      font-weight:900;
      font-size:13px;
      z-index:20;
      max-width:70%;
    }

    .sink-controls{ display:flex; gap:10px; align-items:center; width:100%; }
    #rcg-sink-select{ flex:1; min-width:220px; height:44px; }
    #rcg-add-sink{ height:44px; width:44px; padding:0; }
    .sink-chip{
      display:flex;
      align-items:center;
      gap:8px;
      padding:8px 12px;
      background:#fff;
      font-size:13px;
      border:1px solid #cfcfcf;
      overflow:hidden;
    }
    .sink-chip button{
      border:1px solid #000;
      background:#fff;
      cursor:pointer;
      width:28px;
      height:28px;
      line-height:26px;
      font-weight:900;
    }
    .sink-chip .rcg-input{ width:96px; height:36px; }
    .sink-chip select[data-spread]{ width:64px; height:36px; }

    @media (max-width:980px){
      .rcg-inline-host{ display:none; }
      .rcg-launch-wrap{ display:flex; }
      .rcg-window{ height:100vh; height:100dvh; }
      .rcg-modal-body{ height:calc(100vh - 64px); height:calc(100dvh - 64px); overflow:hidden; }
      .rcg-app, .rcg-body{ height:100%; min-height:0; }
      .rcg-preview{ padding-bottom:calc(var(--rcg-sheet-h, 0px) + 10px); }
      .rcg-panel{
        position:absolute;
        left:0;
        right:0;
        bottom:0;
        height:56dvh;
        max-height:62dvh;
        overflow:auto;
        border-top:2px solid #ddd;
        padding-bottom:calc(12px + env(safe-area-inset-bottom));
      }
      .rcg-topbar{ display:grid; grid-template-columns:64px 1fr 64px; align-items:center; }
      .rcg-topbar .meta{ justify-self:center; font-size:14px; font-weight:900; }
      .rcg-logo{ width:62px; height:62px; }
      #rcg-pane-meta{ display:none; }
      #rcg-pane-label{ font-weight:900; font-size:14px; line-height:1.15; color:#111; max-width:52vw; white-space:normal; }
      .rcg-step{ animation:rcgSlideIn .18s ease-out; }
      @keyframes rcgSlideIn{
        from{ transform:translateX(14px); opacity:0; }
        to{ transform:translateX(0); opacity:1; }
      }
      #rcg-dims{ display:flex; flex-direction:column; gap:12px; align-items:stretch; }
      .rcg-dimrow{ display:grid; grid-template-columns:108px 1fr auto auto; gap:8px; align-items:center; }
      .rcg-dimrow .rcg-label{ white-space:nowrap; line-height:1; }
      .rcg-stepper{ height:40px; width:40px; border:1px solid #000; background:#fff; font-weight:900; cursor:pointer; font-size:16px; line-height:1; padding:0; }
      .rcg-dimrow{ column-gap:0 !important; }
      .rcg-dimrow .rcg-input{ margin-right:8px; }
      .rcg-stepper + .rcg-stepper{ border-left:0 !important; }
      .rcg-title{ margin-top:14px; margin-bottom:10px; }
      #rcg-step2 .rcg-edge-status,
      #rcg-step3 .sink-controls,
      #rcg-step4 #rcg-stone-zip-row{ margin-top:18px; }
      #rcg-back{ position:relative; top:1px; }
      #rcg-stone-zip-row{ flex-wrap:nowrap !important; gap:8px !important; align-items:center; }
      #rcg-stone-zip-row label{ white-space:nowrap; }
      #rcg-color{ min-width:140px !important; width:140px !important; flex:0 0 auto !important; }
      #rcg-zip{ width:92px !important; flex:0 0 auto !important; }
    }

    @media (min-width:981px){
      .rcg-modal{ display:none !important; }
      .rcg-launch-wrap{ display:none !important; }
      .rcg-preview{ height:clamp(340px, 48vh, 520px); flex:0 0 auto; }
      .rcg-panel{
        position:absolute;
        right:16px;
        top:16px;
        width:520px;
        max-width:min(520px, 92vw);
        box-shadow:0 8px 20px rgba(0,0,0,.12);
        z-index:50;
      }
      .rcg-stepper{ display:none; }
      #rcg-pane-label{ display:none; }
      #rcg-pane-meta{ display:block; font-size:18px !important; font-weight:400 !important; letter-spacing:.2px; color:#111; white-space:nowrap; }
      #rcg-color-link{ position:relative; top:1px; }
    }
  `;

  if (!mount.querySelector('style[data-rcg-style]')) {
    const styleTag = document.createElement('style');
    styleTag.setAttribute('data-rcg-style', '1');
    styleTag.textContent = CSS;
    mount.appendChild(styleTag);
  }

  const oldRoot = mount.querySelector('.rcg-root');
  if (oldRoot) oldRoot.remove();

  const shell = document.createElement('div');
  shell.className = 'rcg-root';
  shell.innerHTML = `
    <div class="rcg-launch-wrap">
      <button class="rcg-launch" id="rcg-open">Start Your Project Order</button>
    </div>

    <div class="rcg-inline-host" id="rcg-inline-host"></div>

    <div class="rcg-modal" id="rcg-modal" aria-hidden="true">
      <div class="rcg-window">
        <div class="rcg-topbar">
          <div class="left">
            <img class="rcg-logo ${LOGO_URL ? 'rcg-has' : ''}" ${LOGO_URL ? `src="${LOGO_URL}"` : ''} alt="">
            <div style="position:absolute;left:-9999px;">Rock Creek Granite</div>
          </div>

          <div class="meta" id="rcg-stepper-top">Step 1 of 4</div>

          <button class="rcg-close" id="rcg-close" aria-label="Close">x</button>
        </div>

        <div class="rcg-modal-body" id="rcg-modal-body"></div>
      </div>
    </div>
  `;
  mount.appendChild(shell);

  function appHTML() {
    return `
      <div class="rcg-app" id="rcg-app">
        <div class="rcg-body">
          <div class="rcg-preview">
            <svg id="rcg-svg" class="rcg-stage" viewBox="0 0 1400 600" preserveAspectRatio="xMidYMid meet"></svg>
            <div id="rcg-edge-callout" class="rcg-callout rcg-hidden" role="status" aria-live="polite">Tap edges to toggle polish</div>
          </div>

          <aside class="rcg-panel" id="rcg-panel">
            <div class="rcg-panel-handle" id="rcg-panel-handle" title="Drag to move (desktop)">
              <div class="rcg-pane-left">
                <div class="step"><span id="rcg-pane-label"></span></div>
                <div id="rcg-pane-meta"></div>
              </div>
              <div class="rcg-pane-actions">
                <button class="rcg-btn outline rcg-icon-btn" id="rcg-back" aria-label="Back" title="Back">&lt;</button>
                <button class="rcg-btn" id="rcg-next">Next</button>
              </div>
            </div>

            <div id="rcg-step1" class="rcg-step">
              <div class="rcg-title" id="rcg-instr-1"></div>
              <div class="shape-icons" id="shape-icons"></div>
              <div style="margin-top:10px" class="rcg-row" id="rcg-dims"></div>
              <div class="rcg-sub" id="rcg-size-note"></div>
            </div>

            <div id="rcg-step2" class="rcg-step rcg-hidden">
              <div class="rcg-title" id="rcg-instr-2"></div>

              <div class="rcg-edge-status" id="rcg-edge-status" aria-live="polite">
                <span class="rcg-edge-icon" aria-hidden="true">
                  <span class="line thin"></span><span class="line thick"></span>
                </span>
                <div class="txt">
                  <div class="t" id="rcg-edge-status-title">Polished edges selected</div>
                  <div class="s" id="rcg-edge-status-sub">Tap an edge to toggle polished or not-polished.</div>
                </div>
              </div>

              <label class="rcg-row" style="margin-top:10px; align-items:center; gap:10px; cursor:pointer">
                <input id="rcg-backsplash" type="checkbox" style="width:18px;height:18px">
                <span class="rcg-label">Add 4\" Backsplash</span>
              </label>
              <div class="rcg-sub" id="rcg-backsplash-note">Backsplash applies to all not-polished sides.</div>
            </div>

            <div id="rcg-step3" class="rcg-step rcg-hidden">
              <div class="rcg-title" id="rcg-instr-3"></div>

              <div id="rcg-sinks-block" class="rcg-hidden" style="margin-top:8px">
                <div class="sink-controls" style="margin-bottom:6px">
                  <button class="rcg-btn outline" id="rcg-add-sink" title="Add sink">+</button>
                  <select class="rcg-input" id="rcg-sink-select">
                    ${Object.entries(SINK_TEMPLATES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join('')}
                  </select>
                </div>

                <div id="rcg-sink-pills" style="display:grid; gap:8px"></div>
                <div class="rcg-sub" id="rcg-sink-disclosure">Sinks must be >= ${MIN_SINK_EDGE}\" from edges and >= ${MIN_SINK_GAP}\" from each other. Drag sinks in the preview.</div>
              </div>

              <div id="rcg-nonrect-note" class="rcg-sub rcg-hidden">Sink placement is available for rectangles only.</div>
            </div>

            <div id="rcg-step4" class="rcg-step rcg-hidden">
              <div class="rcg-title rcg-step4-title">
                <span id="rcg-instr-4"></span>
                <a id="rcg-color-link" href="#" target="_blank" rel="noopener">See it up close<span aria-hidden="true">&gt;</span></a>
              </div>

              <div class="rcg-row" id="rcg-stone-zip-row" style="margin-bottom:10px; width:100%">
                <label class="rcg-label">Stone</label>
                <select class="rcg-input" id="rcg-color" style="flex:1; min-width:220px">
                  ${COLORS.map((c) => `<option value="${c.key}">${c.name}</option>`).join('')}
                </select>

                <label class="rcg-label">ZIP</label>
                <input class="rcg-input" id="rcg-zip" placeholder="ZIP code" maxlength="5" inputmode="numeric" pattern="\\d{5}" style="width:120px">
              </div>

              <div class="rcg-sub" id="rcg-zip-disclosure">Ensure ZIP is final delivery location; priced at checkout.</div>
            </div>
          </aside>
        </div>
      </div>
    `;
  }

  const inlineHost = el('#rcg-inline-host', shell);
  const modal = el('#rcg-modal', shell);
  const modalBody = el('#rcg-modal-body', shell);
  const openBtn = el('#rcg-open', shell);
  const closeBtn = el('#rcg-close', shell);

  const appWrap = document.createElement('div');
  appWrap.innerHTML = appHTML();
  const appRoot = appWrap.firstElementChild;

  function attachAppToDesktop() {
    if (!inlineHost.contains(appRoot)) inlineHost.appendChild(appRoot);
  }
  function attachAppToModal() {
    if (!modalBody.contains(appRoot)) modalBody.appendChild(appRoot);
  }
  function detachApp() {
    if (inlineHost.contains(appRoot)) inlineHost.removeChild(appRoot);
    if (modalBody.contains(appRoot)) modalBody.removeChild(appRoot);
  }

  function openModal() {
    detachApp();
    attachAppToModal();
    modal.setAttribute('aria-hidden', 'false');
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    syncMobilePreviewInset();
    drawShape();
  }

  function closeModal() {
    modal.setAttribute('aria-hidden', 'true');
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }

  function syncMode() {
    if (isDesktop()) {
      closeModal();
      detachApp();
      attachAppToDesktop();
      setHandleMode();
      const preview = el('.rcg-preview', appRoot);
      if (preview) preview.style.removeProperty('--rcg-sheet-h');
    } else {
      detachApp();
      setHandleMode();
    }
  }

  if (openBtn) openBtn.addEventListener('click', () => { if (isMobile()) openModal(); });
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (modal) modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });

  const state = {
    stepOrder: [1, 2, 3, 4],
    stepId: 1,
    shape: null,
    dims: {},
    sinks: [],
    color: DEFAULT_COLOR,
    edges: [],
    area: 0,
    activeIcon: 'square',
    backsplash: false,
    step2Initialized: false
  };

  function getStepOrder() {
    return state.shape === 'rectangle' ? [1, 2, 3, 4] : [1, 4];
  }
  function stepTotal() { return state.stepOrder.length; }
  function stepIndex() { return Math.max(0, state.stepOrder.indexOf(state.stepId)); }

  function updateColorLink() {
    const a = el('#rcg-color-link', appRoot);
    if (!a) return;
    const key = state.color || DEFAULT_COLOR;
    const href = COLOR_PAGES[key] || COLOR_PAGES[DEFAULT_COLOR] || '#';
    a.href = href;
    a.style.display = href === '#' ? 'none' : '';
  }

  function updateSizeDisclosure() {
    const note = el('#rcg-size-note', appRoot);
    if (!note) return;
    if (state.shape === 'rectangle') note.textContent = `Max size ${MAX_LEN}\" length and ${MAX_WID}\" height.`;
    else if (state.shape === 'circle') note.textContent = `Max size ${MAX_DIAM}\" diameter.`;
    else if (state.shape === 'polygon') note.textContent = `Max size not to exceed ${MAX_DIAM}\" total width/height.`;
    else note.textContent = '';
  }

  function initStep2DefaultsIfNeeded() {
    if (state.shape !== 'rectangle' || state.step2Initialized) return;
    state.edges = ['left', 'right', 'bottom'];
    state.step2Initialized = true;
  }

  function updateEdgeStatusUI() {
    const title = el('#rcg-edge-status-title', appRoot);
    const sub = el('#rcg-edge-status-sub', appRoot);
    if (!title || !sub) return;
    if (state.edges.length === 0) {
      title.textContent = 'No polished edges selected';
      sub.textContent = 'Tap an edge to mark it polished.';
    } else {
      title.textContent = 'Polished edges selected';
      sub.textContent = 'Tap an edge to toggle polished or not-polished.';
    }
  }

  function updateBacksplashAvailability() {
    if (state.shape !== 'rectangle') return;
    const cb = el('#rcg-backsplash', appRoot);
    const note = el('#rcg-backsplash-note', appRoot);
    if (!cb) return;
    const all = ['top', 'right', 'bottom', 'left'].every((k) => state.edges.includes(k));
    if (all) {
      cb.checked = false;
      cb.disabled = true;
      state.backsplash = false;
      if (note) note.textContent = 'Backsplash is available only on not-polished sides. Unselect an edge to enable.';
    } else {
      cb.disabled = false;
      if (note) note.textContent = 'Backsplash applies to all not-polished sides.';
    }
  }

  function maybeShowEdgeCallout() {
    if (state.shape !== 'rectangle') return;
    const callout = el('#rcg-edge-callout', appRoot);
    if (!callout) return;
    const key = 'rcg_edge_callout_seen_v2';
    const seen = (() => {
      try { return localStorage.getItem(key) === '1'; } catch (err) { return true; }
    })();
    if (seen) return;
    callout.classList.remove('rcg-hidden');
    setTimeout(() => callout.classList.add('rcg-hidden'), 2400);
    try { localStorage.setItem(key, '1'); } catch (err) {}
  }

  function updateStepHints() {
    const isRect = state.shape === 'rectangle';
    const sinksBlock = el('#rcg-sinks-block', appRoot);
    const note = el('#rcg-nonrect-note', appRoot);
    const onStep3 = state.stepId === 3;
    if (sinksBlock) sinksBlock.classList.toggle('rcg-hidden', !(onStep3 && isRect));
    if (note) note.classList.toggle('rcg-hidden', !(onStep3 && !isRect));
  }

  function updateNav() {
    const back = el('#rcg-back', appRoot);
    const next = el('#rcg-next', appRoot);
    if (!back || !next) return;
    const idx = stepIndex();
    back.style.visibility = idx === 0 ? 'hidden' : 'visible';
    next.textContent = idx === stepTotal() - 1 ? 'Checkout' : 'Next';
    let disableNext = false;
    if (state.stepId === 4) {
      const zip = (el('#rcg-zip', appRoot)?.value || '').trim();
      disableNext = !/^\d{5}$/.test(zip);
    }
    next.disabled = disableNext;
  }

  function showStepId(stepId) {
    state.stepId = stepId;
    els('.rcg-step', appRoot).forEach((s) => s.classList.add('rcg-hidden'));
    const stepEl = el(`#rcg-step${stepId}`, appRoot);
    if (stepEl) stepEl.classList.remove('rcg-hidden');

    const visibleInstr = el(`#rcg-instr-${stepId}`, appRoot);
    if (visibleInstr) visibleInstr.textContent = STEP_INSTRUCTIONS[stepId] || '';

    const idx = stepIndex();
    const top = el('#rcg-stepper-top', shell);
    if (top) top.textContent = `Step ${idx + 1} of ${stepTotal()}`;

    const paneLabel = el('#rcg-pane-label', appRoot);
    const paneMeta = el('#rcg-pane-meta', appRoot);
    if (isDesktop()) {
      if (paneMeta) paneMeta.textContent = `Step ${idx + 1}`;
      if (paneLabel) paneLabel.textContent = '';
    } else {
      if (paneLabel) paneLabel.textContent = STEP_LABELS[stepId] || '';
      if (paneMeta) paneMeta.textContent = '';
    }

    if (stepId === 2 && state.shape === 'rectangle') {
      initStep2DefaultsIfNeeded();
      updateEdgeStatusUI();
      updateBacksplashAvailability();
      maybeShowEdgeCallout();
    }
    if (stepId === 4) updateColorLink();

    const sinkDisclosure = el('#rcg-sink-disclosure', appRoot);
    if (sinkDisclosure && isMobile()) {
      sinkDisclosure.textContent = `Sinks must be >= ${MIN_SINK_EDGE}\" from edges and >= ${MIN_SINK_GAP}\" from each other.`;
    }

    drawShape();
    updateNav();
    updateStepHints();
    syncMobilePreviewInset();
  }

  function gotoNext() {
    const idx = stepIndex();
    if (idx < stepTotal() - 1) showStepId(state.stepOrder[idx + 1]);
  }
  function gotoPrev() {
    const idx = stepIndex();
    if (idx > 0) showStepId(state.stepOrder[idx - 1]);
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

  function bindSteppers(container) {
    els('[data-stepper]', container).forEach((btn) => {
      btn.addEventListener('click', () => {
        const code = btn.getAttribute('data-stepper');
        const dir = code[0] === '+' ? 1 : -1;
        const which = code.slice(1);
        const input = el(`#dim-${which}`, appRoot);
        if (!input) return;

        const cur = parseFloat(input.value || '0') || 0;
        let step = 1.5;
        if (which === 'N') step = 1;
        if (which === 'A') step = 0.5;

        let max = parseFloat(input.max || '999999');
        if (which === 'L') max = MAX_LEN;
        if (which === 'W') max = MAX_WID;
        if (which === 'D') max = MAX_DIAM;

        let next = cur + dir * step;
        if (which === 'N') {
          next = clamp(next, 5, 18);
          input.value = String(Math.round(next));
          const nNow = clamp(parseInt(input.value || '6', 10), 5, 18);
          const sMaxNow = (MAX_DIAM * Math.sin(Math.PI / nNow)).toFixed(2);
          const a = el('#dim-A', appRoot);
          if (a) {
            a.max = sMaxNow;
            if (parseFloat(a.value) > parseFloat(sMaxNow)) a.value = sMaxNow;
          }
        } else {
          next = clamp(next, 1, max);
          input.value = fmt2(next);
        }

        readDims();
        updateSizeDisclosure();
        drawShape();
      });
    });
  }

  function buildDimInputs() {
    const h = el('#rcg-dims', appRoot);
    if (!h) return;

    if (!state.shape) {
      h.innerHTML = '<div class="rcg-sub">Choose a shape to set measurements.</div>';
      return;
    }

    if (state.shape === 'rectangle') {
      if (isMobile()) {
        h.innerHTML = `
          <div class="rcg-dimrow">
            <label class="rcg-label">Length (in)</label>
            <input class="rcg-input" id="dim-L" type="number" step="0.125" min="1" max="${MAX_LEN}" value="${fmt2(state.dims.L || 36)}">
            <button class="rcg-stepper" data-stepper="-L" type="button">-</button>
            <button class="rcg-stepper" data-stepper="+L" type="button">+</button>
          </div>
          <div class="rcg-dimrow">
            <label class="rcg-label">Width (in)</label>
            <input class="rcg-input" id="dim-W" type="number" step="0.125" min="1" max="${MAX_WID}" value="${fmt2(state.dims.W || 25.5)}">
            <button class="rcg-stepper" data-stepper="-W" type="button">-</button>
            <button class="rcg-stepper" data-stepper="+W" type="button">+</button>
          </div>
        `;
        bindSteppers(h);
      } else {
        h.innerHTML = `
          <label class="rcg-label">Length (in)</label>
          <input class="rcg-input" id="dim-L" type="number" step="0.125" min="1" max="${MAX_LEN}" value="${fmt2(state.dims.L || 36)}">
          <label class="rcg-label">Width (in)</label>
          <input class="rcg-input" id="dim-W" type="number" step="0.125" min="1" max="${MAX_WID}" value="${fmt2(state.dims.W || 25.5)}">
        `;
      }
    } else if (state.shape === 'circle') {
      if (isMobile()) {
        h.innerHTML = `
          <div class="rcg-dimrow">
            <label class="rcg-label">Diameter (in)</label>
            <input class="rcg-input" id="dim-D" type="number" step="0.125" min="1" max="${MAX_DIAM}" value="${fmt2(state.dims.D || 30)}">
            <button class="rcg-stepper" data-stepper="-D" type="button">-</button>
            <button class="rcg-stepper" data-stepper="+D" type="button">+</button>
          </div>
        `;
        bindSteppers(h);
      } else {
        h.innerHTML = `
          <label class="rcg-label">Diameter (in)</label>
          <input class="rcg-input" id="dim-D" type="number" step="0.125" min="1" max="${MAX_DIAM}" value="${fmt2(state.dims.D || 30)}">
        `;
      }
    } else {
      const n = clamp(state.dims.n || 6, 5, 18);
      const sMax = (MAX_DIAM * Math.sin(Math.PI / n)).toFixed(2);
      if (isMobile()) {
        h.innerHTML = `
          <div class="rcg-dimrow">
            <label class="rcg-label">Sides</label>
            <input class="rcg-input" id="dim-N" type="number" step="1" min="5" max="18" value="${n}">
            <button class="rcg-stepper" data-stepper="-N" type="button">-</button>
            <button class="rcg-stepper" data-stepper="+N" type="button">+</button>
          </div>
          <div class="rcg-dimrow">
            <label class="rcg-label">Side</label>
            <input class="rcg-input" id="dim-A" type="number" step="0.125" min="1" max="${sMax}" value="${fmt2(state.dims.A || 12)}">
            <button class="rcg-stepper" data-stepper="-A" type="button">-</button>
            <button class="rcg-stepper" data-stepper="+A" type="button">+</button>
          </div>
        `;
        bindSteppers(h);
      } else {
        h.innerHTML = `
          <label class="rcg-label">Sides</label>
          <input class="rcg-input" id="dim-N" type="number" step="1" min="5" max="18" value="${n}">
          <label class="rcg-label">Side (in)</label>
          <input class="rcg-input" id="dim-A" type="number" step="0.125" min="1" max="${sMax}" value="${fmt2(state.dims.A || 12)}">
        `;
      }
    }

    h.oninput = () => {
      readDims();
      updateSizeDisclosure();
      drawShape();
    };
    h.onchange = () => {
      ['#dim-L', '#dim-W', '#dim-D', '#dim-A'].forEach((sel) => {
        const i = el(sel, appRoot);
        if (i && i.value !== '') i.value = fmt2(i.value);
      });
      const nInput = el('#dim-N', appRoot);
      if (nInput) {
        const n = clamp(parseInt(nInput.value || '6', 10), 5, 18);
        const sMaxNow = (MAX_DIAM * Math.sin(Math.PI / n)).toFixed(2);
        const a = el('#dim-A', appRoot);
        if (a) {
          a.max = sMaxNow;
          if (parseFloat(a.value) > parseFloat(sMaxNow)) a.value = sMaxNow;
        }
      }
      readDims();
      updateSizeDisclosure();
      drawShape();
    };

    readDims();
    updateSizeDisclosure();
  }

  const ICONS = ['square', 'circle', 'polygon'];
  function isoIcon(name) {
    if (name === 'square') return '<svg viewBox="0 0 64 32"><path d="M14 10 L34 5 L54 10 L34 15 Z"/><path d="M14 10 L14 24 L34 29 L34 15 M54 10 L54 24 L34 29"/></svg>';
    if (name === 'circle') return '<svg viewBox="0 0 64 32"><ellipse cx="32" cy="10" rx="18" ry="5"/><path d="M14 10 v10 c0 4 8 7 18 7 s18-3 18-7 V10"/></svg>';
    return '<svg viewBox="0 0 64 32"><path d="M40 5l12 6-11 5H25L14 11 26 5Zl12 6V22L41 28H25L14 22V11l11 5V28H41V16"/></svg>';
  }

  function renderShapeIcons(container) {
    if (!container) return;
    container.innerHTML = ICONS.map((s) => `<button class="shape-iso" data-icon="${s}" aria-label="${s}">${isoIcon(s)}</button>`).join('');
    els('[data-icon]', container).forEach((btn) => {
      btn.onclick = () => setShapeFromIcon(btn.dataset.icon);
    });
  }

  function setShapeFromIcon(icon) {
    state.activeIcon = icon;
    state.shape = icon === 'square' ? 'rectangle' : icon;
    state.sinks = [];
    state.edges = [];
    state.backsplash = false;
    state.step2Initialized = false;
    state.stepOrder = getStepOrder();
    state.stepId = 1;
    els('[data-icon]', appRoot).forEach((b) => b.classList.toggle('active', b.dataset.icon === icon));
    buildDimInputs();
    showStepId(1);
  }

  const svg = el('#rcg-svg', appRoot);
  const ns = 'http://www.w3.org/2000/svg';
  const defs = document.createElementNS(ns, 'defs');
  const clip = document.createElementNS(ns, 'clipPath');
  clip.setAttribute('id', 'rcgClip');
  const gridG = document.createElementNS(ns, 'g');
  const imageG = document.createElementNS(ns, 'g');
  const shapeG = document.createElementNS(ns, 'g');
  const sinksG = document.createElementNS(ns, 'g');
  const sinkDimsG = document.createElementNS(ns, 'g');
  const edgesG = document.createElementNS(ns, 'g');
  const hotG = document.createElementNS(ns, 'g');
  const dimsG = document.createElementNS(ns, 'g');
  defs.appendChild(clip);
  svg.append(defs, gridG, imageG, shapeG, sinksG, sinkDimsG, edgesG, hotG, dimsG);
  dimsG.setAttribute('pointer-events', 'none');
  sinkDimsG.setAttribute('pointer-events', 'none');

  function drawGrid() {
    gridG.innerHTML = '';
    if (!defs.querySelector('#rcgGridPattern')) {
      const pat = document.createElementNS(ns, 'pattern');
      pat.setAttribute('id', 'rcgGridPattern');
      pat.setAttribute('width', '40');
      pat.setAttribute('height', '40');
      pat.setAttribute('patternUnits', 'userSpaceOnUse');
      const h = document.createElementNS(ns, 'line');
      h.setAttribute('x1', '0'); h.setAttribute('y1', '0'); h.setAttribute('x2', '40'); h.setAttribute('y2', '0'); h.setAttribute('stroke', '#000'); h.setAttribute('stroke-width', '1');
      const v = document.createElementNS(ns, 'line');
      v.setAttribute('x1', '0'); v.setAttribute('y1', '0'); v.setAttribute('x2', '0'); v.setAttribute('y2', '40'); v.setAttribute('stroke', '#000'); v.setAttribute('stroke-width', '1');
      pat.append(h, v);
      defs.appendChild(pat);
    }
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x', '0'); bg.setAttribute('y', '0'); bg.setAttribute('width', '1400'); bg.setAttribute('height', '600'); bg.setAttribute('fill', 'url(#rcgGridPattern)');
    gridG.setAttribute('opacity', '0.12');
    gridG.appendChild(bg);
  }
  drawGrid();

  function getScale() {
    const pad = isMobile() ? 20 : 18;
    const maxW = 1400 - pad * 2;
    const maxH = 600 - pad * 2;
    let widthIn = 36;
    let heightIn = 25.5;
    if (state.shape === 'rectangle') {
      widthIn = state.dims.L || 36;
      heightIn = state.dims.W || 25.5;
    }
    if (state.shape === 'circle') {
      const d = state.dims.D || 30;
      widthIn = d;
      heightIn = d;
    }
    if (state.shape === 'polygon') {
      const n = state.dims.n || 6;
      const A = state.dims.A || 12;
      const diam = polyCircumDiam(n, A);
      widthIn = diam;
      heightIn = diam;
    }
    const s = Math.min(maxW / widthIn, maxH / heightIn) * 0.995;
    const wpx = widthIn * s;
    const hpx = heightIn * s;
    const cx = clamp((1400 - wpx) / 2, pad, 1400 - wpx - pad);
    const cy = clamp((600 - hpx) / 2, pad, 600 - hpx - pad);
    return { s, cx, cy, widthIn, heightIn, wpx, hpx };
  }

  function label(text, x, y) {
    const t = document.createElementNS(ns, 'text');
    t.textContent = text;
    t.setAttribute('x', x);
    t.setAttribute('y', y);
    const mobile = isMobile();
    t.setAttribute('font-weight', '900');
    t.setAttribute('font-size', String(mobile ? 38 : 22));
    t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('fill', '#111');
    t.setAttribute('stroke', '#fff');
    t.setAttribute('stroke-width', String(mobile ? 7 : 4));
    t.setAttribute('paint-order', 'stroke');
    dimsG.appendChild(t);
  }

  function dimText(text, x, y, anchor) {
    const t = document.createElementNS(ns, 'text');
    t.textContent = text;
    t.setAttribute('x', x);
    t.setAttribute('y', y);
    const mobile = isMobile();
    t.setAttribute('font-weight', '900');
    t.setAttribute('font-size', String(mobile ? 30 : 18));
    t.setAttribute('dominant-baseline', 'middle');
    t.setAttribute('text-anchor', anchor || 'middle');
    t.setAttribute('fill', '#111');
    t.setAttribute('stroke', '#fff');
    t.setAttribute('stroke-width', String(mobile ? 7 : 4));
    t.setAttribute('paint-order', 'stroke');
    t.setAttribute('pointer-events', 'none');
    sinkDimsG.appendChild(t);
  }

  function dimLine(x1, y1, x2, y2) {
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('stroke', '#111');
    l.setAttribute('stroke-width', isMobile() ? '3' : '2');
    sinkDimsG.appendChild(l);
  }
  function tick(x1, y1, x2, y2) {
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    l.setAttribute('stroke', '#111');
    l.setAttribute('stroke-width', isMobile() ? '3' : '2');
    sinkDimsG.appendChild(l);
  }

  let activeSinkDrag = null;
  function svgPoint(evt) {
    const p = svg.createSVGPoint();
    p.x = evt.clientX;
    p.y = evt.clientY;
    return p.matrixTransform(svg.getScreenCTM().inverse());
  }

  function drawShape() {
    sinkDimsG.innerHTML = '';
    imageG.innerHTML = '';
    shapeG.innerHTML = '';
    sinksG.innerHTML = '';
    edgesG.innerHTML = '';
    hotG.innerHTML = '';
    dimsG.innerHTML = '';
    if (!state.shape) return;

    const { s, cx, cy, widthIn, wpx, hpx } = getScale();
    let pathEl;
    let bbox = { x: cx, y: cy, width: wpx, height: hpx };

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
    } else {
      const n = state.dims.n || 6;
      const A = state.dims.A || 12;
      const R = (polyCircumDiam(n, A) / 2) * s;
      const cxp = cx + bbox.width / 2;
      const cyp = cy + bbox.height / 2;
      const pts = [];
      for (let i = 0; i < n; i += 1) {
        const ang = i * (2 * Math.PI / n);
        pts.push([cxp + R * Math.cos(ang), cyp + R * Math.sin(ang)]);
      }
      pathEl = document.createElementNS(ns, 'polygon');
      pathEl.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      bbox = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }

    clip.innerHTML = '';
    clip.appendChild(pathEl.cloneNode(true));

    const showTexture = state.stepId === 4 && !!state.color;
    const needsCutMask = showTexture && state.shape === 'rectangle' && state.sinks.length > 0;
    let maskId = null;

    if (needsCutMask) {
      maskId = 'rcgSinkCutMask';
      const old = defs.querySelector(`#${maskId}`);
      if (old) old.remove();
      const mask = document.createElementNS(ns, 'mask');
      mask.setAttribute('id', maskId);
      const full = document.createElementNS(ns, 'rect');
      full.setAttribute('x', '0'); full.setAttribute('y', '0'); full.setAttribute('width', '1400'); full.setAttribute('height', '600'); full.setAttribute('fill', '#fff');
      mask.appendChild(full);
      const rectX = bbox.x;
      const rectY = bbox.y;
      state.sinks.forEach((snk) => {
        const tpl = SINK_TEMPLATES[snk.key];
        if (!tpl) return;
        const halfW = tpl.w / 2;
        const halfH = tpl.h / 2;
        const sinkLeft = rectX + (snk.x - halfW) * s;
        const sinkTop = rectY + (snk.y - halfH) * s;
        const sinkWpx = tpl.w * s;
        const sinkHpx = tpl.h * s;
        let cut;
        if (tpl.shape === 'oval') {
          cut = document.createElementNS(ns, 'ellipse');
          cut.setAttribute('cx', sinkLeft + sinkWpx / 2);
          cut.setAttribute('cy', sinkTop + sinkHpx / 2);
          cut.setAttribute('rx', sinkWpx / 2);
          cut.setAttribute('ry', sinkHpx / 2);
        } else {
          cut = document.createElementNS(ns, 'rect');
          cut.setAttribute('x', sinkLeft);
          cut.setAttribute('y', sinkTop);
          cut.setAttribute('width', sinkWpx);
          cut.setAttribute('height', sinkHpx);
          cut.setAttribute('rx', '4');
        }
        cut.setAttribute('fill', '#000');
        mask.appendChild(cut);
      });
      defs.appendChild(mask);
    }

    if (showTexture) {
      const col = COLORS.find((x) => x.key === state.color);
      if (col && col.url) {
        const img = document.createElementNS(ns, 'image');
        img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', col.url);
        img.setAttribute('x', bbox.x); img.setAttribute('y', bbox.y); img.setAttribute('width', bbox.width); img.setAttribute('height', bbox.height);
        img.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        img.setAttribute('clip-path', 'url(#rcgClip)');
        if (maskId) img.setAttribute('mask', `url(#${maskId})`);
        imageG.appendChild(img);
      }
    }

    const outline = pathEl.cloneNode(true);
    outline.setAttribute('fill', showTexture ? 'none' : '#fff');
    outline.setAttribute('stroke', '#111');
    outline.setAttribute('stroke-width', '2');
    shapeG.appendChild(outline);

    if (state.shape === 'rectangle') {
      const inset = isMobile() ? 26 : 18;
      label(`${fmt2(state.dims.L || 0)}\" (L)`, bbox.x + bbox.width / 2, bbox.y + inset);
      label(`${fmt2(state.dims.W || 0)}\" (W)`, bbox.x + inset, bbox.y + bbox.height / 2);
    } else if (state.shape === 'circle') {
      label(`${fmt2(state.dims.D || 0)}\" dia`, bbox.x + bbox.width / 2, Math.max(28, bbox.y - 20));
    } else {
      label(`${state.dims.n || 6} sides, ${fmt2(state.dims.A || 0)}\" side`, bbox.x + bbox.width / 2, Math.max(28, bbox.y - 20));
    }

    if (state.shape === 'rectangle') {
      const ex = bbox.x;
      const ey = bbox.y;
      const ew = bbox.width;
      const eh = bbox.height;
      const band = isMobile() ? Math.max(64, Math.min(110, Math.min(ew, eh) * 0.30)) : Math.max(32, Math.min(72, Math.min(ew, eh) * 0.22));

      function drawEdge(x1, y1, x2, y2, key) {
        const active = state.edges.includes(key);
        const seg = document.createElementNS(ns, 'line');
        seg.setAttribute('x1', x1); seg.setAttribute('y1', y1); seg.setAttribute('x2', x2); seg.setAttribute('y2', y2);
        seg.setAttribute('stroke', active ? 'var(--rcg-yellow)' : '#111');
        seg.setAttribute('stroke-width', active ? (isMobile() ? '8' : '6') : '2');
        edgesG.appendChild(seg);
      }

      drawEdge(ex, ey, ex + ew, ey, 'top');
      drawEdge(ex + ew, ey, ex + ew, ey + eh, 'right');
      drawEdge(ex, ey + eh, ex + ew, ey + eh, 'bottom');
      drawEdge(ex, ey, ex, ey + eh, 'left');

      if (state.stepId === 2) {
        [
          { key: 'top', x: ex, y: ey, w: ew, h: band },
          { key: 'bottom', x: ex, y: ey + eh - band, w: ew, h: band },
          { key: 'left', x: ex, y: ey, w: band, h: eh },
          { key: 'right', x: ex + ew - band, y: ey, w: band, h: eh }
        ].forEach((z) => {
          const r = document.createElementNS(ns, 'rect');
          r.setAttribute('x', z.x); r.setAttribute('y', z.y); r.setAttribute('width', z.w); r.setAttribute('height', z.h);
          r.setAttribute('fill', '#fff');
          r.setAttribute('fill-opacity', '0.001');
          r.setAttribute('pointer-events', 'all');
          r.style.touchAction = 'none';
          r.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            if (r.setPointerCapture) r.setPointerCapture(e.pointerId);
            const i = state.edges.indexOf(z.key);
            if (i > -1) state.edges.splice(i, 1);
            else state.edges.push(z.key);
            updateEdgeStatusUI();
            updateBacksplashAvailability();
            drawShape();
            updateNav();
          });
          hotG.appendChild(r);
        });
      }
    }

    if (state.shape === 'rectangle' && state.sinks.length) {
      const toPx = (v) => v * s;
      const rectX = bbox.x;
      const rectY = bbox.y;

      state.sinks.forEach((snk, idx) => {
        const tpl = SINK_TEMPLATES[snk.key];
        if (!tpl) return;
        const halfW = tpl.w / 2;
        const halfH = tpl.h / 2;
        snk.x = clamp(snk.x, halfW + MIN_SINK_EDGE, (state.dims.L - halfW) - MIN_SINK_EDGE);
        snk.y = clamp(snk.y, halfH + MIN_SINK_EDGE, (state.dims.W - halfH) - MIN_SINK_EDGE);
        const sinkLeft = rectX + toPx(snk.x - halfW);
        const sinkTop = rectY + toPx(snk.y - halfH);
        const sinkWpx = toPx(tpl.w);
        const sinkHpx = toPx(tpl.h);
        const sinkRight = sinkLeft + sinkWpx;
        const sinkBottom = sinkTop + sinkHpx;

        let node;
        if (tpl.shape === 'oval') {
          node = document.createElementNS(ns, 'ellipse');
          node.setAttribute('cx', sinkLeft + sinkWpx / 2);
          node.setAttribute('cy', sinkTop + sinkHpx / 2);
          node.setAttribute('rx', sinkWpx / 2);
          node.setAttribute('ry', sinkHpx / 2);
        } else {
          node = document.createElementNS(ns, 'rect');
          node.setAttribute('x', sinkLeft);
          node.setAttribute('y', sinkTop);
          node.setAttribute('width', sinkWpx);
          node.setAttribute('height', sinkHpx);
          node.setAttribute('rx', '4');
        }

        const onStep3 = state.stepId === 3;
        if (onStep3) {
          node.setAttribute('fill', '#fff');
          node.setAttribute('fill-opacity', '0.10');
          node.setAttribute('stroke', 'var(--rcg-yellow)');
          node.setAttribute('stroke-width', isMobile() ? '6' : '5');
        } else {
          node.setAttribute('fill', 'none');
          node.setAttribute('stroke', '#111');
          node.setAttribute('stroke-width', isMobile() ? '3' : '2');
        }
        node.setAttribute('pointer-events', 'all');
        node.style.cursor = onStep3 ? 'grab' : 'default';
        node.style.touchAction = 'none';
        sinksG.appendChild(node);

        const holeR = toPx(1.25 / 2);
        const centerX = sinkLeft + sinkWpx / 2;
        const holeY = sinkTop - toPx(2);
        const holes = [];
        if (snk.faucet === '3' && (snk.spread === 4 || snk.spread === 8)) {
          const off = toPx(snk.spread / 2);
          holes.push([centerX - off, holeY], [centerX, holeY], [centerX + off, holeY]);
        } else {
          holes.push([centerX, holeY]);
        }
        holes.forEach(([hx, hy]) => {
          const c = document.createElementNS(ns, 'circle');
          c.setAttribute('cx', hx); c.setAttribute('cy', hy); c.setAttribute('r', holeR); c.setAttribute('fill', '#fff'); c.setAttribute('stroke', '#111'); c.setAttribute('stroke-width', isMobile() ? '3' : '2');
          sinksG.appendChild(c);
        });

        if (state.stepId === 3) {
          const L = state.dims.L;
          const W = state.dims.W;
          const leftClrIn = snk.x - halfW;
          const rightClrIn = L - (snk.x + halfW);
          const bottomClrIn = W - (snk.y + halfH);
          const pieceLeft = rectX;
          const pieceRight = rectX + bbox.width;
          const pieceBottom = rectY + bbox.height;
          const off = isMobile() ? 18 : 12;
          const y = sinkBottom + off;
          dimLine(pieceLeft, y, sinkLeft, y);
          tick(pieceLeft, y - 6, pieceLeft, y + 6);
          tick(sinkLeft, y - 6, sinkLeft, y + 6);
          dimText(`${fmt2(leftClrIn)}\"`, (pieceLeft + sinkLeft) / 2, y - (isMobile() ? 18 : 12));
          dimLine(sinkRight, y, pieceRight, y);
          tick(sinkRight, y - 6, sinkRight, y + 6);
          tick(pieceRight, y - 6, pieceRight, y + 6);
          dimText(`${fmt2(rightClrIn)}\"`, (sinkRight + pieceRight) / 2, y - (isMobile() ? 18 : 12));
          const x = sinkRight + (isMobile() ? 22 : 14);
          dimLine(x, sinkBottom, x, pieceBottom);
          tick(x - 6, sinkBottom, x + 6, sinkBottom);
          tick(x - 6, pieceBottom, x + 6, pieceBottom);
          dimText(`${fmt2(bottomClrIn)}\"`, x + (isMobile() ? 34 : 22), (sinkBottom + pieceBottom) / 2, 'start');
        }

        node.addEventListener('pointerdown', (e) => {
          if (state.stepId !== 3) return;
          e.preventDefault();
          if (node.setPointerCapture) node.setPointerCapture(e.pointerId);
          const pt = svgPoint(e);
          const currentCx = rectX + toPx(snk.x);
          const currentCy = rectY + toPx(snk.y);
          activeSinkDrag = { idx, tpl, bbox, s, ox: pt.x - currentCx, oy: pt.y - currentCy };
          window.addEventListener('pointermove', onSinkPointerMove, { passive: false });
          window.addEventListener('pointerup', onSinkPointerUp, { passive: false });
          window.addEventListener('pointercancel', onSinkPointerUp, { passive: false });
        });
      });
    }
  }

  function onSinkPointerMove(e) {
    if (!activeSinkDrag || state.stepId !== 3) return;
    e.preventDefault();
    const { idx, tpl, bbox, s, ox, oy } = activeSinkDrag;
    const rectX = bbox.x;
    const rectY = bbox.y;
    const gw = tpl.w * s;
    const gh = tpl.h * s;
    const pt = svgPoint(e);
    let nx = pt.x - ox;
    let ny = pt.y - oy;
    nx = clamp(nx, rectX + gw / 2 + MIN_SINK_EDGE * s, rectX + bbox.width - gw / 2 - MIN_SINK_EDGE * s);
    ny = clamp(ny, rectY + gh / 2 + MIN_SINK_EDGE * s, rectY + bbox.height - gh / 2 - MIN_SINK_EDGE * s);
    const xin = (nx - rectX) / s;
    const yin = (ny - rectY) / s;
    let collide = false;
    state.sinks.forEach((o, j) => {
      if (j === idx) return;
      const tt = SINK_TEMPLATES[o.key];
      const dx = Math.abs(xin - o.x);
      const dy = Math.abs(yin - o.y);
      const minDx = tpl.w / 2 + tt.w / 2 + MIN_SINK_GAP;
      const minDy = tpl.h / 2 + tt.h / 2 + MIN_SINK_GAP;
      if (dx < minDx && dy < minDy) collide = true;
    });
    if (collide) return;
    state.sinks[idx].x = xin;
    state.sinks[idx].y = yin;
    if (!drawShape.__raf) {
      drawShape.__raf = requestAnimationFrame(() => {
        drawShape.__raf = null;
        drawShape();
      });
    }
  }

  function onSinkPointerUp() {
    activeSinkDrag = null;
    window.removeEventListener('pointermove', onSinkPointerMove);
    window.removeEventListener('pointerup', onSinkPointerUp);
    window.removeEventListener('pointercancel', onSinkPointerUp);
  }

  const addBtn = el('#rcg-add-sink', appRoot);
  const selSink = el('#rcg-sink-select', appRoot);
  const sinkPills = el('#rcg-sink-pills', appRoot);

  function sinkFits(template) {
    if (state.shape !== 'rectangle') return false;
    const L = state.dims.L || 0;
    const W = state.dims.W || 0;
    return template.w + 2 * MIN_SINK_EDGE <= L && template.h + 2 * MIN_SINK_EDGE <= W;
  }

  function canPlaceSecond(template) {
    if (!sinkFits(template)) return false;
    const L = state.dims.L;
    const W = state.dims.W;
    const halfW = template.w / 2;
    const halfH = template.h / 2;
    const xmin = MIN_SINK_EDGE + halfW;
    const xmax = L - MIN_SINK_EDGE - halfW;
    const ymin = MIN_SINK_EDGE + halfH;
    const ymax = W - MIN_SINK_EDGE - halfH;
    if (xmin > xmax || ymin > ymax) return false;
    const first = state.sinks[0];
    if (!first) return true;
    const t1 = SINK_TEMPLATES[first.key];
    const minDx = halfW + t1.w / 2 + MIN_SINK_GAP;
    const minDy = halfH + t1.h / 2 + MIN_SINK_GAP;
    function ok(x, y) {
      const dx = Math.abs(x - first.x);
      const dy = Math.abs(y - first.y);
      return x >= xmin && x <= xmax && y >= ymin && y <= ymax && (dx >= minDx || dy >= minDy);
    }
    const cx = (xmin + xmax) / 2;
    const cy = (ymin + ymax) / 2;
    return [
      { x: xmin, y: cy }, { x: xmax, y: cy }, { x: cx, y: ymin }, { x: cx, y: ymax },
      { x: xmin, y: ymin }, { x: xmin, y: ymax }, { x: xmax, y: ymin }, { x: xmax, y: ymax }
    ].some((p) => ok(p.x, p.y));
  }

  function suggestSecondPosition(template) {
    const L = state.dims.L;
    const W = state.dims.W;
    const halfW = template.w / 2;
    const halfH = template.h / 2;
    const xmin = MIN_SINK_EDGE + halfW;
    const xmax = L - MIN_SINK_EDGE - halfW;
    const ymin = MIN_SINK_EDGE + halfH;
    const ymax = W - MIN_SINK_EDGE - halfH;
    const s1 = state.sinks[0];
    if (!s1) return { x: (xmin + xmax) / 2, y: (ymin + ymax) / 2 };
    const t1 = SINK_TEMPLATES[s1.key];
    const minDx = halfW + t1.w / 2 + MIN_SINK_GAP;
    const minDy = halfH + t1.h / 2 + MIN_SINK_GAP;
    function ok(x, y) {
      const dx = Math.abs(x - s1.x);
      const dy = Math.abs(y - s1.y);
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
    const opts = ['1', '3'].map((v) => `<option value="${v}" ${s.faucet === v ? 'selected' : ''}>${v}-hole</option>`).join('');
    const spreadOpts = s.faucet === '3'
      ? `<option value="4" ${s.spread == 4 ? 'selected' : ''}>4\"</option><option value="8" ${s.spread == 8 ? 'selected' : ''}>8\"</option>`
      : '<option value="" selected>-</option>';
    return `
      <div class="sink-chip" data-id="${s.id}">
        <strong>${SINK_TEMPLATES[s.key].label}</strong>
        <span style="flex:1"></span>
        <label>Faucet</label>
        <select class="rcg-input" data-faucet="${s.id}">${opts}</select>
        <select class="rcg-input" data-spread="${s.id}" ${s.faucet === '3' ? '' : 'disabled'}>${spreadOpts}</select>
        <button title="Remove sink">x</button>
      </div>
    `;
  }

  function refreshSinkPills() {
    if (!sinkPills) return;
    sinkPills.innerHTML = state.sinks.map((s) => sinkPillHTML(s)).join('');
    els('.sink-chip button', sinkPills).forEach((btn) => {
      btn.onclick = () => {
        const id = btn.parentElement.getAttribute('data-id');
        state.sinks = state.sinks.filter((x) => x.id !== id);
        drawShape();
        refreshSinkPills();
      };
    });
    els('[data-faucet]', sinkPills).forEach((sel) => {
      sel.onchange = () => {
        const id = sel.getAttribute('data-faucet');
        const s = state.sinks.find((x) => x.id === id);
        if (!s) return;
        s.faucet = sel.value;
        if (s.faucet === '1') s.spread = null;
        if (s.faucet === '3') s.spread = 4;
        refreshSinkPills();
        drawShape();
      };
    });
    els('[data-spread]', sinkPills).forEach((sel) => {
      sel.onchange = () => {
        const id = sel.getAttribute('data-spread');
        const s = state.sinks.find((x) => x.id === id);
        if (!s) return;
        s.spread = parseInt(sel.value || '0', 10) || null;
        drawShape();
      };
    });
  }

  if (addBtn) {
    addBtn.onclick = () => {
      if (state.shape !== 'rectangle') return;
      const key = selSink.value;
      const tpl = SINK_TEMPLATES[key];
      if (!sinkFits(tpl)) return alert('That sink will not fit this piece with 4 inch edge clearance.');
      if (state.sinks.length === 1 && !canPlaceSecond(tpl)) return alert('There is not enough room to add a second sink with required clearances.');
      if (state.sinks.length >= 2) return alert('You can add up to 2 sinks.');
      const L = state.dims.L || 48;
      const W = state.dims.W || 24;
      let pos;
      if (state.sinks.length === 0) {
        const xMin = MIN_SINK_EDGE + tpl.w / 2;
        const xMax = L - MIN_SINK_EDGE - tpl.w / 2;
        const yMin = MIN_SINK_EDGE + tpl.h / 2;
        const yMax = W - MIN_SINK_EDGE - tpl.h / 2;
        pos = { x: clamp(L / 2, xMin, xMax), y: clamp(yMax, yMin, yMax) };
      } else {
        const suggested = suggestSecondPosition(tpl);
        if (!suggested) return alert('There is not enough room to add a second sink with required clearances.');
        pos = suggested;
      }
      state.sinks.push({ id: uid(), key, ...pos, faucet: '1', spread: null });
      drawShape();
      refreshSinkPills();
    };
  }

  function taxRateByZip(zip) {
    if (!/^\d{5}$/.test(zip)) return 0;
    if (/^63/.test(zip)) return 0.0825;
    if (/^62/.test(zip)) return 0.0875;
    return 0.0700;
  }

  function backsplashSqft() {
    if (state.shape !== 'rectangle' || !state.backsplash) return 0;
    const L = state.dims.L || 0;
    const W = state.dims.W || 0;
    const unpol = ['top', 'right', 'bottom', 'left'].filter((k) => !state.edges.includes(k));
    const lenMap = { top: L, bottom: L, left: W, right: W };
    return unpol.reduce((sum, k) => sum + (lenMap[k] || 0) * 4, 0) / 144;
  }

  function computePricing(zip) {
    const area = state.area;
    const material = area * DOLLARS_PER_SQFT;
    const sinks = state.shape === 'rectangle' ? state.sinks.reduce((acc, s) => acc + (SINK_PRICES[s.key] || 0), 0) : 0;
    const bpsf = backsplashSqft() * DOLLARS_PER_SQFT;
    const ship = shippingEstimate(area + backsplashSqft(), zip, ORIGIN_ZIP_DEFAULT);
    const taxRate = taxRateByZip(zip);
    const services = material + sinks + bpsf + ship.ltl;
    const tax = services * taxRate;
    const total = services + tax;
    return { material, sinks, backsplash: bpsf, ship, taxRate, tax, total, services };
  }

  function encodeCfg(obj) {
    try {
      return encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(obj)))));
    } catch (err) {
      return '';
    }
  }

  function currentConfig() {
    const zip = (el('#rcg-zip', appRoot)?.value || '').trim();
    const p = computePricing(zip || ORIGIN_ZIP_DEFAULT);
    return {
      shape: state.shape,
      dims: state.dims,
      sinks: state.shape === 'rectangle' ? state.sinks : [],
      color: state.color,
      edges: state.shape === 'rectangle' ? state.edges : [],
      backsplash: state.shape === 'rectangle' ? !!state.backsplash : false,
      zip,
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

  async function emailDXFToOrders() {
    try {
      const cfg = currentConfig();
      const dxfText = buildDXF(cfg);
      const dxfBase64 = btoa(unescape(encodeURIComponent(dxfText)));
      const res = await fetch('/api/email-dxf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: BUSINESS_EMAIL,
          subject: 'Rock Creek Granite - New Config DXF',
          config: cfg,
          dxfBase64
        })
      });
      if (!res.ok) throw new Error(await res.text());
    } catch (err) {
      console.error('[RCG] DXF email failed', err);
    }
  }

  function buildDXF(cfg) {
    const out = [];
    const push = (...a) => out.push(...a.map(String));
    const sec = (name) => push('0', 'SECTION', '2', name);
    const endsec = () => push('0', 'ENDSEC');
    const header = () => { sec('HEADER'); push('9', '$INSUNITS', '70', '1'); endsec(); };
    const start = () => { header(); sec('TABLES'); endsec(); sec('ENTITIES'); };
    const finish = () => { endsec(); push('0', 'EOF'); return out.join('\n'); };
    const lwpoly = (pts, closed, layer) => {
      push('0', 'LWPOLYLINE', '8', layer || 'CUT', '90', pts.length, '70', closed ? '1' : '0');
      pts.forEach(([x, y]) => push('10', (+x).toFixed(4), '20', (+y).toFixed(4)));
    };
    const circle = (x, y, r, layer) => {
      push('0', 'CIRCLE', '8', layer || 'HOLES', '10', (+x).toFixed(4), '20', (+y).toFixed(4), '40', (+r).toFixed(4));
    };
    const text = (x, y, h, msg, layer) => {
      push('0', 'TEXT', '8', layer || 'TEXT', '10', (+x).toFixed(4), '20', (+y).toFixed(4), '40', (+h).toFixed(3), '1', String(msg));
    };
    const rect = (x, y, w, h, layer) => lwpoly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true, layer || 'CUT');
    const ellipsePoly = (cx, cy, rx, ry, seg) => {
      const pts = [];
      const count = seg || 96;
      for (let i = 0; i < count; i += 1) {
        const t = (i / count) * 2 * Math.PI;
        pts.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)]);
      }
      return pts;
    };

    start();
    const shape = cfg.shape;
    const d = cfg.dims;
    let bbox = [0, 0, 0, 0];
    if (shape === 'rectangle') {
      rect(0, 0, d.L, d.W, 'CUT');
      bbox = [0, 0, d.L, d.W];
      text(d.L / 2, d.W + 2.0, 0.35, `Rectangle ${d.L}\" x ${d.W}\"`, 'TEXT');
    } else if (shape === 'circle') {
      circle(d.D / 2, d.D / 2, d.D / 2, 'CUT');
      bbox = [0, 0, d.D, d.D];
      text(d.D / 2, d.D + 2.0, 0.35, `Circle dia ${d.D}\"`, 'TEXT');
    } else if (shape === 'polygon') {
      const n = d.n || 6;
      const s = d.A;
      const R = s / (2 * Math.sin(Math.PI / n));
      const cx = R;
      const cy = R;
      const pts = [];
      for (let i = 0; i < n; i += 1) {
        const ang = i * (2 * Math.PI / n);
        pts.push([cx + R * Math.cos(ang), cy + R * Math.sin(ang)]);
      }
      lwpoly(pts, true, 'CUT');
      bbox = [0, 0, 2 * R, 2 * R];
      text(R, 2 * R + 2.0, 0.35, `${n}-gon, side ${s}\"`, 'TEXT');
    }

    if (shape === 'rectangle' && cfg.backsplash) {
      const polished = cfg.edges || [];
      const sides = ['top', 'right', 'bottom', 'left'];
      const unpol = sides.filter((k) => !polished.includes(k));
      const gap = 1;
      const L = d.L;
      const W = d.W;
      unpol.forEach((side) => {
        if (side === 'top') rect(0, W + gap, L, 4, 'BACKSPLASH');
        if (side === 'bottom') rect(0, -gap - 4, L, 4, 'BACKSPLASH');
        if (side === 'left') rect(-gap - 4, 0, 4, W, 'BACKSPLASH');
        if (side === 'right') rect(L + gap, 0, 4, W, 'BACKSPLASH');
      });
    }

    if (shape === 'rectangle' && Array.isArray(cfg.sinks)) {
      cfg.sinks.forEach((s) => {
        const tpl = SINK_TEMPLATES[s.key];
        if (!tpl) return;
        const x0 = s.x - tpl.w / 2;
        const y0 = s.y - tpl.h / 2;
        if (tpl.shape === 'oval') lwpoly(ellipsePoly(s.x, s.y, tpl.w / 2, tpl.h / 2, 120), true, 'CUT');
        else rect(x0, y0, tpl.w, tpl.h, 'CUT');
        const r = 1.25 / 2;
        const holeY = y0 - 2;
        const cx = s.x;
        if (s.faucet === '3' && (s.spread === 4 || s.spread === 8)) {
          const off = s.spread / 2;
          circle(cx - off, holeY, r, 'HOLES');
          circle(cx, holeY, r, 'HOLES');
          circle(cx + off, holeY, r, 'HOLES');
        } else {
          circle(cx, holeY, r, 'HOLES');
        }
      });
    }

    if (shape === 'rectangle') {
      const edges = (cfg.edges || []).map((e) => e[0].toUpperCase() + e.slice(1)).join(', ') || 'None';
      text(0, (bbox[3] || 0) + 6, 0.35, `Polished edges: ${edges}`, 'TEXT');
    }
    return finish();
  }

  const panel = el('#rcg-panel', appRoot);
  const handle = el('#rcg-panel-handle', appRoot);
  function setHandleMode() {
    if (!handle) return;
    handle.classList.toggle('desktop-draggable', isDesktop());
  }

  (function enablePanelDrag() {
    if (!panel || !handle) return;
    let dragging = false;
    let grabOffsetX = 0;
    let grabOffsetY = 0;
    function getBoundsRect() {
      const body = el('.rcg-body', appRoot);
      return body ? body.getBoundingClientRect() : document.documentElement.getBoundingClientRect();
    }
    function onDown(e) {
      if (!isDesktop()) return;
      if (e.target && e.target.closest && e.target.closest('button, input, select, textarea, a')) return;
      dragging = true;
      const pr = panel.getBoundingClientRect();
      grabOffsetX = e.clientX - pr.left;
      grabOffsetY = e.clientY - pr.top;
      handle.style.cursor = 'grabbing';
      document.body.style.userSelect = 'none';
      panel.style.right = 'auto';
      e.preventDefault();
    }
    function onMove(e) {
      if (!dragging) return;
      const bounds = getBoundsRect();
      const pw = panel.offsetWidth;
      const ph = panel.offsetHeight;
      let left = e.clientX - grabOffsetX;
      let top = e.clientY - grabOffsetY;
      const minL = bounds.left + 8;
      const minT = bounds.top + 8;
      const maxL = bounds.right - pw - 8;
      const maxT = bounds.bottom - ph - 8;
      left = clamp(left, minL, maxL);
      top = clamp(top, minT, maxT);
      const parent = panel.offsetParent || panel.parentElement;
      const parentRect = parent.getBoundingClientRect();
      panel.style.left = `${Math.round(left - parentRect.left)}px`;
      panel.style.top = `${Math.round(top - parentRect.top)}px`;
    }
    function onUp() {
      dragging = false;
      handle.style.cursor = isDesktop() ? 'grab' : '';
      document.body.style.userSelect = '';
    }
    handle.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  })();

  let ro = null;
  let insetFallbackTimer = null;
  function syncMobilePreviewInset() {
    const preview = el('.rcg-preview', appRoot);
    const panelEl = el('#rcg-panel', appRoot);
    if (!preview || !panelEl) return;

    const apply = () => {
      if (!isMobile()) {
        preview.style.removeProperty('--rcg-sheet-h');
        return;
      }
      const h = panelEl.getBoundingClientRect().height || 0;
      preview.style.setProperty('--rcg-sheet-h', `${Math.ceil(h)}px`);
    };

    apply();

    if (ro && typeof ro.disconnect === 'function') {
      try { ro.disconnect(); } catch (err) {}
    }
    ro = null;

    if (insetFallbackTimer) {
      clearTimeout(insetFallbackTimer);
      insetFallbackTimer = null;
    }

    if (typeof window.ResizeObserver === 'function') {
      try {
        ro = new window.ResizeObserver(apply);
        ro.observe(panelEl);
        return;
      } catch (err) {
        // fall through to timer-based fallback on iOS engines that expose ResizeObserver but fail at runtime
      }
    }

    insetFallbackTimer = setTimeout(apply, 80);
  }

  const nextBtn = el('#rcg-next', appRoot);
  const backBtn = el('#rcg-back', appRoot);
  if (backBtn) backBtn.addEventListener('click', () => gotoPrev());
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (nextBtn.disabled) return;
      if (state.stepId === 4) {
        const zip = (el('#rcg-zip', appRoot)?.value || '').trim();
        if (!/^\d{5}$/.test(zip)) return;
        const payload = currentConfig();
        void emailDXFToOrders();
        window.location.assign('/config-checkout?cfg=' + encodeCfg(payload));
        return;
      }
      gotoNext();
    });
  }

  const backsplashToggle = el('#rcg-backsplash', appRoot);
  if (backsplashToggle) {
    backsplashToggle.addEventListener('change', () => {
      state.backsplash = backsplashToggle.checked;
    });
  }

  const colorSel = el('#rcg-color', appRoot);
  if (colorSel) {
    colorSel.value = DEFAULT_COLOR;
    state.color = DEFAULT_COLOR;
    updateColorLink();
    colorSel.addEventListener('change', () => {
      state.color = colorSel.value;
      updateColorLink();
      drawShape();
    });
  }

  appRoot.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'rcg-zip') updateNav();
  });

  let resizeRaf = null;
  function onResize() {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = null;
      setHandleMode();
      syncMobilePreviewInset();
      syncMode();
      drawShape();
    });
  }
  window.addEventListener('resize', onResize);

  function markReady() {
    mount.dataset.rcgStatus = 'ready';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        hidePreload();
        emit('rcg:ready', { mountId: mount.id || 'rcg-configurator-launch' });
      });
    });
  }

  function bootstrap() {
    renderShapeIcons(el('#shape-icons', appRoot));
    setHandleMode();
    setShapeFromIcon('square');
    refreshSinkPills();
    syncMobilePreviewInset();
    syncMode();
    markReady();
  }

  setTimeout(() => {
    if (mount.dataset.rcgStatus !== 'ready') {
      setPreloadMessage('Still loading. The configurator is almost ready.');
    }
  }, 3500);

  setTimeout(() => {
    if (mount.dataset.rcgStatus !== 'ready') {
      setPreloadMessage('This is taking longer than expected. You can open the configurator in a new tab.');
      setPreloadCta('<a href="https://www.rockcreekgranite.com/configurator" target="_blank" rel="noopener">Open in new tab</a>');
    }
  }, 12000);

  try {
    bootstrap();
  } catch (err) {
    console.error('[RCG] bootstrap failed', err);
    const errName = err && err.name ? `${err.name}: ` : '';
    const errMsg = err && err.message ? err.message : 'Unknown error';
    failBoot(`The configurator could not be initialized right now. ${errName}${errMsg}`);
  }
})();
