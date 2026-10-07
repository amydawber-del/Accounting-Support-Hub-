/* Street Accounting Support Hub: front-end logic.
   Data comes from data/support-clients.json, produced by scripts/sync-rocketlane.js
   running on a schedule via .github/workflows/sync-rocketlane.yml. This file never
   talks to Rocketlane directly and never sees an API key. */

const today = new Date();
let companies = [];
let lastGeneratedAt = null;
let syncDiagnostics = null;
let currentDetailId = null;

const PAGE_SIZE = 50;
let visibleCount = PAGE_SIZE;
const AUTO_REFRESH_MS = 10 * 60 * 1000; // re-check for new data every 10 minutes while the page is open
const STALE_AFTER_HOURS = 2;            // show an amber warning if the last sync is older than this

/* ---------------- helpers ---------------- */
function esc(v){
  return String(v ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function has(v){ return v !== null && v !== undefined && v !== '' && v !== 'null'; }
function val(v, fallback='Not recorded'){ return has(v) ? esc(v) : `<span class="muted">${fallback}</span>`; }
function yesNo(b){ return b ? 'Yes' : 'No'; }
function initials(name){
  return String(name||'').split(/\s+/).filter(Boolean).slice(0,2).map(p=>p[0].toUpperCase()).join('');
}
function fmtDate(d){
  if(!d) return null;
  return new Date(d).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
}
function daysBetween(a,b){ return Math.floor((b-a)/(1000*60*60*24)); }
function timeAgo(date){
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return `${mins} min${mins===1?'':'s'} ago`;
  const hrs = Math.floor(mins/60);
  if(hrs < 24) return `${hrs} hour${hrs===1?'':'s'} ago`;
  const days = Math.floor(hrs/24);
  return `${days} day${days===1?'':'s'} ago`;
}
function acct(c){ return c.account || {}; }
function fmtMoney(v){
  if(!has(v)) return null;
  const n = Number(String(v).replace(/[£,\s]/g,''));
  return Number.isFinite(n) && String(v).trim() !== '' ? '£' + n.toLocaleString('en-GB', {maximumFractionDigits:0}) : String(v);
}
/* Previous CRM / Accounting software may come from one combined field or two separate ones. */
function previousSoftwareText(c){
  const a = acct(c);
  const parts = [a.previousSoftware, a.previousCrm, a.previousAccountingSoftware].filter(has);
  return parts.length ? Array.from(new Set(parts)).join(', ') : null;
}
/* Spectre details come from the Account record. Field types weren't confirmed when
   this was built, so values may be Yes/No, a dropdown label or free text. */
function spec(c){ return c.spectre || {}; }
function isYesValue(v){ return has(v) && /^(yes|true|y)$/i.test(String(v).trim()); }
function isNoValue(v){ return has(v) && /^(no|false|n)$/i.test(String(v).trim()); }
function isSpectreClient(c){ return isYesValue(spec(c).spectreClient); }
function spectrePill(v){
  if(!has(v)) return val(null);
  if(isYesValue(v)) return `<span class="live-pill live-pill--sm is-live">Yes</span>`;
  if(isNoValue(v)) return `<span class="live-pill live-pill--sm is-not-live">No</span>`;
  return `<span class="badge badge--segment">${esc(v)}</span>`;
}
/* Only ever links to a real URL that's stored in Rocketlane. Never builds one. */
function hubspotHtml(v){
  if(!has(v)) return val(null);
  const s = String(v).trim();
  if(/^https?:\/\/\S+$/i.test(s)) return `<a class="ext-link" href="${esc(s)}" target="_blank" rel="noopener">Open in HubSpot ↗</a>`;
  return esc(s);
}
function hasRealRestart(c){
  return !!(c.restart && c.restart.status && c.restart.status !== 'Never Restarted');
}

/* ---------------- data loading + auto refresh ---------------- */
async function loadData({silent=false} = {}){
  const resultsList = document.getElementById('resultsList');
  try {
    // Cache-buster: GitHub Pages' CDN can otherwise serve a copy up to 10 minutes old.
    const res = await fetch('./data/support-clients.json?t=' + Date.now(), {cache:'no-store'});
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    const changed = payload.generatedAt !== lastGeneratedAt;
    companies = (payload.companies || []).slice().sort((a,b)=>(a.companyName||'').localeCompare(b.companyName||'', 'en-GB'));
    lastGeneratedAt = payload.generatedAt || null;
    syncDiagnostics = payload.syncDiagnostics || null;
    updateSyncTime();
    if(silent && !changed) return;

    renderChips();
    renderAdvFilters();
    if(currentDetailId !== null){
      // Keep the person on the client they were looking at, just with fresher data.
      if(companies.some(c=>c.companyId===currentDetailId)) showDetail(currentDetailId, {keepScroll:true});
    }
    renderResults();
  } catch(err){
    if(silent) return; // don't wipe the screen if a background check fails
    document.getElementById('syncTime').textContent = 'Unable to load data';
    document.getElementById('syncStatus').className = 'sync-status is-stale';
    resultsList.innerHTML = `<div class="empty-state">Unable to load Support Hub data.<br>
      Check that data/support-clients.json exists and that the last sync ran successfully.</div>`;
    console.error('Support Hub data load failed:', err);
  }
}

function updateSyncTime(){
  const el = document.getElementById('syncTime');
  const wrap = document.getElementById('syncStatus');
  if(!lastGeneratedAt){ el.textContent = 'Last synced: unknown'; wrap.className = 'sync-status is-stale'; return; }
  const d = new Date(lastGeneratedAt);
  const stamp = d.toLocaleDateString('en-GB', {day:'numeric', month:'short'}) + ', ' + d.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
  const hoursOld = (Date.now() - d.getTime()) / 36e5;
  const stale = hoursOld > STALE_AFTER_HOURS;
  wrap.className = 'sync-status ' + (stale ? 'is-stale' : 'is-fresh');
  el.textContent = `Updated ${timeAgo(d)} (${stamp})` + (stale ? ' · may be out of date' : '');
  wrap.title = syncDiagnosticsText();
}

function syncDiagnosticsText(){
  const d = syncDiagnostics;
  if(!d) return 'Syncs from Rocketlane automatically, roughly every 30 to 60 minutes.';
  const withAccounting = d.companiesFetchedFromRocketlane - d.companiesWithNoAccountingProjectFound;
  return `Syncs from Rocketlane automatically, roughly every 30 to 60 minutes.\n` +
    `${d.companiesWrittenToSupportHub} companies synced, ${withAccounting} with Accounting data.`;
}

function refreshData(){
  document.getElementById('syncTime').textContent = 'Checking for latest data…';
  loadData();
}

setInterval(()=>loadData({silent:true}), AUTO_REFRESH_MS);
setInterval(updateSyncTime, 60 * 1000); // keep "Updated X mins ago" ticking
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden) loadData({silent:true}); });


