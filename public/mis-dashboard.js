/* ============================================================================
 * MIS Dashboard — Motor business analytics (OneInsure).
 * Self-contained module. Global entry: misInit() (called from the tab switcher).
 * Reuses GET /api/employee/dashboard (auth via the page's wrapped fetch).
 *
 * Built one component at a time. Implemented so far:
 *   #1  Business FTD / MTD / YTD  ×  status (Ok to Log / Pending / Sent to Bops)
 * ==========================================================================*/
(function () {
  'use strict';

  const MIS = {
    inited: false,
    data: null,          // last /employee/dashboard payload
    metric: 'premium',   // 'premium' | 'nop'  (chart toggle for #1)
    charts: {},          // Chart.js instances by key (destroy before re-render)
    tab: 'overview',
    filters: { scope: 'motor', branch: '', sub_branch: '', employee: '', vehicle_type: '', product: '', insurer: '', channel: '', ncb: '', addon: '', from: '', to: '' },
    margin: null,          // last /employee/margin-by-level payload
    marginCycleId: '',     // selected cycle for the Margins tab ('' = default/latest)
    marginLoading: false,
    marginMetric: 'margin',// 'margin' | 'income' | 'payout'
    posp: null,            // last /employee/posp-creation payload
    pospLoading: false,
  };
  const FILT_DIMS = ['branch', 'sub_branch', 'employee', 'vehicle_type', 'product', 'insurer']; // cascading dims (channel/dates are independent)

  // ---- helpers -------------------------------------------------------------
  const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
  const fmtNum = (n) => (Number(n) || 0).toLocaleString('en-IN');
  const fmtL = (rupees) => {                       // ₹ → compact Lakh/Crore
    const v = Number(rupees) || 0;
    if (Math.abs(v) >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr';
    return '₹' + (v / 1e5).toFixed(2) + ' L';
  };
  const pct = (a, b) => (!b ? 0 : (a / b) * 100);

  const COLORS = {
    okLog:  '#1E9E5A',   // Ok to Log  — green
    pend:   '#F5A011',   // Pending    — orange
    bops:   '#E15554',   // Sent to Bops — red
    online: '#00B0FF',   // Online     — blue
    navy:   '#00243E',
    blueDk: '#0082C8',
    grid:   'rgba(0,36,62,0.06)',
    axis:   '#6B7585',
  };

  // ---- one-time CSS --------------------------------------------------------
  function injectStyles() {
    if (document.getElementById('mis-styles')) return;
    const css = `
    .mis-root{font-family:var(--oi-sans,'Montserrat',system-ui,sans-serif);color:#2D3748;}
    .mis-hero{background:linear-gradient(120deg,#00243E 0%,#0060A0 55%,#0082C8 100%);border-radius:16px;padding:22px 26px;color:#fff;box-shadow:0 10px 30px -12px rgba(0,36,62,.55);position:relative;overflow:hidden;}
    .mis-hero::after{content:'';position:absolute;right:-40px;top:-40px;width:220px;height:220px;background:radial-gradient(circle,rgba(245,160,17,.25),transparent 70%);}
    .mis-hero h1{font-family:var(--oi-display,'Plus Jakarta Sans',sans-serif);font-size:23px;font-weight:800;letter-spacing:-.3px;margin:0;display:flex;align-items:center;gap:10px;}
    .mis-hero .sub{font-size:12.5px;opacity:.85;margin-top:5px;letter-spacing:.2px;}
    .mis-hero .oi-tag{font-family:var(--oi-display);letter-spacing:3px;font-weight:700;font-size:10px;text-transform:uppercase;color:#FFD277;}
    .mis-tabbar{position:relative;margin:6px 0 4px;padding-right:104px;border-bottom:1px solid #E3E6EA;}
    .mis-subtabs{display:flex;gap:4px;flex-wrap:wrap;}
    .mis-subtab{flex:0 0 auto;padding:9px 16px;font-size:13px;font-weight:600;color:#6B7585;cursor:pointer;border-radius:8px 8px 0 0;border:1px solid transparent;border-bottom:none;position:relative;top:1px;transition:.15s;white-space:nowrap;}
    .mis-subtab:hover{color:#0082C8;background:#F4FAFF;}
    .mis-subtab.active{color:#00243E;background:#fff;border-color:#E3E6EA;box-shadow:0 -2px 6px -4px rgba(0,0,0,.1);}
    .mis-subtab.active::after{content:'';position:absolute;left:0;right:0;bottom:-1px;height:2.5px;background:linear-gradient(90deg,#F5A011,#0082C8);border-radius:2px;}
    .mis-filters{margin-top:12px;}
    .fbar{background:#fff;border:1px solid #E9ECF1;border-radius:12px;padding:13px 16px;box-shadow:0 3px 12px -9px rgba(0,36,62,.4);}
    .frow{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px 14px;align-items:end;}
    .fttl{grid-column:1/-1;font-size:11px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#0082C8;display:flex;align-items:center;gap:7px;}
    .fttl::before{content:'⛃';font-size:13px;}
    .fgrp{display:flex;flex-direction:column;gap:4px;min-width:0;}
    .fgrp label{font-size:9.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#9AA3AF;}
    .fgrp select,.fgrp input{font:inherit;font-size:12.5px;color:#2D3748;border:1px solid #D8DEE6;border-radius:8px;padding:7px 10px;background:#fff;width:100%;cursor:pointer;height:34px;}
    .fgrp select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%236B7585' d='M0 0l5 6 5-6z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;-webkit-appearance:none;appearance:none;padding-right:26px;}
    .fgrp select:focus,.fgrp input:focus{outline:none;border-color:#0082C8;box-shadow:0 0 0 3px rgba(0,130,200,.12);}
    .fbtn{align-self:end;height:34px;border:1px solid #D8DEE6;background:#F7FAFD;color:#0082C8;font:inherit;font-size:12px;font-weight:700;padding:0 16px;border-radius:8px;cursor:pointer;}
    .fbtn:hover{background:#EAF5FD;border-color:#0082C8;}
    .mis-body{padding:20px 2px 40px;}
    .mis-grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;}
    @media(max-width:1050px){.mis-grid3{grid-template-columns:1fr;}}
    .mis-marginkpi{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:4px;}
    @media(max-width:1050px){.mis-marginkpi{grid-template-columns:repeat(2,1fr);}}
    @media(max-width:560px){.mis-marginkpi{grid-template-columns:1fr;}}
    .mis-grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
    @media(max-width:900px){.mis-grid2{grid-template-columns:1fr;}}
    .mis-gcard{padding:18px 20px 16px;}
    .ghead{display:flex;justify-content:space-between;align-items:flex-start;}
    .gsplash{text-align:right;}
    .gsplash-lbl{font-size:10px;color:#9AA3AF;text-transform:uppercase;letter-spacing:.6px;font-weight:700;margin-top:3px;}
    .gbig{font-family:var(--oi-display);font-size:32px;font-weight:800;color:#00243E;letter-spacing:-.5px;margin-top:10px;}
    .gbig-sub{font-size:12px;color:#6B7585;margin-top:2px;}
    .gbig-sub b{color:#00243E;}
    .gdiv{height:1px;background:#EEF1F4;margin:13px 0 4px;}
    .grow{display:flex;align-items:center;gap:10px;padding:7px 0;font-size:12.5px;}
    .grow .glbl{flex:1;color:#4A5568;font-weight:600;}
    .grow .gcur{color:#00243E;font-weight:700;font-variant-numeric:tabular-nums;}
    .grow .gprev{color:#9AA3AF;font-size:11.5px;font-variant-numeric:tabular-nums;min-width:96px;text-align:right;}
    .gbadge{font-size:11px;font-weight:800;padding:3px 8px;border-radius:7px;min-width:64px;text-align:center;display:inline-block;}
    .gbadge.up{background:#E6F6EC;color:#1E9E5A;}
    .gbadge.down{background:#FDECEC;color:#E15554;}
    .gbadge.flat{background:#F1F3F5;color:#6B7585;}
    .gbadge.up.gbadge-lg,.gsplash.up .gbadge{font-size:15px;padding:6px 12px;}
    .gsplash .gbadge{font-size:16px;padding:6px 13px;}
    .mis-note{font-size:11.5px;color:#9AA3AF;margin-top:12px;padding:0 4px;}
    .mis-periodhd{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:4px;flex-wrap:wrap;}
    .mis-secttl{font-family:var(--oi-display);font-size:18px;font-weight:800;color:#00243E;margin:0;letter-spacing:-.3px;}
    .mis-sectsub{font-size:12px;color:#9AA3AF;margin-top:2px;}
    .mis-pertoggle button{padding:7px 18px;font-size:12.5px;}
    .mis-blgrid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;}
    @media(max-width:900px){.mis-blgrid{grid-template-columns:1fr;}}
    .mis-blcard{padding:15px 18px 16px;}
    .bllist{margin-top:8px;}
    .blrow{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:12.5px;}
    .blk{width:150px;flex:none;color:#2D3748;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .blbar{flex:1;height:9px;background:#EEF1F4;border-radius:5px;overflow:hidden;}
    .blbar i{display:block;height:100%;background:linear-gradient(90deg,#0082C8,#00B0FF);border-radius:5px;}
    .blv{min-width:80px;text-align:right;color:#00243E;font-weight:700;font-variant-numeric:tabular-nums;}
    .blsh{min-width:38px;text-align:right;color:#9AA3AF;font-size:11px;font-variant-numeric:tabular-nums;}
    .rtowrap{max-height:520px;overflow:auto;margin-top:8px;}
    .rtotbl{width:100%;border-collapse:collapse;font-size:12.5px;}
    .rtotbl th{position:sticky;top:0;background:#F7FAFD;color:#6B7585;font-size:10.5px;text-transform:uppercase;letter-spacing:.5px;text-align:left;padding:8px 10px;border-bottom:1px solid #E9ECF1;}
    .rtotbl td{padding:7px 10px;border-bottom:1px solid #F2F4F7;color:#2D3748;}
    .rtotbl tr.mh td{background:#FFFAEE;}
    .rtotbl .rmono{font-family:'Consolas',monospace;font-weight:700;color:#00243E;}
    .mis-gaugecard{padding:16px 18px 14px;}
    .mis-gaugewrap{position:relative;height:150px;margin:6px 0 2px;}
    .gaugectr{position:absolute;left:0;right:0;bottom:6px;text-align:center;pointer-events:none;}
    .gcpct{font-family:var(--oi-display);font-size:30px;font-weight:800;color:#00243E;line-height:1;}
    .gclbl{font-size:10.5px;color:#9AA3AF;text-transform:uppercase;letter-spacing:.8px;font-weight:700;}
    .gaugerows,.prodrows{margin-top:8px;}
    .prow{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px dashed #EEF1F4;font-size:12.5px;color:#4A5568;}
    .prow b{color:#00243E;font-variant-numeric:tabular-nums;}
    .mis-prodcard{padding:18px 20px;display:flex;flex-direction:column;}
    .prodmain{font-family:var(--oi-display);font-size:46px;font-weight:800;color:#00243E;line-height:1;margin-top:8px;}
    .prodmain span{font-size:22px;color:#F5A011;margin-left:2px;}
    .prodsub{font-size:12px;color:#6B7585;margin-bottom:6px;}
    .mis-card{background:#fff;border:1px solid #E9ECF1;border-radius:14px;box-shadow:0 4px 14px -10px rgba(0,36,62,.35);}
    .mis-pcard{padding:18px 18px 14px;position:relative;overflow:hidden;}
    .mis-pcard .plabel{font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:#0082C8;}
    .mis-pcard .prange{font-size:10.5px;color:#9AA3AF;margin-top:2px;}
    .mis-pcard .pbig{font-family:var(--oi-display);font-size:30px;font-weight:800;color:#00243E;margin:8px 0 0;letter-spacing:-.5px;}
    .mis-pcard .pnop{font-size:12.5px;color:#4A5568;margin-top:1px;}
    .mis-pcard .pnop b{color:#00243E;}
    .mis-pcard .accent{position:absolute;left:0;top:0;bottom:0;width:5px;background:linear-gradient(#0082C8,#00B0FF);}
    .mis-stat{display:flex;align-items:center;gap:8px;padding:7px 0;border-top:1px dashed #EEF1F4;font-size:12.5px;}
    .mis-stat .dot{width:9px;height:9px;border-radius:50%;flex:none;}
    .mis-stat .nm{flex:1;color:#4A5568;font-weight:600;}
    .mis-stat .nop{color:#6B7585;font-variant-numeric:tabular-nums;min-width:54px;text-align:right;}
    .mis-stat .pr{color:#00243E;font-weight:700;font-variant-numeric:tabular-nums;min-width:78px;text-align:right;}
    .mis-chartrow{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;}
    @media(max-width:1050px){.mis-chartrow{grid-template-columns:1fr;}}
    .mis-chartcard{padding:16px 18px 18px;}
    .mis-charthd{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;}
    .mis-charthd h3{font-family:var(--oi-display);font-size:15px;font-weight:700;color:#00243E;margin:0;}
    .mis-toggle{display:inline-flex;background:#F1F3F5;border-radius:9px;padding:3px;gap:2px;}
    .mis-toggle button{border:none;background:transparent;font:inherit;font-size:12px;font-weight:700;color:#6B7585;padding:5px 14px;border-radius:7px;cursor:pointer;transition:.15s;}
    .mis-toggle button.on{background:#fff;color:#0082C8;box-shadow:0 1px 4px rgba(0,0,0,.12);}
    .mis-chartwrap{height:300px;position:relative;}
    .mis-refresh{background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.3);color:#fff;font:inherit;font-size:12px;font-weight:700;padding:7px 14px;border-radius:9px;cursor:pointer;backdrop-filter:blur(4px);}
    .mis-refresh:hover{background:rgba(255,255,255,.24);}
    .mis-refresh-float{position:absolute;top:0;right:0;background:#fff;border:1px solid #D7DCE2;color:#0082C8;font:inherit;font-size:12px;font-weight:700;padding:6px 13px;border-radius:8px;cursor:pointer;transition:.15s;box-shadow:0 2px 8px -3px rgba(0,36,62,.25);}
    .mis-refresh-float:hover{background:#F4FAFF;border-color:#00B0FF;}
    .mis-legend{display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:#6B7585;}
    .mis-legend span{display:inline-flex;align-items:center;gap:6px;}
    .mis-legend i{width:11px;height:11px;border-radius:3px;display:inline-block;}
    .mis-empty{padding:50px;text-align:center;color:#9AA3AF;font-size:14px;}
    .mis-treehd{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:16px 18px;border-bottom:1px solid #EEF1F4;flex-wrap:wrap;}
    .mis-treehd h3{font-family:var(--oi-display);font-size:15px;font-weight:700;color:#00243E;margin:0;}
    .mis-treehd .tsub{font-size:11.5px;color:#9AA3AF;margin-top:2px;}
    .mis-treehd .tsub b{color:#00243E;}
    .mis-linkbtn{border:1px solid #D8DEE6;background:#fff;color:#4A5568;font:inherit;font-size:11.5px;font-weight:700;padding:6px 11px;border-radius:8px;cursor:pointer;}
    .mis-linkbtn:hover{border-color:#0082C8;color:#0082C8;}
    .mis-treewrap{padding:6px 8px 12px;max-height:640px;overflow:auto;}
    .trow{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;font-size:13px;}
    .trow[data-toggle]{cursor:pointer;}
    .trow-b{background:#F7FAFD;margin:5px 0 0;font-weight:700;color:#00243E;}
    .trow-b:hover{background:#EEF6FD;}
    .trow-s{margin-left:22px;color:#2D3748;font-weight:600;}
    .trow-s:hover{background:#F4F7FA;}
    .trow-e{margin-left:50px;color:#4A5568;}
    .tcaret{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;border-radius:5px;background:#0082C8;color:#fff;font-weight:800;font-size:13px;line-height:1;}
    .trow-s .tcaret{background:#7FB8DC;}
    .tcaret.tleaf{background:transparent;color:#C8CDD5;font-size:16px;}
    .tname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .tname .tcode{color:#B4BAC4;font-weight:600;font-size:11px;}
    .tbar{width:130px;flex:none;height:8px;background:#EEF1F4;border-radius:5px;overflow:hidden;}
    .tbar i{display:block;height:100%;background:linear-gradient(90deg,#0082C8,#00B0FF);border-radius:5px;}
    .tbar-s i{background:linear-gradient(90deg,#3F9BD0,#6FC5F0);}
    .tbar-e i{background:linear-gradient(90deg,#F5A011,#FFC24D);}
    .tnop{color:#6B7585;font-variant-numeric:tabular-nums;min-width:70px;text-align:right;font-size:12px;}
    .tnop small{color:#B4BAC4;}
    .tpr{color:#00243E;font-weight:700;font-variant-numeric:tabular-nums;min-width:84px;text-align:right;}
    `;
    document.head.appendChild(el('style', null)).id = 'mis-styles';
    document.getElementById('mis-styles').textContent = css;
  }

  // ---- shell ---------------------------------------------------------------
  const SUBTABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'growth', label: 'Growth' },
    { id: 'targets', label: 'Targets' },
    { id: 'breakdowns', label: 'Breakdowns' },
    { id: 'geography', label: 'Geography' },
    { id: 'agents', label: 'Agents & RM' },
    { id: 'evaluation', label: 'Evaluation' },
    { id: 'margins', label: 'Margins' },
    { id: 'posp', label: 'POSP Creation' },
    { id: 'renewals', label: 'Renewals' },
    { id: 'tree', label: 'Business Tree' },
    { id: 'more', label: 'Data Required' },
  ];

  // Placeholder target — ₹1 Cr annual per employee (USER: real per-employee
  // targets to be supplied later). Change TARGET_PER_EMP or wire to a feed.
  const TARGET_PER_EMP = 1e7;

  function buildShell() {
    const root = document.getElementById('misRoot');
    root.innerHTML = '';
    // No hero banner. Tabs wrap naturally (no ugly horizontal scroll); Refresh is
    // a small floating button pinned to the top-right of the tab bar.
    const tabbar = el('div', 'mis-tabbar');
    const nav = el('div', 'mis-subtabs',
      SUBTABS.map(t => `<div class="mis-subtab${t.id === MIS.tab ? ' active' : ''}" data-sub="${t.id}">${t.label}</div>`).join(''));
    const btn = el('button', 'mis-refresh-float');
    btn.id = 'misRefreshBtn'; btn.title = 'Reload data'; btn.innerHTML = '↻ Refresh';
    const sub = el('span'); sub.id = 'misHeroSub'; sub.style.display = 'none';   // status kept (hidden) so setters stay valid
    tabbar.appendChild(nav); tabbar.appendChild(btn); tabbar.appendChild(sub);
    const filt = el('div', 'mis-filters'); filt.id = 'misFilters';   // #6 — vertical is deliberately NOT a filter here
    const body = el('div', 'mis-body'); body.id = 'misBody';
    root.appendChild(tabbar); root.appendChild(filt); root.appendChild(body);

    nav.querySelectorAll('.mis-subtab').forEach(n => n.addEventListener('click', () => {
      MIS.tab = n.dataset.sub;
      nav.querySelectorAll('.mis-subtab').forEach(x => x.classList.toggle('active', x === n));
      renderBody();
    }));
    document.getElementById('misRefreshBtn').addEventListener('click', () => loadData(true));
  }

  // ---- data ----------------------------------------------------------------
  async function loadData(force) {
    if (MIS.data && !force) { renderBody(); return; }
    // Preview harness: render sample data without an API call (inert in production —
    // window.MIS_PREVIEW_DATA is never set there).
    if (window.MIS_PREVIEW_DATA) {
      MIS.data = window.MIS_PREVIEW_DATA;
      if (window.MIS_PREVIEW_COMPARE) MIS.compare = window.MIS_PREVIEW_COMPARE;
      const sub = document.getElementById('misHeroSub');
      if (sub) sub.textContent = `PREVIEW · FY starting ${fmtDate(MIS.data.periods && MIS.data.periods.fy_start)} · sample data`;
      renderFilters(); renderBody(); return;
    }
    const body = document.getElementById('misBody');
    if (body) body.innerHTML = '<div class="mis-empty">Loading business data…</div>';
    try {
      const API = window.location.origin + '/api';
      const qs = new URLSearchParams();
      Object.entries(MIS.filters).forEach(([k, v]) => { if (v) qs.set(k, v); });
      // filters change the current selection → invalidate the compare cache too
      MIS.compare = null;
      const r = await fetch(API + '/employee/dashboard?' + qs.toString()).then(x => x.json());
      if (!r || !r.success) throw new Error((r && r.error) || 'Failed to load');
      MIS.data = r;
      const sub = document.getElementById('misHeroSub');
      if (sub) sub.textContent = `${r.root || ''} · FY starting ${fmtDate(r.periods && r.periods.fy_start)} · as of ${fmtDate(r.periods && r.periods.today)}`;
      renderFilters();
      renderBody();
    } catch (e) {
      if (body) body.innerHTML = `<div class="mis-empty">Could not load MIS data — ${escapeHtml(e.message || e)}</div>`;
    }
  }
  const fmtDate = (d) => { if (!d) return '—'; const x = new Date(d); return isNaN(x) ? String(d).slice(0, 10) : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- #6  cascading filter bar (vertical intentionally omitted) -----------
  const filtRowVal = (r, dim) => dim === 'employee' ? r.emp_code : r[dim];
  // options for `dim` = distinct values present in rows matching ALL OTHER active filters
  function cascadeOptions(dim) {
    const rows = MIS.data.filter_rows || [];
    const seen = new Map();
    rows.forEach(r => {
      for (const d of FILT_DIMS) {
        if (d === dim) continue;
        const fv = MIS.filters[d]; if (!fv) continue;
        if (String(filtRowVal(r, d)) !== String(fv)) return;
      }
      const v = filtRowVal(r, dim); if (v === '' || v == null) return;
      const label = dim === 'employee' ? (r.emp_name || r.emp_code) : v;
      if (!seen.has(v)) seen.set(v, label);
    });
    return [...seen.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  }
  // after a change, drop lower-priority selections that make the combo empty
  function reconcileFilters(changed) {
    const rows = MIS.data.filter_rows || [];
    const consistent = () => rows.some(r => FILT_DIMS.every(d => { const fv = MIS.filters[d]; return !fv || String(filtRowVal(r, d)) === String(fv); }));
    for (const d of ['insurer', 'product', 'vehicle_type', 'employee', 'sub_branch', 'branch']) {
      if (consistent()) break;
      if (d !== changed) MIS.filters[d] = '';
    }
  }
  function renderFilters() {
    const c = document.getElementById('misFilters');
    if (!c || !MIS.data) return;
    const F = MIS.filters;
    const sel = (label, dim, allLabel) => {
      const cur = F[dim];
      const opts = [`<option value="">${allLabel || 'All'}</option>`]
        .concat(cascadeOptions(dim).map(([v, l]) => `<option value="${escapeHtml(v)}"${String(v) === String(cur) ? ' selected' : ''}>${escapeHtml(l)}</option>`)).join('');
      return `<div class="fgrp"><label>${label}</label><select data-f="${dim}">${opts}</select></div>`;
    };
    c.innerHTML =
      `<div class="fbar">
         <div class="frow">
           <span class="fttl">Filters</span>
           <div class="fgrp"><label>Scope</label><select data-f="scope">
             <option value="motor"${F.scope === 'motor' ? ' selected' : ''}>Motor</option>
             <option value="nonmotor"${F.scope === 'nonmotor' ? ' selected' : ''}>Non-Motor</option>
             <option value="all"${F.scope === 'all' ? ' selected' : ''}>Motor + Non-Motor</option>
           </select></div>
           ${sel('Branch', 'branch')}${sel('Sub-branch', 'sub_branch')}${sel('Employee', 'employee', 'All employees')}
           ${sel('Vehicle Type', 'vehicle_type')}${sel('Product', 'product')}${sel('Insurer', 'insurer')}
           <div class="fgrp"><label>Channel</label><select data-f="channel">
             <option value="">All</option>
             <option value="online"${F.channel === 'online' ? ' selected' : ''}>Online</option>
             <option value="offline"${F.channel === 'offline' ? ' selected' : ''}>Offline</option>
           </select></div>
           <div class="fgrp"><label>NCB</label><select data-f="ncb">
             <option value="">All</option>
             <option value="ncb"${F.ncb === 'ncb' ? ' selected' : ''}>With NCB</option>
             <option value="nonncb"${F.ncb === 'nonncb' ? ' selected' : ''}>Without NCB</option>
           </select></div>
           <div class="fgrp"><label>Add-on</label><select data-f="addon">
             <option value="">All</option>
             <option value="addon"${F.addon === 'addon' ? ' selected' : ''}>With Add-on</option>
             <option value="noaddon"${F.addon === 'noaddon' ? ' selected' : ''}>Without Add-on</option>
           </select></div>
           <div class="fgrp"><label>From</label><input type="date" data-f="from" value="${F.from || ''}"></div>
           <div class="fgrp"><label>To</label><input type="date" data-f="to" value="${F.to || ''}"></div>
           <button class="fbtn" data-freset="1">↺ Reset</button>
           <button class="fbtn" data-fexport="1" title="Download the filtered data (all fields) as Excel" style="background:#1E9E5A;border-color:#1E9E5A;color:#fff;">⬇ Download</button>
         </div>
       </div>`;
    c.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('change', () => {
      MIS.filters[inp.dataset.f] = inp.value;
      if (FILT_DIMS.includes(inp.dataset.f)) reconcileFilters(inp.dataset.f);
      loadData(true);
    }));
    const rb = c.querySelector('[data-freset]');
    if (rb) rb.addEventListener('click', () => { MIS.filters = { scope: 'motor', branch: '', sub_branch: '', employee: '', vehicle_type: '', product: '', insurer: '', channel: '', ncb: '', addon: '', from: '', to: '' }; loadData(true); });
    const xb = c.querySelector('[data-fexport]');
    if (xb) xb.addEventListener('click', () => misExport(xb));
  }

  // Download the current filtered selection (ALL fields) as .xlsx. Fetched as a
  // blob so the page's wrapped fetch supplies auth (no token needed in the URL).
  async function misExport(btn) {
    const old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Preparing…'; }
    try {
      const API = window.location.origin + '/api';
      const qs = new URLSearchParams();
      Object.entries(MIS.filters).forEach(([k, v]) => { if (v) qs.set(k, v); });
      const resp = await fetch(API + '/employee/export?' + qs.toString());
      if (!resp.ok) throw new Error('Export failed (' + resp.status + ')');
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `business_data_${MIS.filters.from || 'FY'}_to_${MIS.filters.to || 'today'}.xlsx`;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 200);
    } catch (e) {
      alert('Download failed: ' + (e && e.message ? e.message : e));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    }
  }

  // ---- body router ---------------------------------------------------------
  function renderBody() {
    const body = document.getElementById('misBody');
    if (!body) return;
    Object.values(MIS.charts).forEach(c => { try { c.destroy(); } catch (_) {} });
    MIS.charts = {};
    if (!MIS.data) { body.innerHTML = '<div class="mis-empty">No data.</div>'; return; }
    if (MIS.tab === 'overview') renderOverview(body);
    else if (MIS.tab === 'growth') renderGrowth(body);
    else if (MIS.tab === 'targets') renderTargets(body);
    else if (MIS.tab === 'breakdowns') renderBreakdowns(body);
    else if (MIS.tab === 'geography') renderGeography(body);
    else if (MIS.tab === 'agents') renderAgents(body);
    else if (MIS.tab === 'evaluation') renderEvaluation(body);
    else if (MIS.tab === 'margins') renderMargins(body);
    else if (MIS.tab === 'posp') renderPOSP(body);
    else if (MIS.tab === 'renewals') renderRenewals(body);
    else if (MIS.tab === 'more') renderMore(body);
    else if (MIS.tab === 'tree') renderTree(body);
  }

  // shared: a horizontal bar-list card (top-N of a {k,nop,premium}[] list)
  MIS.blMetric = 'premium';
  function barListCard(title, rows, opts) {
    opts = opts || {};
    const isPrem = (opts.metric || MIS.blMetric) === 'premium';
    const val = (r) => isPrem ? r.premium : r.nop;
    const data = (rows || []).slice().filter(r => r && r.k).sort((a, b) => val(b) - val(a));
    const top = opts.limit ? data.slice(0, opts.limit) : data;
    const max = Math.max(1, ...top.map(val));
    const total = data.reduce((a, r) => a + val(r), 0);
    const card = el('div', 'mis-card mis-blcard');
    card.innerHTML =
      `<div class="mis-charthd"><h3>${escapeHtml(title)}</h3>
         ${opts.noToggle ? '' : `<div class="mis-toggle"><button data-bl="premium" class="${isPrem ? 'on' : ''}">Premium</button><button data-bl="nop" class="${!isPrem ? 'on' : ''}">NOP</button></div>`}</div>
       <div class="bllist">${top.map(r => {
         const v = val(r), share = total ? (v / total * 100) : 0;
         return `<div class="blrow"><span class="blk" title="${escapeHtml(r.k)}">${escapeHtml(r.k)}</span>
             <span class="blbar"><i style="width:${Math.max(2, v / max * 100).toFixed(1)}%"></i></span>
             <span class="blv">${isPrem ? fmtL(v) : fmtNum(v)}</span><span class="blsh">${share.toFixed(0)}%</span></div>`;
       }).join('') || '<div class="mis-empty" style="padding:24px;">No data</div>'}</div>`;
    if (!opts.noToggle) card.querySelectorAll('.mis-toggle button').forEach(b => b.addEventListener('click', () => { MIS.blMetric = b.dataset.bl; renderBody(); }));
    return card;
  }

  // ======================================================================
  //  #1  Business FTD / MTD / YTD  ×  status
  // ======================================================================
  const STATUS_KEYS = [
    { k: 'ok_to_log',      label: 'Ok to Log',    color: COLORS.okLog },
    { k: 'uw_pending',     label: 'Pending (U/W)', color: COLORS.pend },
    { k: 'return_to_bops', label: 'Sent to Bops', color: COLORS.bops },
  ];
  const PERIODS = [
    { k: 'ftd', label: 'FTD', hint: 'For The Day' },
    { k: 'mtd', label: 'MTD', hint: 'Month To Date' },
    { k: 'ytd', label: 'YTD', hint: 'Year To Date' },
  ];

  function renderOverview(body) {
    const P = MIS.data.periods || {};
    body.innerHTML = '';

    // --- period cards (numbers) -----------------------------------------
    const grid = el('div', 'mis-grid3');
    PERIODS.forEach(pd => {
      const d = P[pd.k] || {};
      const card = el('div', 'mis-card mis-pcard');
      const rows = STATUS_KEYS.map(s => {
        const v = d[s.k] || {};
        return `<div class="mis-stat"><span class="dot" style="background:${s.color}"></span>
                  <span class="nm">${s.label}</span>
                  <span class="nop">${fmtNum(v.nop)} <small style="color:#B4BAC4">nop</small></span>
                  <span class="pr">${fmtL(v.premium)}</span></div>`;
      }).join('');
      card.innerHTML =
        `<div class="accent"></div>
         <div style="display:flex;justify-content:space-between;align-items:baseline;">
           <div><div class="plabel">${pd.label}</div><div class="prange">${pd.hint}</div></div>
           <div style="text-align:right;"><div style="font-size:10.5px;color:#9AA3AF;text-transform:uppercase;letter-spacing:.8px;font-weight:700;">Ok to Log</div>
             <div style="font-family:var(--oi-display);font-size:16px;font-weight:800;color:#1E9E5A;">${fmtNum((d.ok_to_log || {}).nop)}</div></div>
         </div>
         <div class="pbig">${fmtL(d.premium)}</div>
         <div class="pnop"><b>${fmtNum(d.nop)}</b> policies · total booked</div>
         <div style="margin-top:10px;">${rows}</div>`;
      grid.appendChild(card);
    });
    body.appendChild(grid);

    // --- charts: #1 status split (left) + #2 NOP/Premium trend (right) --
    const row = el('div', 'mis-chartrow');

    const cc = el('div', 'mis-card mis-chartcard');
    cc.innerHTML =
      `<div class="mis-charthd">
         <h3>Status split — FTD / MTD / YTD</h3>
         <div class="mis-toggle">
           <button data-m="premium" class="${MIS.metric === 'premium' ? 'on' : ''}">Premium</button>
           <button data-m="nop" class="${MIS.metric === 'nop' ? 'on' : ''}">NOP</button>
         </div>
       </div>
       <div class="mis-chartwrap"><canvas id="misChart1"></canvas></div>
       <div class="mis-legend">${STATUS_KEYS.map(s => `<span><i style="background:${s.color}"></i>${s.label}</span>`).join('')}</div>`;
    cc.querySelectorAll('.mis-toggle button').forEach(b => b.addEventListener('click', () => {
      MIS.metric = b.dataset.m; renderOverview(body);
    }));

    const tc = el('div', 'mis-card mis-chartcard');
    tc.innerHTML =
      `<div class="mis-charthd">
         <h3>NOP &amp; Net Premium — month on month</h3>
         <span style="font-size:11px;color:#9AA3AF;font-weight:600;">current FY</span>
       </div>
       <div class="mis-chartwrap"><canvas id="misChart2"></canvas></div>
       <div class="mis-legend"><span><i style="background:${COLORS.blueDk}"></i>Net Premium (₹L)</span><span><i style="background:${COLORS.pend}"></i>NOP</span></div>`;

    row.appendChild(cc); row.appendChild(tc);
    body.appendChild(row);
    drawChart1();
    drawChart2();
  }

  function drawChart1() {
    const ctx = document.getElementById('misChart1');
    if (!ctx || !window.Chart) return;
    const P = MIS.data.periods || {};
    const isPrem = MIS.metric === 'premium';
    const val = (d, sk) => { const v = (d[sk] || {}); return isPrem ? (Number(v.premium) || 0) / 1e5 : (Number(v.nop) || 0); };
    const datasets = STATUS_KEYS.map(s => ({
      label: s.label,
      data: PERIODS.map(pd => val(P[pd.k] || {}, s.k)),
      backgroundColor: s.color,
      borderRadius: 6,
      maxBarThickness: 46,
    }));
    if (MIS.charts.c1) MIS.charts.c1.destroy();
    MIS.charts.c1 = new Chart(ctx, {
      type: 'bar',
      data: { labels: PERIODS.map(p => p.label), datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#00243E', padding: 10, cornerRadius: 8, titleFont: { weight: '700' },
            callbacks: { label: (c) => ` ${c.dataset.label}: ${isPrem ? '₹' + c.raw.toFixed(2) + ' L' : fmtNum(c.raw) + ' nop'}` },
          },
        },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { color: COLORS.axis, font: { weight: '700' } } },
          y: { stacked: true, grid: { color: COLORS.grid }, ticks: { color: COLORS.axis, callback: (v) => isPrem ? '₹' + v + 'L' : fmtNum(v) } },
        },
      },
    });
  }

  // ======================================================================
  //  #2  NOP & Net Premium — month on month
  // ======================================================================
  function drawChart2() {
    const ctx = document.getElementById('misChart2');
    if (!ctx || !window.Chart) return;
    const months = MIS.data.by_month || [];
    if (MIS.charts.c2) MIS.charts.c2.destroy();
    MIS.charts.c2 = new Chart(ctx, {
      data: {
        labels: months.map(m => m.label),
        datasets: [
          { type: 'bar', label: 'Net Premium (₹L)', yAxisID: 'yP', data: months.map(m => (Number(m.premium) || 0) / 1e5),
            backgroundColor: 'rgba(0,130,200,.85)', borderRadius: 5, maxBarThickness: 30, order: 2 },
          { type: 'line', label: 'NOP', yAxisID: 'yN', data: months.map(m => Number(m.nop) || 0),
            borderColor: COLORS.pend, backgroundColor: COLORS.pend, borderWidth: 2.5, tension: .35,
            pointRadius: 3, pointHoverRadius: 5, pointBackgroundColor: '#fff', pointBorderWidth: 2, order: 1, fill: false },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: '#00243E', padding: 10, cornerRadius: 8,
            callbacks: { label: (c) => c.dataset.yAxisID === 'yP' ? ` Premium: ₹${c.raw.toFixed(2)} L` : ` NOP: ${fmtNum(c.raw)}` } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: COLORS.axis, font: { size: 11 }, maxRotation: 0, autoSkip: true } },
          yP: { position: 'left', grid: { color: COLORS.grid }, ticks: { color: COLORS.blueDk, callback: (v) => '₹' + v + 'L' } },
          yN: { position: 'right', grid: { display: false }, ticks: { color: COLORS.pend, callback: (v) => fmtNum(v) } },
        },
      },
    });
  }

  // ======================================================================
  //  #3  Tree-wise business — Branch → Sub-branch → Employee
  // ======================================================================
  MIS.treeMetric = 'premium';   // bar metric
  MIS.treeExpanded = {};        // node key -> bool

  function renderTree(body) {
    const rows = MIS.data.tree || [];
    body.innerHTML = '';
    if (!rows.length) { body.innerHTML = '<div class="mis-empty">No tree data for this selection.</div>'; return; }

    // group Branch → Sub-branch → Employee
    const B = new Map();
    rows.forEach(r => {
      if (!B.has(r.branch)) B.set(r.branch, { name: r.branch, nop: 0, premium: 0, subs: new Map() });
      const b = B.get(r.branch); b.nop += r.nop; b.premium += r.premium;
      if (!b.subs.has(r.sub_branch)) b.subs.set(r.sub_branch, { name: r.sub_branch, nop: 0, premium: 0, emps: [] });
      const s = b.subs.get(r.sub_branch); s.nop += r.nop; s.premium += r.premium;
      s.emps.push({ name: r.emp_name, code: r.emp_code, nop: r.nop, premium: r.premium });
    });
    const branches = [...B.values()].sort((x, y) => y.premium - x.premium);
    const grand = { nop: branches.reduce((a, b) => a + b.nop, 0), premium: branches.reduce((a, b) => a + b.premium, 0) };
    const isPrem = MIS.treeMetric === 'premium';
    const maxB = Math.max(1, ...branches.map(b => isPrem ? b.premium : b.nop));
    const mval = (o) => isPrem ? o.premium : o.nop;
    const cell = (o) => `<span class="tnop">${fmtNum(o.nop)} <small>nop</small></span><span class="tpr">${fmtL(o.premium)}</span>`;

    const card = el('div', 'mis-card', '');
    card.style.padding = '0';
    let h =
      `<div class="mis-treehd">
         <div><h3>Business Tree — Branch › Sub-branch › Employee</h3>
           <div class="tsub">${branches.length} branches · <b>${fmtNum(grand.nop)}</b> policies · <b>${fmtL(grand.premium)}</b></div></div>
         <div style="display:flex;gap:10px;align-items:center;">
           <div class="mis-toggle"><button data-tm="premium" class="${isPrem ? 'on' : ''}">Premium</button><button data-tm="nop" class="${!isPrem ? 'on' : ''}">NOP</button></div>
           <button class="mis-linkbtn" data-act="expand">Expand all</button>
           <button class="mis-linkbtn" data-act="collapse">Collapse all</button>
         </div>
       </div>
       <div class="mis-treewrap">`;

    branches.forEach((b, bi) => {
      const bkey = 'b' + bi;
      const bOpen = !!MIS.treeExpanded[bkey];
      const subs = [...b.subs.values()].sort((x, y) => mval(y) - mval(x));
      h += `<div class="trow trow-b" data-key="${bkey}" data-toggle="1">
              <span class="tcaret">${bOpen ? '−' : '+'}</span>
              <span class="tname">${escapeHtml(b.name)}</span>
              <span class="tbar"><i style="width:${Math.max(2, pct(mval(b), maxB)).toFixed(1)}%"></i></span>
              ${cell(b)}
            </div>
            <div class="tchildren" data-parent="${bkey}" style="display:${bOpen ? 'block' : 'none'}">`;
      subs.forEach((s, si) => {
        const skey = bkey + 's' + si;
        const sOpen = !!MIS.treeExpanded[skey];
        const emps = s.emps.slice().sort((x, y) => mval(y) - mval(x));
        const maxE = Math.max(1, ...emps.map(mval));
        h += `<div class="trow trow-s" data-key="${skey}" data-toggle="1">
                <span class="tcaret">${sOpen ? '−' : '+'}</span>
                <span class="tname">${escapeHtml(s.name)}</span>
                <span class="tbar tbar-s"><i style="width:${Math.max(2, pct(mval(s), maxB)).toFixed(1)}%"></i></span>
                ${cell(s)}
              </div>
              <div class="tchildren" data-parent="${skey}" style="display:${sOpen ? 'block' : 'none'}">`;
        emps.forEach(e => {
          h += `<div class="trow trow-e">
                  <span class="tcaret tleaf">•</span>
                  <span class="tname">${escapeHtml(e.name)} <small class="tcode">${escapeHtml(e.code)}</small></span>
                  <span class="tbar tbar-e"><i style="width:${Math.max(2, pct(mval(e), maxE)).toFixed(1)}%"></i></span>
                  ${cell(e)}
                </div>`;
        });
        h += `</div>`;
      });
      h += `</div>`;
    });
    h += `</div>`;
    card.innerHTML = h;
    body.appendChild(card);

    // interactions
    card.querySelectorAll('.mis-toggle button').forEach(btn => btn.addEventListener('click', () => { MIS.treeMetric = btn.dataset.tm; renderTree(body); }));
    card.querySelectorAll('.mis-linkbtn').forEach(btn => btn.addEventListener('click', () => {
      const on = btn.dataset.act === 'expand';
      branches.forEach((b, bi) => { MIS.treeExpanded['b' + bi] = on; [...b.subs.keys()].forEach((_, si) => MIS.treeExpanded['b' + bi + 's' + si] = on); });
      renderTree(body);
    }));
    card.querySelectorAll('.trow[data-toggle]').forEach(rowEl => rowEl.addEventListener('click', () => {
      const k = rowEl.dataset.key; MIS.treeExpanded[k] = !MIS.treeExpanded[k];
      const kids = card.querySelector(`.tchildren[data-parent="${k}"]`);
      if (kids) kids.style.display = MIS.treeExpanded[k] ? 'block' : 'none';
      const car = rowEl.querySelector('.tcaret'); if (car) car.textContent = MIS.treeExpanded[k] ? '−' : '+';
    }));
  }

  // ======================================================================
  //  #4  Current vs Previous — Ok to Log (MTD & YTD)   +   #5  Growth %
  // ======================================================================
  const growthBadge = (cur, prev) => {
    if (!prev && !cur) return `<span class="gbadge flat">—</span>`;
    if (!prev) return `<span class="gbadge up">NEW</span>`;
    const g = ((cur - prev) / prev) * 100;
    const cls = g > 0.05 ? 'up' : (g < -0.05 ? 'down' : 'flat');
    const arr = g > 0.05 ? '▲' : (g < -0.05 ? '▼' : '▬');
    return `<span class="gbadge ${cls}">${arr} ${Math.abs(g).toFixed(1)}%</span>`;
  };
  const cmpRow = (label, cur, prev, prem) => {
    const c = prem ? cur.premium : cur.nop, p = prem ? prev.premium : prev.nop;
    const fv = prem ? fmtL : fmtNum;
    return `<div class="grow">
        <span class="glbl">${label}</span>
        <span class="gcur">${fv(c)}</span>
        <span class="gprev">prev ${fv(p)}</span>
        ${growthBadge(c, p)}
      </div>`;
  };

  async function renderGrowth(body) {
    body.innerHTML = '<div class="mis-empty">Loading current-vs-previous comparison…</div>';
    if (!MIS.compare) {
      if (window.MIS_PREVIEW_COMPARE) { MIS.compare = window.MIS_PREVIEW_COMPARE; }
      else {
        try {
          const API = window.location.origin + '/api';
          const qs = new URLSearchParams();
          Object.entries(MIS.filters).forEach(([k, v]) => { if (v && k !== 'from' && k !== 'to') qs.set(k, v); });
          const r = await fetch(API + '/employee/compare?' + qs.toString()).then(x => x.json());
          if (!r || !r.success) throw new Error((r && r.error) || 'failed');
          MIS.compare = r;
        } catch (e) { body.innerHTML = `<div class="mis-empty">Could not load comparison — ${escapeHtml(e.message || e)}</div>`; return; }
      }
    }
    const C = MIS.compare;
    body.innerHTML = '';
    const grid = el('div', 'mis-grid2');
    [['MTD', C.mtd, 'This business month vs last'], ['YTD', C.ytd, 'This FY vs last FY (same period)']].forEach(([lbl, d, hint]) => {
      const okC = d.current.ok_to_log, okP = d.previous.ok_to_log;
      const g = okP.premium ? ((okC.premium - okP.premium) / okP.premium) * 100 : (okC.premium ? 100 : 0);
      const gcls = g > 0.05 ? 'up' : (g < -0.05 ? 'down' : 'flat');
      const card = el('div', 'mis-card mis-gcard');
      card.innerHTML =
        `<div class="ghead">
           <div><div class="plabel">${lbl}</div><div class="prange">${hint}</div></div>
           <div class="gsplash ${gcls}">${growthBadge(okC.premium, okP.premium)}<div class="gsplash-lbl">Ok-to-Log growth</div></div>
         </div>
         <div class="gbig">${fmtL(okC.premium)}</div>
         <div class="gbig-sub">Ok-to-Log premium · <b>${fmtNum(okC.nop)}</b> policies &nbsp;·&nbsp; prev ${fmtL(okP.premium)} / ${fmtNum(okP.nop)}</div>
         <div class="gdiv"></div>
         ${cmpRow('Ok-to-Log · NOP', { nop: okC.nop }, { nop: okP.nop }, false)}
         ${cmpRow('Total booked · Premium', d.current, d.previous, true)}
         ${cmpRow('Total booked · NOP', d.current, d.previous, false)}`;
      grid.appendChild(card);
    });
    body.appendChild(grid);
    const note = el('div', 'mis-note', 'Ranges — MTD: 2nd→today of the business month (prev = same window last month). YTD: 1-Apr→today (prev = last FY to the same date).');
    body.appendChild(note);
  }

  // ======================================================================
  //  #7 Target vs Achievement (MTD) · #8 YTD Target vs Achievement · #9 Productivity
  // ======================================================================
  function renderTargets(body) {
    const P = MIS.data.periods || {};
    const emps = MIS.data.by_employee || [];
    const N = Math.max(1, emps.length);
    const monthsElapsed = monthsInFY(P.fy_start, P.today);          // for pro-rated MTD/YTD target
    const ytdTarget = N * TARGET_PER_EMP * (monthsElapsed / 12);    // pro-rated to date
    const ytdAch = (P.ytd && P.ytd.premium) || 0;
    const mtdTarget = N * TARGET_PER_EMP / 12;                      // one month
    const mtdAch = (P.mtd && P.mtd.premium) || 0;
    body.innerHTML = '';

    const grid = el('div', 'mis-grid3');
    grid.appendChild(gaugeCard('MTD', 'Target vs Achievement', mtdAch, mtdTarget));      // #7
    grid.appendChild(gaugeCard('YTD', 'Target vs Achievement (to date)', ytdAch, ytdTarget)); // #8
    // #9 productivity summary
    const onTrackTarget = TARGET_PER_EMP * (monthsElapsed / 12);
    const onTrack = emps.filter(e => (e.premium || 0) >= onTrackTarget).length;
    const avg = ytdAch / N;
    const prod = el('div', 'mis-card mis-prodcard');
    prod.innerHTML =
      `<div class="plabel" style="color:#F5A011;">Overall Productivity</div>
       <div class="prodmain">${((ytdAch / (ytdTarget || 1)) * 100).toFixed(0)}<span>%</span></div>
       <div class="prodsub">of the YTD target achieved</div>
       <div class="prodrows">
         <div class="prow"><span>Team size</span><b>${fmtNum(N)} emp</b></div>
         <div class="prow"><span>Avg / employee (YTD)</span><b>${fmtL(avg)}</b></div>
         <div class="prow"><span>Target / employee</span><b>${fmtL(TARGET_PER_EMP)}/yr</b></div>
         <div class="prow"><span>On-track employees</span><b>${fmtNum(onTrack)} / ${fmtNum(N)}</b></div>
       </div>`;
    grid.appendChild(prod);
    body.appendChild(grid);

    const note = el('div', 'mis-note',
      `Targets are a placeholder — <b>₹1 Cr / employee / year</b>, pro-rated to ${monthsElapsed} month(s) elapsed this FY. Achievement = total booked premium. Swap in real per-employee targets when available.`);
    body.appendChild(note);
    drawGauge('gMTD', mtdAch, mtdTarget);
    drawGauge('gYTD', ytdAch, ytdTarget);
  }

  function monthsInFY(fyStart, today) {
    if (!fyStart || !today) return 1;
    const a = new Date(fyStart), b = new Date(today);
    return Math.max(1, (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + 1);
  }

  function gaugeCard(label, hint, ach, target) {
    const pctv = target ? (ach / target) * 100 : 0;
    const cls = pctv >= 100 ? 'up' : (pctv >= 75 ? 'flat' : 'down');
    const card = el('div', 'mis-card mis-gaugecard');
    card.innerHTML =
      `<div style="display:flex;justify-content:space-between;"><div><div class="plabel">${label}</div><div class="prange">${hint}</div></div>
         <span class="gbadge ${cls}">${pctv.toFixed(0)}%</span></div>
       <div class="mis-gaugewrap"><canvas id="g${label}"></canvas>
         <div class="gaugectr"><div class="gcpct">${pctv.toFixed(0)}%</div><div class="gclbl">achieved</div></div></div>
       <div class="gaugerows">
         <div class="prow"><span>Achievement</span><b style="color:#1E9E5A;">${fmtL(ach)}</b></div>
         <div class="prow"><span>Target</span><b>${fmtL(target)}</b></div>
         <div class="prow"><span>Gap</span><b style="color:${ach >= target ? '#1E9E5A' : '#E15554'};">${(ach >= target ? '+' : '') + fmtL(ach - target)}</b></div>
       </div>`;
    return card;
  }

  function drawGauge(id, ach, target) {
    const ctx = document.getElementById(id);
    if (!ctx || !window.Chart) return;
    const p = Math.min(100, target ? (ach / target) * 100 : 0);
    const col = p >= 100 ? '#1E9E5A' : (p >= 75 ? '#F5A011' : '#E15554');
    if (MIS.charts[id]) MIS.charts[id].destroy();
    MIS.charts[id] = new Chart(ctx, {
      type: 'doughnut',
      data: { datasets: [{ data: [p, 100 - p], backgroundColor: [col, '#EEF1F4'], borderWidth: 0 }] },
      options: { rotation: -90, circumference: 180, cutout: '74%', responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } } },
    });
  }

  // ======================================================================
  //  #10 Breakdowns  +  #20 Motor/Non-motor + policy type  +  #22 Online/Offline
  // ======================================================================
  function renderBreakdowns(body) {
    const d = MIS.data;
    body.innerHTML = '';
    // #22 online vs offline strip
    const s = d.summary || {};
    const chan = el('div', 'mis-grid2');
    chan.appendChild(channelCard('Offline', s.offline_nop, s.offline_premium, s.nop, s.premium, COLORS.navy));
    chan.appendChild(channelCard('Online', s.online_nop, s.online_premium, s.nop, s.premium, COLORS.online));
    body.appendChild(chan);
    // breakdown grid
    const g = el('div', 'mis-blgrid');
    g.appendChild(barListCard('By Vehicle Type', (d.by_vehicle_type || []).map(r => ({ k: r.vehicle_type, nop: r.nop, premium: r.premium }))));
    g.appendChild(barListCard('By Insurer', d.by_insurer, { limit: 12 }));
    g.appendChild(barListCard('By Product / Policy Type', d.by_product));
    body.appendChild(g);
    // fuel / addon / NCB / category — only in uploaded PRs
    body.appendChild(el('div', 'mis-note',
      'Fuel type, Add-on vs Without-add-on, NCB vs Without-NCB and detailed vehicle-category splits are only captured on policies that came through an uploaded Premium Register — not the full live book. Wire the PR join for full coverage, or these render for PR-covered months only.'));
  }
  function channelCard(label, nop, prem, tnop, tprem, color) {
    const share = tprem ? (prem / tprem * 100) : 0;
    const card = el('div', 'mis-card mis-pcard');
    card.innerHTML =
      `<div class="accent" style="background:${color};"></div>
       <div class="plabel" style="color:${color};">${label} business</div>
       <div class="pbig">${fmtL(prem)}</div>
       <div class="pnop"><b>${fmtNum(nop)}</b> policies · ${share.toFixed(0)}% of premium</div>
       <div class="mis-stat"><span class="dot" style="background:${color}"></span><span class="nm">Share of book</span>
         <span class="pr">${share.toFixed(1)}%</span></div>`;
    return card;
  }

  // ======================================================================
  //  #11  Geography — State + RTO (Maharashtra focus)
  // ======================================================================
  function renderGeography(body) {
    const d = MIS.data;
    body.innerHTML = '';
    const g = el('div', 'mis-blgrid');
    g.appendChild(barListCard('By State', d.by_state, { limit: 15 }));
    // RTO table (top), MH highlighted
    const rtos = (d.by_rto || []).slice(0, 40);
    const isPrem = MIS.blMetric === 'premium';
    const tbl = el('div', 'mis-card mis-blcard');
    tbl.innerHTML =
      `<div class="mis-charthd"><h3>By RTO (top 40)</h3><span style="font-size:11px;color:#9AA3AF;">MH rows highlighted</span></div>
       <div class="rtowrap"><table class="rtotbl"><thead><tr><th>RTO</th><th>State</th><th style="text-align:right;">NOP</th><th style="text-align:right;">Premium</th></tr></thead>
       <tbody>${rtos.map(r => `<tr class="${/^MH/i.test(r.k) ? 'mh' : ''}"><td class="rmono">${escapeHtml(r.k)}</td><td>${escapeHtml(r.state)}</td>
         <td style="text-align:right;">${fmtNum(r.nop)}</td><td style="text-align:right;font-weight:700;">${fmtL(r.premium)}</td></tr>`).join('')}</tbody></table></div>`;
    g.appendChild(tbl);
    body.appendChild(g);
  }

  // ======================================================================
  //  #12 Top-7 agents  ·  #21 Top RM  ·  #18 Agent active-vs-total
  // ======================================================================
  MIS.agentPeriod = MIS.agentPeriod || 'ytd';   // 'mtd' | 'ytd'
  function renderAgents(body) {
    const d = MIS.data;
    body.innerHTML = '';
    const per = MIS.agentPeriod;
    const pick = (o) => per === 'mtd' ? { nop: o.mtd_nop || 0, premium: o.mtd_premium || 0 } : { nop: o.nop || 0, premium: o.premium || 0 };
    const hd = el('div', 'mis-periodhd');
    hd.innerHTML =
      `<div><h2 class="mis-secttl">Agents &amp; RM performance</h2><div class="mis-sectsub">Leaderboards for the selected period</div></div>
       <div class="mis-toggle mis-pertoggle"><button data-ap="mtd" class="${per === 'mtd' ? 'on' : ''}">MTD</button><button data-ap="ytd" class="${per === 'ytd' ? 'on' : ''}">YTD</button></div>`;
    body.appendChild(hd);
    hd.querySelectorAll('[data-ap]').forEach(b => b.addEventListener('click', () => { MIS.agentPeriod = b.dataset.ap; renderAgents(body); }));
    const g = el('div', 'mis-blgrid');
    g.appendChild(barListCard(`Top 7 Agents (POS) · ${per.toUpperCase()}`, (d.by_agent || []).map(a => Object.assign({ k: (a.name || a.code) }, pick(a))), { limit: 7 }));
    g.appendChild(barListCard(`Top 7 RM / Employees · ${per.toUpperCase()}`, (d.by_employee || []).map(e => Object.assign({ k: (e.name || e.code) }, pick(e))), { limit: 7 }));
    // #18 POS producing-vs-idle (live POS = not deactivated)
    const ps = d.agent_pos || { total: 0, producing: 0, idle: 0 };
    const prodPct = ps.total ? (ps.producing / ps.total * 100) : 0;
    const pc = el('div', 'mis-card mis-blcard');
    pc.innerHTML =
      `<div class="mis-charthd"><h3>POS — Producing vs Idle</h3><span style="font-size:11px;color:#9AA3AF;">live POS (not deactivated)</span></div>
       <div style="display:flex;align-items:center;gap:18px;margin-top:6px;">
         <div style="position:relative;width:130px;height:130px;flex:none;"><canvas id="posGauge"></canvas>
           <div class="gaugectr" style="top:38%;bottom:auto;"><div class="gcpct" style="font-size:24px;">${prodPct.toFixed(0)}%</div><div class="gclbl">producing</div></div></div>
         <div style="flex:1;">
           <div class="prow"><span><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#1E9E5A;margin-right:6px;"></span>Producing (has business)</span><b>${fmtNum(ps.producing)}</b></div>
           <div class="prow"><span><span class="dot" style="display:inline-block;width:9px;height:9px;border-radius:50%;background:#E3E6EA;margin-right:6px;"></span>Idle (no policy found)</span><b>${fmtNum(ps.idle)}</b></div>
           <div class="prow"><span>Total live POS</span><b>${fmtNum(ps.total)}</b></div>
         </div>
       </div>`;
    g.appendChild(pc);
    body.appendChild(g);
    if (ps.total) setTimeout(() => {
      const ctx = document.getElementById('posGauge');
      if (ctx && window.Chart) { if (MIS.charts.posGauge) MIS.charts.posGauge.destroy();
        MIS.charts.posGauge = new Chart(ctx, { type: 'doughnut',
          data: { datasets: [{ data: [ps.producing, ps.idle], backgroundColor: ['#1E9E5A', '#E3E6EA'], borderWidth: 0 }] },
          options: { cutout: '72%', responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } } });
      }
    }, 0);
    body.appendChild(el('div', 'mis-note', 'Total = POS with no deactivated-date (still live). Producing = at least one policy booked against the poscode this FY. Idle = live POS with zero policies — the win-back / activation list.'));
  }

  // honest placeholder for items awaiting a data feed
  function pendingCard(title, msg) {
    const c = el('div', 'mis-card', '');
    c.style.cssText = 'padding:22px 20px;border-style:dashed;';
    c.innerHTML = `<div style="display:flex;align-items:center;gap:10px;">
        <span style="width:30px;height:30px;border-radius:8px;background:#FFF4E0;color:#C47D00;display:inline-flex;align-items:center;justify-content:center;font-size:16px;">⏳</span>
        <div><div style="font-family:var(--oi-display);font-weight:700;color:#00243E;font-size:14px;">${escapeHtml(title)}</div>
          <div style="font-size:12px;color:#6B7585;margin-top:3px;">${escapeHtml(msg)}</div></div></div>`;
    return c;
  }

  // ======================================================================
  //  #13  Business Evaluation — dormancy (lapsed / dormant agents)
  // ======================================================================
  function renderEvaluation(body) {
    const rows = MIS.data.agent_activity || [];
    body.innerHTML = '';
    const active = rows.filter(r => r.cur_nop > 0);
    const lapsed = rows.filter(r => r.prev_nop > 0 && r.cur_nop === 0);                 // last month → 0 this month
    const dormant = rows.filter(r => r.cur_nop === 0 && r.prev_nop === 0 && r.prev2_nop === 0 && r.ytd_nop > 0); // 2m+ quiet
    const kpi = el('div', 'mis-grid3');
    kpi.appendChild(evalKpi('Active this month', active.length, rows.length, '#1E9E5A', 'agents who booked in the current month'));
    kpi.appendChild(evalKpi('Lapsed', lapsed.length, rows.length, '#F5A011', 'had business last month, 0 this month'));
    kpi.appendChild(evalKpi('Dormant 2m+', dormant.length, rows.length, '#E15554', 'no business in the last 2 months'));
    body.appendChild(kpi);
    const g = el('div', 'mis-blgrid');
    g.appendChild(evalListCard('Lapsed agents — win-back list', lapsed.sort((a, b) => b.ytd_premium - a.ytd_premium)));
    g.appendChild(evalListCard('Dormant agents (2m+)', dormant.sort((a, b) => b.ytd_premium - a.ytd_premium)));
    body.appendChild(g);
    body.appendChild(el('div', 'mis-note', 'Lapsed = booked last business month but nothing this month. Dormant = no business in the last two business months (but active earlier this FY). "Last business" is the most recent booking date.'));
  }
  function evalKpi(label, n, total, color, hint) {
    const c = el('div', 'mis-card mis-pcard');
    c.innerHTML = `<div class="accent" style="background:${color};"></div>
      <div class="plabel" style="color:${color};">${label}</div>
      <div class="pbig">${fmtNum(n)}</div>
      <div class="pnop">${((n / (total || 1)) * 100).toFixed(0)}% of ${fmtNum(total)} agents · ${hint}</div>`;
    return c;
  }
  function evalListCard(title, list) {
    const c = el('div', 'mis-card mis-blcard');
    c.innerHTML = `<div class="mis-charthd"><h3>${escapeHtml(title)}</h3><span style="font-size:11px;color:#9AA3AF;">${fmtNum(list.length)} agents</span></div>
      <div class="rtowrap"><table class="rtotbl"><thead><tr><th>Agent</th><th style="text-align:right;">YTD NOP</th><th style="text-align:right;">YTD Premium</th><th>Last business</th></tr></thead>
      <tbody>${list.slice(0, 50).map(r => `<tr><td>${escapeHtml(r.name)}<div style="font-size:10px;color:#B4BAC4;font-family:Consolas,monospace;">${escapeHtml(r.code)}</div></td>
        <td style="text-align:right;">${fmtNum(r.ytd_nop)}</td><td style="text-align:right;font-weight:700;">${fmtL(r.ytd_premium)}</td>
        <td>${escapeHtml(r.last_biz || '—')}</td></tr>`).join('') || '<tr><td colspan="4" style="padding:20px;text-align:center;color:#9AA3AF;">None 🎉</td></tr>'}</tbody></table></div>`;
    return c;
  }

  // ======================================================================
  //  #14 — Margin by level (payout-cycle margins rolled up the reporting tree)
  // ======================================================================
  function renderMargins(body) {
    body.innerHTML = '';
    // Preview harness supplies a static payload; live mode fetches per cycle.
    if (window.MIS_MARGIN_PREVIEW && !MIS._marginLive) MIS.margin = window.MIS_MARGIN_PREVIEW;
    const haveCycle = MIS.margin && MIS.margin.cycle ? String(MIS.margin.cycle.id) : null;
    const needFetch = !window.MIS_MARGIN_PREVIEW && (!MIS.margin || (MIS.marginCycleId && String(MIS.marginCycleId) !== haveCycle));
    if (needFetch) { marginFetch(); body.appendChild(el('div', 'mis-note', 'Loading margins…')); return; }

    const m = MIS.margin;
    if (!m || m.success === false) { body.appendChild(el('div', 'mis-note', 'Could not load margins' + (m && m.error ? ': ' + escapeHtml(m.error) : '') + '.')); return; }
    if (!m.cycles || !m.cycles.length) { body.appendChild(el('div', 'mis-note', 'No payout cycle has computed rows yet — margins appear once a cycle is calculated in the Payout module.')); return; }

    // ---- header: cycle picker + note ----
    const head = el('div', 'mis-charthd', '');
    head.style.cssText = 'align-items:center;margin-bottom:12px;';
    const cycOpts = m.cycles.map(c => `<option value="${c.id}"${String(c.id) === String(m.cycle.id) ? ' selected' : ''}>${escapeHtml(c.name)} · ${c.date_from || ''}→${c.date_to || ''} (${fmtNum(c.rows)} rows)</option>`).join('');
    head.innerHTML = `<h3 style="margin:0;">Margin by level <span style="font-weight:500;color:#9AA3AF;font-size:12px;">— retained spread (insurer rate − POS payout), rolled up the reporting tree</span></h3>
      <div class="fgrp" style="margin:0;"><label style="margin:0 6px 0 0;">Payout cycle</label><select id="misMarginCycle" ${window.MIS_MARGIN_PREVIEW ? 'disabled' : ''}>${cycOpts}</select></div>`;
    body.appendChild(head);

    // ---- KPI strip ----
    const t = m.totals || {};
    const blended = t.premium ? (t.margin / t.premium * 100) : 0;
    const strip = el('div', 'mis-marginkpi', '');
    strip.appendChild(marginKpi('Retained margin', fmtL(t.margin), COLORS.okLog, 'what OneInsure keeps'));
    strip.appendChild(marginKpi('Income (insurer → us)', fmtL(t.income), COLORS.blueDk, 'rate × premium'));
    strip.appendChild(marginKpi('Payout (us → POS)', fmtL(t.payout), COLORS.pend, 'outgoing to agents'));
    strip.appendChild(marginKpi('Blended margin %', blended.toFixed(2) + '%', COLORS.navy, 'margin ÷ premium'));
    strip.appendChild(marginKpi('Policies', fmtNum(t.nop), COLORS.online, 'attributed to your org'));
    body.appendChild(strip);

    // ---- per-level tables ----
    if (!m.levels || !m.levels.length) {
      body.appendChild(el('div', 'mis-note', 'No margin attributed to your org for this cycle — the POS agents that transacted this cycle are owned outside your reporting tree. Try a higher-level login or another cycle.'));
    } else {
      const g = el('div', 'mis-blgrid');
      m.levels.forEach(lv => g.appendChild(marginLevelCard(lv)));
      body.appendChild(g);
    }

    // ---- unattributed footnote ----
    const u = m.unattributed || {};
    body.appendChild(el('div', 'mis-note',
      `Margins come from the selected <b>payout cycle</b> (independent of the filter bar above). Each policy is attributed to the POS agent's owner and rolled up to the nearest manager at every level, so each level's total counts a policy once. `
      + (u.nop ? `<b>${fmtNum(u.nop)}</b> policies (${fmtL(u.margin)} margin) this cycle are owned by agents outside your reporting tree and are excluded here.` : '')));

    const sel = document.getElementById('misMarginCycle');
    if (sel) sel.addEventListener('change', () => { MIS.marginCycleId = sel.value; MIS._marginLive = true; MIS.margin = null; renderBody(); });
  }
  async function marginFetch() {
    if (MIS.marginLoading) return;
    MIS.marginLoading = true; MIS._marginLive = true;
    try {
      const qs = MIS.marginCycleId ? ('?cycle_id=' + encodeURIComponent(MIS.marginCycleId)) : '';
      const r = await fetch('/api/employee/margin-by-level' + qs);
      MIS.margin = await r.json();
    } catch (e) { MIS.margin = { success: false, error: String(e && e.message || e) }; }
    MIS.marginLoading = false;
    if (MIS.tab === 'margins') renderBody();
  }
  function marginKpi(label, val, color, hint) {
    const c = el('div', 'mis-card mis-pcard');
    c.innerHTML = `<div class="accent" style="background:${color};"></div>
      <div class="plabel" style="color:${color};">${label}</div>
      <div class="pbig" style="font-size:22px;">${val}</div>
      <div class="pnop">${hint}</div>`;
    return c;
  }
  function marginLevelCard(lv) {
    const c = el('div', 'mis-card mis-blcard');
    const tot = lv.totals || {};
    const mpct = tot.premium ? (tot.margin / tot.premium * 100) : 0;
    const maxMargin = Math.max(1, ...lv.nodes.map(n => n.margin));
    c.innerHTML = `<div class="mis-charthd"><h3>${escapeHtml(lv.level)}</h3>
        <span style="font-size:11px;color:#9AA3AF;">${fmtNum(lv.nodes.length)} unit${lv.nodes.length === 1 ? '' : 's'} · ${fmtL(tot.margin)} margin · ${mpct.toFixed(2)}%</span></div>
      <div class="rtowrap"><table class="rtotbl">
        <thead><tr><th>Unit</th><th style="text-align:right;">NOP</th><th style="text-align:right;">Premium</th>
          <th style="text-align:right;">Income</th><th style="text-align:right;">Payout</th><th style="text-align:right;">Margin</th><th style="text-align:right;">M%</th></tr></thead>
        <tbody>${lv.nodes.slice(0, 60).map(n => `<tr>
          <td>${escapeHtml(n.name)}<div style="font-size:10px;color:#B4BAC4;">${escapeHtml(n.designation || '—')}${n.location ? ' · ' + escapeHtml(n.location) : ''}</div></td>
          <td style="text-align:right;">${fmtNum(n.nop)}</td>
          <td style="text-align:right;">${fmtL(n.premium)}</td>
          <td style="text-align:right;">${fmtL(n.income)}</td>
          <td style="text-align:right;color:#B0663A;">${fmtL(n.payout)}</td>
          <td style="text-align:right;font-weight:700;position:relative;">
            <span style="position:absolute;left:0;top:50%;transform:translateY(-50%);height:60%;width:${Math.round(n.margin / maxMargin * 100)}%;background:rgba(30,158,90,.12);border-radius:3px;"></span>
            <span style="position:relative;">${fmtL(n.margin)}</span></td>
          <td style="text-align:right;">${n.margin_pct}%</td></tr>`).join('')}</tbody></table></div>`;
    return c;
  }

  // ======================================================================
  //  #15 — POSP creation by Location / RM / BM
  // ======================================================================
  function renderPOSP(body) {
    body.innerHTML = '';
    if (window.MIS_POSP_PREVIEW && !MIS._pospLive) MIS.posp = window.MIS_POSP_PREVIEW;
    const reqKey = (MIS.filters.from || '') + '|' + (MIS.filters.to || '');
    if (!window.MIS_POSP_PREVIEW && (!MIS.posp || MIS._pospReq !== reqKey)) { pospFetch(reqKey); body.appendChild(el('div', 'mis-note', 'Loading POSP creations…')); return; }

    const p = MIS.posp;
    if (!p || p.success === false) { body.appendChild(el('div', 'mis-note', 'Could not load POSP creations' + (p && p.error ? ': ' + escapeHtml(p.error) : '') + '.')); return; }
    const t = p.totals || { created: 0, active: 0 };
    const months = (p.by_month || []).length || 1;

    body.appendChild(el('div', 'mis-note',
      `New POSP onboarded in <b>${escapeHtml((p.range || {}).from || '')}</b> → <b>${escapeHtml((p.range || {}).to || '')}</b> (certificate date), attributed to the onboarding owner and rolled up the reporting tree. Use the <b>From / To</b> filters above to change the window.`));

    // KPI strip
    const strip = el('div', 'mis-marginkpi', '');
    strip.appendChild(marginKpi('POSP created', fmtNum(t.created), COLORS.blueDk, 'in this window'));
    strip.appendChild(marginKpi('Still active', fmtNum(t.active), COLORS.okLog, 'not yet deactivated'));
    strip.appendChild(marginKpi('Avg / month', fmtNum(Math.round(t.created / months)), COLORS.online, 'creations per month'));
    strip.appendChild(marginKpi('Top location', (p.by_location || [])[0] ? escapeHtml(p.by_location[0].location) : '—', COLORS.navy, (p.by_location || [])[0] ? p.by_location[0].created + ' created' : ''));
    strip.appendChild(marginKpi('Outside your org', fmtNum((p.unattributed || {}).created || 0), COLORS.pend, 'owner not in your tree'));
    body.appendChild(strip);

    // Monthly trend (inline bars) + By Location list
    const g1 = el('div', 'mis-blgrid');
    const maxM = Math.max(1, ...(p.by_month || []).map(m => m.created));
    const trend = el('div', 'mis-card mis-blcard');
    trend.innerHTML = `<div class="mis-charthd"><h3>Creations by month</h3><span style="font-size:11px;color:#9AA3AF;">${fmtNum(t.created)} total</span></div>
      <div class="bllist">${(p.by_month || []).map(m => `<div class="blrow"><span class="blk">${escapeHtml(m.ym)}</span>
        <span class="blbar"><i style="width:${Math.max(2, m.created / maxM * 100).toFixed(1)}%"></i></span>
        <span class="blv">${fmtNum(m.created)}</span><span class="blsh">${m.active}<small style="color:#B4BAC4"> act</small></span></div>`).join('') || '<div class="mis-empty" style="padding:24px;">No creations in range</div>'}</div>`;
    g1.appendChild(trend);
    g1.appendChild(barListCard('By Location', (p.by_location || []).map(l => ({ k: l.location, nop: l.created, premium: l.active })), { noToggle: true, metric: 'nop', limit: 14 }));
    body.appendChild(g1);

    // Per-level tables
    if (p.levels && p.levels.length) {
      const g2 = el('div', 'mis-blgrid');
      p.levels.forEach(lv => g2.appendChild(pospLevelCard(lv)));
      body.appendChild(g2);
    } else {
      body.appendChild(el('div', 'mis-note', 'No POSP creations attributed to your org in this window.'));
    }
  }
  async function pospFetch(reqKey) {
    if (MIS.pospLoading) return;
    MIS.pospLoading = true; MIS._pospLive = true; MIS._pospReq = reqKey;
    try {
      const qp = [];
      if (MIS.filters.from) qp.push('from=' + encodeURIComponent(MIS.filters.from));
      if (MIS.filters.to) qp.push('to=' + encodeURIComponent(MIS.filters.to));
      const r = await fetch('/api/employee/posp-creation' + (qp.length ? '?' + qp.join('&') : ''));
      MIS.posp = await r.json();
    } catch (e) { MIS.posp = { success: false, error: String(e && e.message || e) }; }
    MIS.pospLoading = false;
    if (MIS.tab === 'posp') renderBody();
  }
  function pospLevelCard(lv) {
    const c = el('div', 'mis-card mis-blcard');
    const tot = lv.totals || { created: 0, active: 0 };
    const maxC = Math.max(1, ...lv.nodes.map(n => n.created));
    c.innerHTML = `<div class="mis-charthd"><h3>${escapeHtml(lv.level)}</h3>
        <span style="font-size:11px;color:#9AA3AF;">${fmtNum(lv.nodes.length)} unit${lv.nodes.length === 1 ? '' : 's'} · ${fmtNum(tot.created)} created · ${fmtNum(tot.active)} active</span></div>
      <div class="rtowrap"><table class="rtotbl">
        <thead><tr><th>Unit</th><th style="text-align:right;">Created</th><th style="text-align:right;">Active</th></tr></thead>
        <tbody>${lv.nodes.slice(0, 60).map(n => `<tr>
          <td>${escapeHtml(n.name)}<div style="font-size:10px;color:#B4BAC4;">${escapeHtml(n.designation || '—')}${n.location ? ' · ' + escapeHtml(n.location) : ''}</div></td>
          <td style="text-align:right;font-weight:700;position:relative;">
            <span style="position:absolute;left:0;top:50%;transform:translateY(-50%);height:60%;width:${Math.round(n.created / maxC * 100)}%;background:rgba(0,130,200,.12);border-radius:3px;"></span>
            <span style="position:relative;">${fmtNum(n.created)}</span></td>
          <td style="text-align:right;">${fmtNum(n.active)}</td></tr>`).join('')}</tbody></table></div>`;
    return c;
  }

  // ======================================================================
  //  #16 — Renewal conversion (renewed vs new; same vs different insurer)
  // ======================================================================
  function renderRenewals(body) {
    body.innerHTML = '';
    const rn = (MIS.data && MIS.data.renewals) || null;
    if (!rn) { body.appendChild(el('div', 'mis-note', 'No renewal data in this payload.')); return; }
    const renewed = rn.renewed_nop || 0, nw = rn.new_nop || 0, total = renewed + nw;
    const rate = total ? (renewed / total * 100) : 0;
    const same = rn.same_nop || 0, diff = rn.diff_nop || 0, unknown = rn.unknown_nop || 0;
    const retention = renewed ? (same / renewed * 100) : 0;

    body.appendChild(el('div', 'mis-note',
      'A <b>renewal</b> is a policy flagged <code>IsRenewal</code>. <b>Same-insurer</b> = renewed with the expiring insurer (retention); <b>different-insurer</b> = switched carrier at renewal. The expiring insurer is read from the OCR-captured previous policy. Respects every filter above (scope, branch, product, dates…).'));

    // KPI strip
    const strip = el('div', 'mis-marginkpi', '');
    strip.appendChild(marginKpi('Renewed', fmtNum(renewed), COLORS.blueDk, fmtL(rn.renewed_premium) + ' premium'));
    strip.appendChild(marginKpi('New business', fmtNum(nw), COLORS.online, fmtL(rn.new_premium) + ' premium'));
    strip.appendChild(marginKpi('Renewal share', rate.toFixed(1) + '%', COLORS.navy, 'renewed ÷ total book'));
    strip.appendChild(marginKpi('Same insurer', fmtNum(same), COLORS.okLog, retention.toFixed(0) + '% of renewals (retained)'));
    strip.appendChild(marginKpi('Different insurer', fmtNum(diff), COLORS.pend, 'switched carrier' + (unknown ? ' · ' + fmtNum(unknown) + ' unknown' : '')));
    body.appendChild(strip);

    // Split bar (same vs different vs unknown) + monthly trend
    const g = el('div', 'mis-blgrid');
    const splitCard = el('div', 'mis-card mis-blcard');
    const segs = [
      { label: 'Same insurer (retained)', v: same, c: COLORS.okLog },
      { label: 'Different insurer (switched)', v: diff, c: COLORS.pend },
      { label: 'Unknown', v: unknown, c: '#B4BAC4' },
    ].filter(s => s.v > 0);
    const segTot = Math.max(1, same + diff + unknown);
    splitCard.innerHTML = `<div class="mis-charthd"><h3>Renewed — same vs different insurer</h3><span style="font-size:11px;color:#9AA3AF;">${fmtNum(renewed)} renewed</span></div>
      <div style="display:flex;height:26px;border-radius:6px;overflow:hidden;margin:6px 0 14px;background:#F0F2F5;">
        ${segs.map(s => `<div title="${s.label}: ${fmtNum(s.v)}" style="width:${(s.v / segTot * 100).toFixed(1)}%;background:${s.c};"></div>`).join('') || '<div style="flex:1;"></div>'}</div>
      <div class="bllist">${segs.map(s => `<div class="blrow"><span class="blk">${s.label}</span>
        <span class="blbar"><i style="width:${(s.v / segTot * 100).toFixed(1)}%;background:${s.c};"></i></span>
        <span class="blv">${fmtNum(s.v)}</span><span class="blsh">${(s.v / segTot * 100).toFixed(0)}%</span></div>`).join('') || '<div class="mis-empty" style="padding:24px;">No renewals in scope</div>'}</div>`;
    g.appendChild(splitCard);

    const maxM = Math.max(1, ...(rn.by_month || []).map(m => m.renewed));
    const trend = el('div', 'mis-card mis-blcard');
    trend.innerHTML = `<div class="mis-charthd"><h3>Renewals by month</h3><span style="font-size:11px;color:#9AA3AF;">same ▪ diff</span></div>
      <div class="bllist">${(rn.by_month || []).map(m => `<div class="blrow"><span class="blk">${escapeHtml(m.ym)}</span>
        <span class="blbar" style="background:#F0F2F5;"><i style="width:${Math.max(2, m.renewed / maxM * 100).toFixed(1)}%;background:linear-gradient(90deg,${COLORS.okLog} ${m.renewed ? (m.same / m.renewed * 100).toFixed(0) : 0}%,${COLORS.pend} ${m.renewed ? (m.same / m.renewed * 100).toFixed(0) : 0}%);"></i></span>
        <span class="blv">${fmtNum(m.renewed)}</span><span class="blsh">${m.diff}<small style="color:#B4BAC4"> sw</small></span></div>`).join('') || '<div class="mis-empty" style="padding:24px;">No renewals in range</div>'}</div>`;
    g.appendChild(trend);
    body.appendChild(g);

    // Which insurers customers switched FROM (different-insurer renewals)
    if ((rn.from_insurers || []).length) {
      const g2 = el('div', 'mis-blgrid');
      g2.appendChild(barListCard('Switched FROM (different-insurer renewals)', rn.from_insurers, { noToggle: true, metric: 'nop', limit: 14 }));
      body.appendChild(g2);
    }
  }

  // ======================================================================
  //  Data Required — items awaiting a data feed (#19)
  // ======================================================================
  function renderMore(body) {
    body.innerHTML = '';
    body.appendChild(el('div', 'mis-note', 'These components are designed and slotted in — they light up as soon as the underlying data is available. Each says exactly what it needs.'));
    const g = el('div', 'mis-blgrid');
    [
      ['#19 · Branch expenses & income multiplier', 'No branch expense/income (P&L) table exists. Need a branch-financials feed (monthly expense + income per branch).'],
    ].forEach(([t, m]) => g.appendChild(pendingCard(t, m)));
    body.appendChild(g);
  }

  // ---- entry ---------------------------------------------------------------
  window.misInit = function misInit() {
    injectStyles();
    if (!MIS.inited) { buildShell(); MIS.inited = true; }
    loadData(false);
  };
})();
