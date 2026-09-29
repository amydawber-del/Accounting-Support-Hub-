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
  {key:'optout', label:'Opted Out'}
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
  return routing.tone===activeFilter;
}

function teamNames(c){
  return [c.accountingOwner, c.onboardingSpecialist, c.csmStreet, c.csm, c.reconciliation && c.reconciliation.specialist, c.training && c.training.trainer, acct(c).bdm].filter(has);
}

const ADV_FILTER_DEFS = [
  { key:'person', label:'Team member', type:'people' },
  { key:'streetStatus', label:'Street Status', type:'dynamic', getValue:c=>c.streetStatus },
  { key:'internalStatusTag', label:'Accounting Status', type:'dynamic', getValue:c=>c.internalStatusTag },
  { key:'segment', label:'Segment', type:'dynamic', getValue:c=>c.segment },
  { key:'bankProvider', label:'Bank Provider', type:'dynamic', getValue:c=>acct(c).bankProvider },
  { key:'previousSoftware', label:'Previous Software', type:'dynamic', getValue:c=>previousSoftwareText(c) },
  { key:'migration', label:'Migration', type:'dynamic', getValue:c=>acct(c).migration },
  { key:'agentLiveWithStreet', label:'Live with Street', type:'boolean', getValue:c=>c.agentLiveWithStreet },
  { key:'agentLiveWithAccounting', label:'Live with Accounting', type:'boolean', getValue:c=>c.agentLiveWithAccounting },
  { key:'streetPaymentsClient', label:'Street Payments', type:'boolean', getValue:c=>c.streetPayments && c.streetPayments.customer },
  { key:'clientAccountingEnabled', label:'Client Accounting Enabled', type:'boolean', getValue:c=>c.clientAccountingEnabled },
];
let advFilters = {};

function renderAdvFilters(){
  const row = document.getElementById('advFilterRow');
  if(!row) return;
  row.innerHTML = '';

  ADV_FILTER_DEFS.forEach(def=>{
    const select = document.createElement('select');
    select.setAttribute('aria-label', def.label);
    const add = (value, text)=>{ const o = document.createElement('option'); o.value = value; o.textContent = text; select.appendChild(o); };
    add('', def.label + ': All');

    if(def.type === 'boolean'){
      add('yes', def.label + ': Yes');
      add('no', def.label + ': No');
    } else {
      const values = new Set();
      companies.forEach(c=>{
        if(def.type === 'people') teamNames(c).forEach(n=>values.add(n));
        else { const v = def.getValue(c); if(v) values.add(v); }
      });
      if(!values.size) return; // nothing synced for this field yet, so don't show an empty dropdown
      Array.from(values).sort().forEach(v=>add(v, v));
    }

    select.value = advFilters[def.key] || '';
    select.classList.toggle('active', !!select.value);
    select.onchange = ()=>{
      advFilters[def.key] = select.value;
      resetPaging();
      renderAdvFilters();
      renderResults();
    };
    row.appendChild(select);
  });

  if(Object.values(advFilters).some(v=>v)){
    const clearBtn = document.createElement('button');
    clearBtn.className = 'adv-filters-clear';
    clearBtn.textContent = 'Clear filters';
    clearBtn.onclick = ()=>{ advFilters = {}; resetPaging(); renderAdvFilters(); renderResults(); };
    row.appendChild(clearBtn);
  }
}

function matchesAdvFilters(c){
  return ADV_FILTER_DEFS.every(def=>{
    const selected = advFilters[def.key];
    if(!selected) return true;
    if(def.type === 'people') return teamNames(c).includes(selected);
    if(def.type === 'boolean'){
      const isYes = !!def.getValue(c);
      return selected === 'yes' ? isYes : !isYes;
    }
    return def.getValue(c) === selected;
  });
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
    list.innerHTML = `<div class="empty-state">No matching client found. Try a different name, Network ID or team member.</div>`;
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
    card.onclick = ()=>showDetail(c.companyId);
    card.onkeydown = e=>{ if(e.key==='Enter' || e.key===' '){ e.preventDefault(); showDetail(c.companyId); } };

    const sub = subLine(c);
    card.innerHTML = `
      <div class="result-top">
        <div class="result-title">
          <div class="result-name">${esc(c.companyName)}</div>
          ${sub ? `<div class="result-sub">${sub}</div>` : ''}
        </div>
        <div class="result-actions">
          ${c.redFlag ? `<span class="badge badge--flag">🚩 Additional support</span>` : ''}
          <span class="view-link">View client →</span>
        </div>
      </div>
      ${accountLine(c)}
      <div class="lanes lanes--compact">
        ${laneCompact('Street', street.label, street.tone, street.contact, street.empty)}
        ${laneCompact('Accounting', routing.label, routing.tone, accContact, routing.empty)}
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

function accountLine(c){
  const a = acct(c);
  const bits = [];
  const prev = previousSoftwareText(c);
  if(prev) bits.push(`<span><b>Previously:</b> ${esc(prev)}</span>`);
  if(has(a.migration)) bits.push(`<span><b>Migration:</b> ${esc(a.migration)}</span>`);
  if(has(a.bankProvider)) bits.push(`<span><b>Bank:</b> ${esc(a.bankProvider)}</span>`);
  return bits.length ? `<div class="account-line">${bits.join('')}</div>` : '';
}

function laneCompact(title, label, tone, contact, empty){
  return `<div class="lane-compact ${empty ? 'is-empty' : ''}">
      <div class="lane-head">
        <span class="lane-label">${title}</span>
        <span class="badge ${TONE_BADGE[tone]}">${esc(label)}</span>
      </div>
      ${empty ? '' : personHtml(contact)}
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
            <div class="person-name">${esc(p.name)} ${p.current ? '<span class="current-tag">Go-to contact</span>' : ''}</div>
            <div class="person-role">${p.roles.map(esc).join('<br>')}</div>
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
        <h3>Street</h3>
        ${row('Street Status', val(c.streetStatus))}
        ${row('Live with Street', yesNo(c.agentLiveWithStreet))}
        ${row('Street Go Live Date', val(fmtDate(c.streetGoLiveDate)))}
        ${row('Street Usage', val(c.streetUsage))}
        ${row('Street Network ID', val(c.networkId))}
        ${row('Segment / Business Size', val(c.segment))}
        ${row('Street Payments Client', yesNo(c.streetPayments && c.streetPayments.customer))}
        ${c.streetPayments && c.streetPayments.customer ? row('Street Payments Verification', val(c.streetPayments.verificationStatus)) : ''}
      </div>
      <div class="panel">
        <h3>Accounting</h3>
        ${row('Accounting Status', val(c.accountingStatus))}
        ${row('Internal Accounting Status', val(c.internalStatusTag))}
        ${row('Live with Accounting', yesNo(c.agentLiveWithAccounting))}
        ${row('Accounting Go Live Date', val(fmtDate(c.goLiveDate)))}
        ${c.onboardingProject && c.onboardingProject.targetGoLive ? row('Target Go Live Date', esc(fmtDate(c.onboardingProject.targetGoLive))) : ''}
        ${row('Client Accounting Enabled', yesNo(c.clientAccountingEnabled))}
        ${row('Accounting Restart', val(c.restart && c.restart.status))}
      </div>
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