/* ---------------- (ACCOUNTING) 🏷️ Internal Status Tag mapping ---------------- */
/* Maps Rocketlane's "Internal Status Tag" choice field straight onto tone + guidance.
   The tag is the master Accounting status where it's set. */
const STATUS_TAG_CONFIG = [
  { match:'Awaiting Intro Call', tone:'onboarding',
    guidance:'Client has signed up for Accounting but hasn’t had their intro call yet. Route any setup questions to their Accounting Owner rather than answering them directly.' },
  { match:'Training Phase', tone:'onboarding',
    guidance:'Client is in Accounting product training. Direct workflow and setup questions back to their onboarding project rather than teaching baseline Accounting concepts over Live Chat.' },
  { match:'Awaiting Bridge Second Cut', tone:'onboarding',
    guidance:'Client is waiting on their second data migration cut. Don’t advise on data that may still change. Route migration questions to their Accounting Owner.' },
  { match:'Awaiting OB Call Booking', tone:'onboarding',
    guidance:'Client still needs their Opening Balance call booked. Direct Accounting setup, configuration and onboarding questions back to their Accounting project board.' },
  { match:'Onboarding in Progress', tone:'onboarding',
    guidance:'Client is going through Accounting onboarding. Direct Accounting setup, configuration and onboarding questions back to their Accounting project board.' },
  { match:'30 Days Post Go-Live Support', tone:'recent', useDayCounter:true,
    guidance:'Client is still within their 30-day post-go-live support period. For onboarding-related workflow queries, direct them back to their Accounting project.' },
  { match:'Live / Archive', tone:'live',
    guidance:'Client is outside their Accounting onboarding support period. Support can help with normal Street Accounting product and workflow queries.' },
  { match:'Opt-Out Confirmed / Archive', tone:'optout',
    guidance:'Client is not proceeding with Street Accounting. No onboarding routing applies. Only refer to the opt-out reason if the client raises it again.' },
  { match:'Churned / Archived', tone:'optout',
    guidance:'Client has churned from Street Accounting. No onboarding routing applies. Check internal notes before any Accounting discussion.' },
  { match:'Nuking and Accounting Reset / Option 1: Manual Reconciliation', tone:'restart',
    guidance:'Client’s Accounting setup is being reset (manual reconciliation route). Check their current status before giving advice based on historical Accounting data.' },
  { match:'Nuking and Accounting Reset / Option 2: Clear Accounting & Restart', tone:'restart',
    guidance:'Client’s Accounting setup is being reset (clear account route). Check their current status before giving advice based on historical Accounting data.' },
  { match:'Closed / None Responder', tone:'optout',
    guidance:'Client went unresponsive during Accounting onboarding. No active routing applies. Check internal notes before re-engaging.' },
  { match:'Slow Mover', tone:'slow',
    guidance:'Client is live but using Accounting lightly. Support can handle normal queries. Flag to the Accounting Owner if a refresher session would help.' },
  { match:'Client Accounting Reconciliation', tone:'recon',
    guidance:'Client is working with the Accounting team on a reconciliation issue. Check the reconciliation details below before advising them to reverse, delete, void or alter historic transactions.' }
];

const TONE_BADGE = {
  live:'badge--live', onboarding:'badge--onboarding', recent:'badge--recent', recon:'badge--recon',
  restart:'badge--restart', optout:'badge--optout', slow:'badge--slow', neutral:'badge--segment', none:'badge--none'
};

function lookupStatusTag(tag){
  if(!tag) return null;
  return STATUS_TAG_CONFIG.find(t => tag === t.match) || null;
}

/* ---------------- Accounting routing (Rules 1–7) ---------------- */
function getRouting(c){
  const tagConfig = lookupStatusTag(c.internalStatusTag);
  if(tagConfig){
    let detail = '';
    let dayNum;
    if(tagConfig.useDayCounter && c.goLiveDate){
      dayNum = daysBetween(new Date(c.goLiveDate), today);
      detail = `Day ${dayNum} of 30 · Went live ${fmtDate(c.goLiveDate)}`;
    } else if(tagConfig.tone==='recon' && c.reconciliation){
      detail = [c.reconciliation.route && `Route: ${c.reconciliation.route}`, c.reconciliation.dateRaised && `Raised ${fmtDate(c.reconciliation.dateRaised)}`].filter(Boolean).join(' · ');
    } else if(hasRealRestart(c)){
      detail = [c.restart.route, c.restart.date && `Restarted ${fmtDate(c.restart.date)}`].filter(Boolean).join(' · ');
    } else if(c.onboardingProject && c.onboardingProject.targetGoLive){
      detail = `Target go-live: ${fmtDate(c.onboardingProject.targetGoLive)}`;
    } else if(c.goLiveDate){
      detail = `Went live ${fmtDate(c.goLiveDate)}`;
    }
    let cta = null;
    if(tagConfig.tone==='recon') cta = 'Open Reconciliation Project';
    else if(['restart','onboarding','recent'].includes(tagConfig.tone)) cta = 'Open Accounting Project';
    return { tone:tagConfig.tone, label:c.internalStatusTag, detail, guidance:tagConfig.guidance, cta, dayNum };
  }

  // Fallback: no Internal Status Tag recorded, so derive from the raw fields instead.
  if(c.reconciliation && c.reconciliation.status !== 'Closed'){
    return {
      tone:'recon', label:'Accounting Reconciliation Active',
      detail:[c.reconciliation.route && `Route: ${c.reconciliation.route}`, c.reconciliation.dateRaised && `Raised ${fmtDate(c.reconciliation.dateRaised)}`].filter(Boolean).join(' · '),
      guidance:'Client is working with the Accounting team on a reconciliation issue. Check the reconciliation details below before advising them to reverse, delete, void or alter historic transactions.',
      cta:'Open Reconciliation Project'
    };
  }
  if(hasRealRestart(c) && c.restart.status !== 'Restart Completed'){
    return {
      tone:'restart', label:'Accounting Restart / Reset',
      detail:[c.restart.route, c.restart.date && `Restarted ${fmtDate(c.restart.date)}`].filter(Boolean).join(' · '),
      guidance:'Client’s Accounting setup has recently been restarted or reset. Check their current status before giving advice based on historical Accounting data.',
      cta:'Open Accounting Project'
    };
  }
  if(c.optOut){
    return {
      tone:'optout', label:'Accounting Opted Out', detail:c.optOut.type,
      guidance:'Client is not proceeding with Street Accounting. No onboarding routing applies. Only refer to the opt-out reason if the client raises it again.',
      cta:null
    };
  }
  if(!c.agentLiveWithAccounting && c.onboardingProject){
    return {
      tone:'onboarding', label:'Accounting Onboarding',
      detail:c.onboardingProject.targetGoLive ? `Target go-live: ${fmtDate(c.onboardingProject.targetGoLive)}` : '',
      guidance:'Client is going through Accounting onboarding. Direct Accounting setup, configuration and onboarding questions back to their Accounting project board.',
      cta:'Open Accounting Project'
    };
  }
  if(c.agentLiveWithAccounting && c.goLiveDate){
    const dayNum = daysBetween(new Date(c.goLiveDate), today);
    if(dayNum>=0 && dayNum<=30){
      return {
        tone:'recent', label:'Post-Go-Live Support',
        detail:`Day ${dayNum} of 30 · Went live ${fmtDate(c.goLiveDate)}`,
        guidance:'Client is still within their 30-day post-go-live support period. For onboarding-related workflow queries, direct them back to their Accounting project.',
        cta:'Open Accounting Project', dayNum
      };
    }
  }
  if(c.agentLiveWithAccounting || c.accountingStatus === 'Live'){
    return {
      tone:'live', label:'Live with Accounting',
      detail:c.goLiveDate ? `Went live ${fmtDate(c.goLiveDate)}` : '',
      guidance:'Client is outside their Accounting onboarding support period. Support can help with normal Street Accounting product and workflow queries.',
      cta:null
    };
  }
  if(c.accountingStatus){
    return { tone:'neutral', label:`Accounting: ${c.accountingStatus}`, detail:'', guidance:'', cta:null };
  }
  return { tone:'none', label:'No Accounting record', detail:'', guidance:'', cta:null, empty:true };
}

/* ---------------- "who's dealing with it" ---------------- */
/* These rules decide which ONE person shows as the go-to contact in each lane.
   Everyone else involved still appears in the Client team section on the detail page. */
function getAccountingContact(c, routing){
  if(routing.tone==='recon' && c.reconciliation && c.reconciliation.specialist){
    return { name:c.reconciliation.specialist, role:'Reconciliation Specialist' };
  }
  if(c.accountingOwner) return { name:c.accountingOwner, role:'Accounting Owner' };
  if(c.csm) return { name:c.csm, role:'Customer Success Manager (Accounting)' };
  return null;
}

function getStreetLane(c){
  const status = c.streetStatus;
  const onboarding = status === 'Onboarding' || (!status && !c.agentLiveWithStreet && c.onboardingSpecialist);
  let tone = 'neutral';
  if(status === 'Active') tone = 'live';
  else if(status === 'Onboarding') tone = 'onboarding';
  else if(status === 'Test Account') tone = 'optout';

  let contact = null;
  if(onboarding && c.onboardingSpecialist) contact = { name:c.onboardingSpecialist, role:'Onboarding Specialist' };
  else if(c.csmStreet) contact = { name:c.csmStreet, role:'Customer Success Manager' };
  else if(c.onboardingSpecialist) contact = { name:c.onboardingSpecialist, role:'Onboarding Specialist' };

  let guidance = '';
  if(status === 'Onboarding') guidance = 'Still onboarding with Street. Send setup and go-live questions to their Onboarding Specialist.';
  else if(status === 'Active') guidance = 'Live with Street. Support can help with day-to-day product questions. Account or commercial queries go to their Customer Success Manager.';
  else if(status === 'Test Account') guidance = 'This is a test account, not a live client.';

  const detail = c.streetGoLiveDate ? `Went live ${fmtDate(c.streetGoLiveDate)}` : '';
  const empty = !status && !contact;
  return { tone: empty ? 'none' : tone, label: status || (empty ? 'No Street status' : 'Status not recorded'), contact, guidance, detail, empty };
}

function getClientTeam(c, streetContact, accountingContact){
  const roles = [
    [c.onboardingSpecialist, 'Onboarding Specialist', 'Street'],
    [c.csmStreet, 'Customer Success Manager', 'Street'],
    [c.accountingOwner, 'Accounting Owner', 'Accounting'],
    [c.csm, 'Customer Success Manager', 'Accounting'],
    [c.reconciliation && c.reconciliation.specialist, 'Reconciliation Specialist', 'Accounting'],
    [c.training && c.training.trainer, 'Last Trainer', 'Training'],
    [acct(c).bdm, 'Business Development Manager', 'Sales'],
    [spec(c).csmSpectre, 'Customer Success Manager', 'Spectre'],
  ];
  const byName = new Map();
  roles.forEach(([name, role, area])=>{
    if(!has(name)) return;
    if(!byName.has(name)) byName.set(name, { name, roles:[] });
    byName.get(name).roles.push(`${role} (${area})`);
  });
  const current = new Set([streetContact && streetContact.name, accountingContact && accountingContact.name].filter(Boolean));
  return Array.from(byName.values()).map(p=>({ ...p, current:current.has(p.name) }))
    .sort((a,b)=>Number(b.current)-Number(a.current));
}

/* ---------------- filters ---------------- */
const filters = [
  {key:'all', label:'All'},
  {key:'onboarding', label:'Accounting Onboarding'},
  {key:'recent', label:'Recently Live'},
  {key:'recon', label:'Reconciliation'},
  {key:'restart', label:'Restarted'},
  {key:'flag', label:'Red Flag'},
  {key:'slow', label:'Slow Mover'},
  {key:'streetOnboarding', label:'Street Onboarding'},
  {key:'live', label:'Live Accounting'},
  {key:'optout', label:'Opted Out'},
  {key:'spectre', label:'Spectre Clients'}
];
let activeFilter = 'all';

function resetPaging(){ visibleCount = PAGE_SIZE; }

function renderChips(){
  const row = document.getElementById('chipRow');
  row.innerHTML = '';
  filters.forEach(f=>{
    const el = document.createElement('button');
    el.className = 'chip' + (activeFilter===f.key ? ' active' : '');
    el.textContent = f.label;
    el.onclick = ()=>{ activeFilter = f.key; resetPaging(); renderChips(); renderResults(); };
    row.appendChild(el);
  });
}

function matchesFilter(c, routing){
  if(activeFilter==='all') return true;
  if(activeFilter==='flag') return c.redFlag;
  if(activeFilter==='streetOnboarding') return c.streetStatus === 'Onboarding';
  if(activeFilter==='spectre') return isSpectreClient(c);
  return routing.tone===activeFilter;
}

function teamNames(c){
  return [c.accountingOwner, c.onboardingSpecialist, c.csmStreet, c.csm, c.reconciliation && c.reconciliation.specialist, c.training && c.training.trainer, acct(c).bdm, spec(c).csmSpectre].filter(has);
}

/* ---------------- filters for every field on the client card ----------------
   Each def: key, group, label, type, getValue(c).
   Types: 'dynamic' (dropdown of values found in the data, plus "Not recorded"),
          'boolean' (Yes / No), 'bands' (fixed ranges), 'presence' (Recorded / Not recorded),
          'people' (anyone on the client team). */
const NONE = '__none__';
const UNIT_BANDS = ['1 to 99','100 to 249','250 to 499','500 to 999','1,000+'];
const BRANCH_BANDS = ['1 branch','2 to 5 branches','6+ branches'];
function unitBand(u){
  if(!has(u)) return null; const n = Number(u); if(!Number.isFinite(n) || n <= 0) return null;
  return n < 100 ? UNIT_BANDS[0] : n < 250 ? UNIT_BANDS[1] : n < 500 ? UNIT_BANDS[2] : n < 1000 ? UNIT_BANDS[3] : UNIT_BANDS[4];
}
function branchBand(b){
  if(!has(b)) return null; const n = Number(b); if(!Number.isFinite(n) || n <= 0) return null;
  return n === 1 ? BRANCH_BANDS[0] : n <= 5 ? BRANCH_BANDS[1] : BRANCH_BANDS[2];
}

const ADV_FILTER_DEFS = [
  // Street
  { key:'streetStatus', group:'Street', label:'Street Status', type:'dynamic', getValue:c=>c.streetStatus },
  { key:'streetContact', group:'Street', label:'Street go-to contact', type:'dynamic', getValue:c=>{ const s = getStreetLane(c); return s.contact ? s.contact.name : null; } },
  { key:'agentLiveWithStreet', group:'Street', label:'Live with Street', type:'boolean', getValue:c=>c.agentLiveWithStreet },
  { key:'segment', group:'Street', label:'Segment', type:'dynamic', getValue:c=>c.segment },
  { key:'units', group:'Street', label:'Managed units', type:'bands', options:UNIT_BANDS, getValue:c=>unitBand(c.units) },
  { key:'branches', group:'Street', label:'Branches', type:'bands', options:BRANCH_BANDS, getValue:c=>branchBand(c.branches) },
  { key:'networkId', group:'Street', label:'Network ID', type:'presence', getValue:c=>has(c.networkId) },
  // Accounting
  { key:'accountingStatus', group:'Accounting', label:'Accounting Status', type:'dynamic', noNone:true, getValue:c=>getRouting(c).label },
  { key:'accountingContact', group:'Accounting', label:'Accounting go-to contact', type:'dynamic', getValue:c=>{ const r = getRouting(c); if(r.empty) return null; const a = getAccountingContact(c, r); return a ? a.name : null; } },
  { key:'agentLiveWithAccounting', group:'Accounting', label:'Live with Accounting', type:'boolean', getValue:c=>c.agentLiveWithAccounting },
  { key:'clientAccountingEnabled', group:'Accounting', label:'Client Accounting Enabled', type:'boolean', getValue:c=>c.clientAccountingEnabled },
  { key:'streetPaymentsClient', group:'Accounting', label:'Street Payments', type:'boolean', getValue:c=>c.streetPayments && c.streetPayments.customer },
  { key:'redFlag', group:'Accounting', label:'Red flag (additional support)', type:'boolean', getValue:c=>c.redFlag },
  // Spectre
  { key:'spectreClient', group:'Spectre', label:'Spectre Client', type:'boolean', getValue:c=>isSpectreClient(c) },
  { key:'csmSpectre', group:'Spectre', label:'Customer Success Manager (Spectre)', type:'dynamic', getValue:c=>spec(c).csmSpectre },
  { key:'spectreSales', group:'Spectre', label:'Spectre Sales', type:'dynamic', getValue:c=>spec(c).sales },
  { key:'spectreLettings', group:'Spectre', label:'Spectre Lettings', type:'dynamic', getValue:c=>spec(c).lettings },
  { key:'spectreSocial', group:'Spectre', label:'Spectre Social', type:'dynamic', getValue:c=>spec(c).social },
  { key:'spectreEmail', group:'Spectre', label:'Spectre Email', type:'dynamic', getValue:c=>spec(c).email },
  { key:'spectrePropertyReports', group:'Spectre', label:'Spectre Property Reports', type:'dynamic', getValue:c=>spec(c).propertyReports },
  // Account & team
  { key:'person', group:'Account & team', label:'Anyone on the client team', type:'people' },
  { key:'previousSoftware', group:'Account & team', label:'Previous software', type:'dynamic', getValue:c=>previousSoftwareText(c) },
  { key:'migration', group:'Account & team', label:'Migration', type:'dynamic', getValue:c=>acct(c).migration },
  { key:'bankProvider', group:'Account & team', label:'Bank Provider', type:'dynamic', getValue:c=>acct(c).bankProvider },
];
const FILTER_GROUPS = ['Street', 'Accounting', 'Spectre', 'Account & team'];
let advFilters = {};
let filterPanelOpen = (()=>{ try { return localStorage.getItem('supportHubFiltersOpen') === '1'; } catch(e){ return false; } })();

function filterDef(key){ return ADV_FILTER_DEFS.find(d=>d.key===key); }

function optionText(def, value){
  if(value === NONE) return 'Not recorded';
  if(def.type === 'boolean') return value === 'yes' ? 'Yes' : 'No';
  if(def.type === 'presence') return value === 'yes' ? 'Recorded' : 'Not recorded';
  return value;
}

function setFilter(key, value){
  advFilters[key] = value || '';
  resetPaging();
  renderAdvFilters();
  renderResults();
}

function renderAdvFilters(){
  const row = document.getElementById('advFilterRow');
  if(!row) return;
  row.innerHTML = '';

  const activeKeys = Object.keys(advFilters).filter(k=>advFilters[k]);

  // ---- top bar: toggle, active filter pills, clear ----
  const bar = document.createElement('div');
  bar.className = 'filter-bar';
  const toggle = document.createElement('button');
  toggle.className = 'filter-toggle' + (filterPanelOpen ? ' is-open' : '');
  toggle.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="4" y1="6" x2="20" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="10" y1="18" x2="14" y2="18"/></svg>
    ${filterPanelOpen ? 'Hide filters' : 'More filters'}${activeKeys.length ? ` <span class="filter-count">${activeKeys.length}</span>` : ''}`;
  toggle.onclick = ()=>{
    filterPanelOpen = !filterPanelOpen;
    try { localStorage.setItem('supportHubFiltersOpen', filterPanelOpen ? '1' : '0'); } catch(e){}
    renderAdvFilters();
  };
  bar.appendChild(toggle);

  activeKeys.forEach(k=>{
    const def = filterDef(k); if(!def) return;
    const pill = document.createElement('button');
    pill.className = 'active-filter';
    pill.title = 'Remove this filter';
    pill.innerHTML = `<span class="active-filter-label">${esc(def.label)}:</span> ${esc(optionText(def, advFilters[k]))} <span class="active-filter-x" aria-hidden="true">×</span>`;
    pill.onclick = ()=>setFilter(k, '');
    bar.appendChild(pill);
  });

  if(activeKeys.length){
    const clearBtn = document.createElement('button');
    clearBtn.className = 'adv-filters-clear';
    clearBtn.textContent = 'Clear all';
    clearBtn.onclick = ()=>{ advFilters = {}; resetPaging(); renderAdvFilters(); renderResults(); };
    bar.appendChild(clearBtn);
  } else {
    const hint = document.createElement('span');
    hint.className = 'filter-hint';
    hint.textContent = 'Tip: click any status, person or detail on a client card to filter by it.';
    bar.appendChild(hint);
  }
  row.appendChild(bar);

  if(!filterPanelOpen) return;

  // ---- expanded panel, grouped ----
  const panel = document.createElement('div');
  panel.className = 'filter-panel';
  FILTER_GROUPS.forEach(group=>{
    const groupEl = document.createElement('div');
    groupEl.className = 'filter-group';
    groupEl.innerHTML = `<div class="filter-group-title">${esc(group)}</div>`;
    const fields = document.createElement('div');
    fields.className = 'filter-fields';

    ADV_FILTER_DEFS.filter(d=>d.group===group).forEach(def=>{
      const select = document.createElement('select');
      const add = (value, text)=>{ const o = document.createElement('option'); o.value = value; o.textContent = text; select.appendChild(o); };
      add('', 'All');

      if(def.type === 'boolean'){ add('yes','Yes'); add('no','No'); }
      else if(def.type === 'presence'){ add('yes','Recorded'); add(NONE,'Not recorded'); }
      else {
        let values;
        if(def.type === 'bands') values = def.options;
        else {
          const set = new Set();
          companies.forEach(c=>{
            if(def.type === 'people') teamNames(c).forEach(n=>set.add(n));
            else { const v = def.getValue(c); if(has(v)) set.add(v); }
          });
          values = Array.from(set).sort((a,b)=>String(a).localeCompare(String(b),'en-GB'));
        }
        if(!values.length && def.type !== 'bands') return; // nothing synced for this field yet
        values.forEach(v=>add(v, v));
        if(!def.noNone) add(NONE, 'Not recorded');
      }

      select.value = advFilters[def.key] || '';
      select.classList.toggle('active', !!select.value);
      select.onchange = ()=>setFilter(def.key, select.value);

      const wrap = document.createElement('label');
      wrap.className = 'filter-field';
      wrap.innerHTML = `<span>${esc(def.label)}</span>`;
      wrap.appendChild(select);
      fields.appendChild(wrap);
    });

    groupEl.appendChild(fields);
    panel.appendChild(groupEl);
  });
  row.appendChild(panel);
}

function matchesAdvFilters(c){
  return ADV_FILTER_DEFS.every(def=>{
    const selected = advFilters[def.key];
    if(!selected) return true;
    if(def.type === 'people'){
      const names = teamNames(c);
      return selected === NONE ? names.length === 0 : names.includes(selected);
    }
    const v = def.getValue(c);
    if(def.type === 'boolean') return selected === 'yes' ? !!v : !v;
    if(def.type === 'presence') return selected === 'yes' ? !!v : !v;
    if(selected === NONE) return !has(v);
    return v === selected;
  });
}

/* A clickable value on a client card: clicking it applies that filter instead of opening the client. */
function fv(key, value, html, extraClass=''){
  if(!has(value)) return html;
  return `<button type="button" class="fv ${extraClass}" data-fk="${esc(key)}" data-fv="${esc(value)}" title="Filter by this">${html}</button>`;
}

/* ---------------- shared bits of markup ---------------- */
function personHtml(contact, emptyText='No one assigned'){
  if(!contact) return `<div class="person person--empty"><span class="avatar avatar--empty">?</span><div><div class="person-name muted">${emptyText}</div></div></div>`;
  return `<div class="person">
      <span class="avatar">${esc(initials(contact.name))}</span>
      <div><div class="person-name">${esc(contact.name)}</div><div class="person-role">${esc(contact.role)}</div></div>
    </div>`;
}

function subLine(c){
  const bits = [];
  if(c.segment) bits.push(esc(c.segment));
  if(has(c.units)) bits.push(`${Number(c.units).toLocaleString('en-GB')} managed units`);
  if(has(c.branches)) bits.push(`${c.branches} branch${c.branches>1?'es':''}`);
  if(has(c.networkId)) bits.push(`Network ID ${esc(c.networkId)}`);
  return bits.join(' · ');
}

/* ---------------- render: results list ---------------- */
function renderResults(){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const list = document.getElementById('resultsList');
  const countEl = document.getElementById('resultsCount');
  const moreWrap = document.getElementById('showMoreWrap');
  list.innerHTML = '';
  moreWrap.innerHTML = '';

  const matches = companies.filter(c=>{
    const routing = getRouting(c);
    const searchOk = !q ||
      (c.companyName||'').toLowerCase().includes(q) ||
      String(c.networkId ?? '').includes(q) ||
      teamNames(c).some(n=>n.toLowerCase().includes(q));
    return searchOk && matchesFilter(c, routing) && matchesAdvFilters(c);
  });

  countEl.textContent = matches.length
    ? `${matches.length.toLocaleString('en-GB')} client${matches.length===1?'':'s'}` + (matches.length > visibleCount ? `, showing the first ${visibleCount}` : '')
    : '';

  if(matches.length===0){
    list.innerHTML = `<div class="empty-state">No matching client found. Try a different search, or remove a filter or two.</div>`;
    return;
  }

  matches.slice(0, visibleCount).forEach(c=>{
    const routing = getRouting(c);
    const street = getStreetLane(c);
    const accContact = getAccountingContact(c, routing);
    const card = document.createElement('div');
    card.className = 'result-card';
    card.tabIndex = 0;
    card.setAttribute('role','button');
    card.onclick = e=>{
      const f = e.target.closest('.fv');
      if(f){ setFilter(f.dataset.fk, f.dataset.fv); return; }
      showDetail(c.companyId);
    };
    card.onkeydown = e=>{ if(e.target !== card) return; if(e.key==='Enter' || e.key===' '){ e.preventDefault(); showDetail(c.companyId); } };

    const sub = cardSubLine(c);
    card.innerHTML = `
      <div class="result-top">
        <div class="result-title">
          <div class="result-name">${esc(c.companyName)}</div>
          ${sub ? `<div class="result-sub">${sub}</div>` : ''}
        </div>
        <div class="result-actions">
          ${c.redFlag ? fv('redFlag', 'yes', `<span class="badge badge--flag">🚩 Additional support</span>`) : ''}
          ${isSpectreClient(c) ? fv('spectreClient', 'yes', `<span class="badge badge--spectre">Spectre client</span>`) : ''}
          <span class="view-link">View client →</span>
        </div>
      </div>
      ${accountLine(c)}
      <div class="lanes lanes--compact">
        ${laneCompact('Street', street.label, street.tone, street.contact, street.empty, 'streetStatus', c.streetStatus, 'streetContact')}
        ${laneCompact('Accounting', routing.label, routing.tone, accContact, routing.empty, 'accountingStatus', routing.label, 'accountingContact')}
      </div>
    `;
    list.appendChild(card);
  });

  if(matches.length > visibleCount){
    const btn = document.createElement('button');
    btn.className = 'show-more';
    btn.textContent = `Show more (${(matches.length - visibleCount).toLocaleString('en-GB')} left)`;
    btn.onclick = ()=>{ visibleCount += PAGE_SIZE; renderResults(); };
    moreWrap.appendChild(btn);
  }
}

function cardSubLine(c){
  const bits = [];
  if(c.segment) bits.push(fv('segment', c.segment, esc(c.segment)));
  if(has(c.units)) bits.push(fv('units', unitBand(c.units), `${Number(c.units).toLocaleString('en-GB')} managed units`));
  if(has(c.branches)) bits.push(fv('branches', branchBand(c.branches), `${c.branches} branch${c.branches>1?'es':''}`));
  if(has(c.networkId)) bits.push(fv('networkId', 'yes', `Network ID ${esc(c.networkId)}`));
  return bits.join(' · ');
}

function accountLine(c){
  const a = acct(c);
  const bits = [];
  const prev = previousSoftwareText(c);
  if(prev) bits.push(`<span><b>Previously:</b> ${fv('previousSoftware', prev, esc(prev))}</span>`);
  if(has(a.migration)) bits.push(`<span><b>Migration:</b> ${fv('migration', a.migration, esc(a.migration))}</span>`);
  if(has(a.bankProvider)) bits.push(`<span><b>Bank:</b> ${fv('bankProvider', a.bankProvider, esc(a.bankProvider))}</span>`);
  return bits.length ? `<div class="account-line">${bits.join('')}</div>` : '';
}

function laneCompact(title, label, tone, contact, empty, statusKey, statusValue, contactKey){
  const pill = `<span class="badge ${TONE_BADGE[tone]}">${esc(label)}</span>`;
  const statusHtml = has(statusValue) ? fv(statusKey, statusValue, pill) : fv(statusKey, NONE, pill);
  const personBlock = empty ? '' : (contact ? fv(contactKey, contact.name, personHtml(contact), 'fv--block') : fv(contactKey, NONE, personHtml(null), 'fv--block'));
  return `<div class="lane-compact ${empty ? 'is-empty' : ''}">
      <div class="lane-head">
        <span class="lane-label">${title}</span>
        ${statusHtml}
      </div>
      ${personBlock}
    </div>`;
}

/* ---------------- render: detail view ---------------- */
function showDetail(id, {keepScroll=false} = {}){
  const c = companies.find(x=>x.companyId===id);
  if(!c) return;
  currentDetailId = id;
  const routing = getRouting(c);
  const street = getStreetLane(c);
  const accContact = getAccountingContact(c, routing);
  const team = getClientTeam(c, street.contact, routing.empty ? null : accContact);
  const content = document.getElementById('detailContent');

  let progressBar = '';
  if(routing.dayNum!==undefined){
    const pct = Math.max(0, Math.min(100, Math.round((routing.dayNum/30)*100)));
    progressBar = `<div class="banner-progress"><div class="banner-progress-fill" style="width:${pct}%"></div></div>`;
  }

  const projectUrl = getRocketlaneProjectUrl(c, routing.tone);
  const ctaHtml = (routing.cta && projectUrl)
    ? `<a class="banner-cta" href="${esc(projectUrl)}" target="_blank" rel="noopener">${routing.cta} ↗</a>` : '';

  const sub = subLine(c);

  let html = `
    <div class="detail-head">
      <div>
        <h2>${esc(c.companyName)}</h2>
        ${sub ? `<div class="result-sub">${sub}</div>` : ''}
      </div>
    </div>

    ${c.redFlag ? `<div class="flag-strip">🚩 Additional support required. Check the notes below before responding.</div>` : ''}

    <h3 class="section-title">Where they are and who to speak to</h3>
    <div class="lanes lanes--detail">
      <div class="lane-card tone-${street.tone}">
        <div class="lane-card-top">
          <span class="lane-label">Street</span>
          <div class="lane-status">${esc(street.label)}</div>
          ${street.detail ? `<div class="lane-detail">${esc(street.detail)}</div>` : ''}
        </div>
        <div class="lane-contact">
          <div class="lane-contact-label">Go-to contact</div>
          ${personHtml(street.contact)}
        </div>
        ${street.guidance ? `<div class="whattodo"><strong>What should you do?</strong>${esc(street.guidance)}</div>` : ''}
      </div>

      <div class="lane-card tone-${routing.tone}">
        <div class="lane-card-top">
          <span class="lane-label">Accounting</span>
          <div class="lane-status">${esc(routing.label)}</div>
          ${routing.detail ? `<div class="lane-detail">${esc(routing.detail)}</div>` : ''}
          ${progressBar}
        </div>
        ${routing.empty ? `<div class="whattodo">No Accounting record found for this client. Treat any Accounting questions as a new enquiry.</div>` : `
        <div class="lane-contact">
          <div class="lane-contact-label">Go-to contact</div>
          ${personHtml(accContact)}
        </div>
        ${routing.guidance ? `<div class="whattodo"><strong>What should you do?</strong>${esc(routing.guidance)}</div>` : ''}
        ${ctaHtml}`}
      </div>
    </div>

    <h3 class="section-title">Client team</h3>
    ${team.length ? `<div class="team-grid">
      ${team.map(p=>`
        <div class="team-card ${p.current ? 'is-current' : ''}">
          <span class="avatar">${esc(initials(p.name))}</span>
          <div class="team-text">
            <div class="person-name">${esc(p.name)}</div>
            <div class="person-role">${p.roles.map(esc).join('<br>')}</div>
            ${p.current ? '<span class="current-tag">Go-to contact</span>' : ''}
          </div>
        </div>`).join('')}
    </div>` : `<div class="empty-inline">No team members recorded in Rocketlane for this client.</div>`}

    <h3 class="section-title">Full details</h3>
    <div class="panel-grid">
      <div class="panel panel--account">
        <h3>Account details</h3>
        ${row('Business Development Manager (Sales)', val(acct(c).bdm))}
        ${row('Approximate MRR', val(fmtMoney(acct(c).approxMrr)))}
        ${has(acct(c).previousSoftware) || (!has(acct(c).previousCrm) && !has(acct(c).previousAccountingSoftware))
            ? row('Previous CRM / Accounting Software', val(acct(c).previousSoftware)) : ''}
        ${has(acct(c).previousCrm) ? row('Previous CRM', esc(acct(c).previousCrm)) : ''}
        ${has(acct(c).previousAccountingSoftware) ? row('Previous Accounting Software', esc(acct(c).previousAccountingSoftware)) : ''}
        ${row('Migration', has(acct(c).migration)
            ? esc(acct(c).migration) + (acct(c).migrationSource === 'project' ? ' <span class="muted">(from project Customer Type)</span>' : '')
            : val(null))}
        ${row('Bank Provider', val(acct(c).bankProvider))}
      </div>
      <div class="panel">
        ${panelHead('Street', c.agentLiveWithStreet, 'Live with Street')}
        <div class="key-facts">
          ${row('Street Status', statusPill(c.streetStatus, street.tone))}
          ${row('Live with Street', livePill(c.agentLiveWithStreet))}
          ${row('Street Go Live Date', val(fmtDate(c.streetGoLiveDate)))}
        </div>
        ${row('Street Network ID', val(c.networkId))}
        ${row('Street Usage', val(c.streetUsage))}
        ${row('Segment / Business Size', val(c.segment))}
      </div>
      <div class="panel">
        ${panelHead('Accounting', c.agentLiveWithAccounting, 'Live with Accounting')}
        <div class="key-facts">
          ${row('Accounting Status', statusPill(c.accountingStatus, accountingStatusTone(c.accountingStatus)))}
          ${row('Live with Accounting', livePill(c.agentLiveWithAccounting))}
          ${row('Accounting Go Live Date', val(fmtDate(c.goLiveDate)))}
          ${c.onboardingProject && c.onboardingProject.targetGoLive ? row('Target Go Live Date', esc(fmtDate(c.onboardingProject.targetGoLive))) : ''}
        </div>
        ${row('Internal Accounting Status', val(c.internalStatusTag))}
        ${row('Client Accounting Enabled', yesNo(c.clientAccountingEnabled))}
        ${row('Street Payments Client', yesNo(c.streetPayments && c.streetPayments.customer))}
        ${c.streetPayments && c.streetPayments.customer ? row('Street Payments Verification', val(c.streetPayments.verificationStatus)) : ''}
        ${row('Accounting Restart', val(c.restart && c.restart.status))}
      </div>
      ${spectrePanel(c)}
  `;

  if(c.reconciliation){
    const r = c.reconciliation;
    html += `
      <div class="panel">
        <h3>Reconciliation</h3>
        ${row('Status', val(r.status))}
        ${row('Route', val(r.route))}
        ${row('Specialist', val(r.specialist))}
        ${row('Date Raised', val(fmtDate(r.dateRaised)))}
        ${row('Review Call', val(r.reviewCallBooked))}
        ${row('Current Difference', val(r.currentDifference))}
        ${row('Outcome', val(r.outcome))}
      </div>`;
  }
  if(hasRealRestart(c)){
    html += `
      <div class="panel">
        <h3>Accounting Restart</h3>
        ${row('Status', val(c.restart.status))}
        ${row('Route', val(c.restart.route))}
        ${row('Reason', val(c.restart.reason))}
        ${row('Restart Date', val(fmtDate(c.restart.date)))}
      </div>`;
  }
  if(c.optOut){
    html += `
      <div class="panel">
        <h3>Opt-Out</h3>
        ${row('Type', val(c.optOut.type))}
      </div>`;
  }

  const t = c.training || {};
  html += `
      <div class="panel">
        <h3>Product Training</h3>
        ${row('Training Status', val(t.status === 'Not recorded' ? null : t.status))}
        ${row('Last Trainer', val(t.trainer))}
        ${row('Last Training Date', val(fmtDate(t.lastDate)))}
        ${row('Training Completed', yesNo(t.completed))}
        ${row('Modules Covered', val(t.modules))}
        ${row('Training Formats', val(t.formats))}
      </div>
    </div>
  `;

  if(c.recentMessages && c.recentMessages.length){
    html += `
      <div class="conversation-section">
        <h3 class="conversation-title">Recent client conversation</h3>
        ${c.recentMessages.map(m => `
          <div class="conversation-message">
            <div class="conversation-message-date">${m.createdAt ? fmtDate(m.createdAt) : ''}</div>
            <div class="conversation-message-body">${m.content || '(no content)'}</div>
          </div>
        `).join('')}
      </div>`;
  }

  if(c.recentEngagementNotes && c.recentEngagementNotes.length){
    html += `
      <div class="conversation-section">
        <h3 class="conversation-title">Recent engagements</h3>
        ${c.recentEngagementNotes.map(n => `
          <div class="conversation-message">
            <div class="conversation-message-date">${n.createdAt ? fmtDate(n.createdAt) : ''}${n.title ? ' · ' + esc(n.title) : ''}</div>
            <div class="conversation-message-body">${n.text || '(no content)'}</div>
          </div>
        `).join('')}
      </div>`;
  }

  const noteEntries = [
    ['Notes', c.internalNotes && c.internalNotes.general],
    ['Reconciliation Notes', c.reconciliation ? c.reconciliation.notes : ''],
    ['Opt-Out Reason', c.optOut ? c.optOut.reason : '']
  ].filter(([,v])=>has(v));

  html += `<h3 class="section-title">Internal notes</h3><div class="notes-section">`;
  if(noteEntries.length){
    noteEntries.forEach(([label,v])=>{
      html += `<details class="note" open><summary>${label}</summary><div class="note-body">${v}</div></details>`;
    });
  } else {
    html += `<div class="empty-inline">No internal notes recorded.</div>`;
  }
  html += `</div>`;

  content.innerHTML = html;
  document.getElementById('lookup-view').style.display = 'none';
  document.getElementById('detail-view').style.display = 'block';
  if(!keepScroll) window.scrollTo(0,0);
}

/* Spectre tile: everything from the Account record's Spectre fields. */
function spectrePanel(c){
  const s = spec(c);
  const client = s.spectreClient;
  const headPill = isYesValue(client)
    ? `<span class="live-pill is-live">✓ Spectre client</span>`
    : isNoValue(client)
      ? `<span class="live-pill is-not-live">Not a Spectre client</span>`
      : `<span class="live-pill is-not-live">Not recorded</span>`;
  return `
      <div class="panel panel--spectre">
        <div class="panel-head"><h3>Spectre</h3>${headPill}</div>
        <div class="key-facts">
          ${row('Spectre Client', spectrePill(client))}
          ${row('Customer Success Manager (Spectre)', val(s.csmSpectre))}
        </div>
        ${row('Spectre products (summary)', val(s.productsSummary))}
        ${row('Spectre Sales', spectrePill(s.sales))}
        ${row('Spectre Lettings', spectrePill(s.lettings))}
        ${row('Spectre Social', spectrePill(s.social))}
        ${row('Spectre Email', spectrePill(s.email))}
        ${row('Spectre Property Reports', spectrePill(s.propertyReports))}
        ${row('HubSpot record (Spectre Deal)', hubspotHtml(s.hubspotDeal))}
      </div>`;
}

/* Panel title with a "Live" / "Not live yet" pill so it's visible at a glance. */
function panelHead(title, isLive, liveText){
  return `<div class="panel-head">
      <h3>${title}</h3>
      <span class="live-pill ${isLive ? 'is-live' : 'is-not-live'}">${isLive ? '✓ ' + liveText : 'Not live yet'}</span>
    </div>`;
}
function livePill(isLive){
  return `<span class="live-pill live-pill--sm ${isLive ? 'is-live' : 'is-not-live'}">${isLive ? 'Yes' : 'No'}</span>`;
}
function statusPill(text, tone){
  return has(text) ? `<span class="badge ${TONE_BADGE[tone] || 'badge--segment'}">${esc(text)}</span>` : val(null);
}
function accountingStatusTone(s){
  if(s === 'Live') return 'live';
  if(s === 'Onboarding') return 'onboarding';
  return 'neutral';
}

function row(label, valueHtml){
  return `<div class="field-row"><span class="field-label">${label}</span><span class="field-value">${valueHtml}</span></div>`;
}

function showLookup(){
  currentDetailId = null;
  document.getElementById('detail-view').style.display = 'none';
  document.getElementById('lookup-view').style.display = 'block';
}


/* Rocketlane doesn't publish a documented project URL format, and we must never
   fabricate one. Once the real pattern is confirmed, the sync script can fill in
   rocketlaneLinks and the "Open ... Project" button appears automatically. Until then
   the button is simply hidden rather than showing a dead "(link unavailable)" button. */
function getRocketlaneProjectUrl(company, tone){
  if(!company.rocketlaneLinks) return null;
  if(tone === 'recon') return company.rocketlaneLinks.reconciliationProject || null;
  if(tone === 'restart' || tone === 'onboarding' || tone === 'recent') return company.rocketlaneLinks.accountingProject || null;
  return null;
}

loadData();
