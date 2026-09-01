/* Street Accounting Support Hub — front-end logic.
   Data comes from data/support-clients.json, produced by scripts/sync-rocketlane.js
   running on a schedule via .github/workflows/sync-rocketlane.yml. This file never
   talks to Rocketlane directly and never sees an API key. */

const today = new Date();
let companies = [];
let lastGeneratedAt = null;
let syncDiagnostics = null;

async function loadData(){
  const resultsList = document.getElementById('resultsList');
  try {
    const res = await fetch('./data/support-clients.json', {cache:'no-store'});
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const payload = await res.json();
    companies = payload.companies || [];
    lastGeneratedAt = payload.generatedAt || null;
    syncDiagnostics = payload.syncDiagnostics || null;
    updateSyncTime();
    renderDiagnostics();
    renderChips();
    renderAdvFilters();
    renderResults();
  } catch(err){
    document.getElementById('syncTime').textContent = 'Last synced: unable to load data';
    resultsList.innerHTML = `<div class="empty-state">Unable to load Support Hub data.<br>
      Check that data/support-clients.json exists and that the last sync ran successfully.</div>`;
    console.error('Support Hub data load failed:', err);
  }
}

function updateSyncTime(){
  const el = document.getElementById('syncTime');
  if(!lastGeneratedAt){ el.textContent = 'Last synced: unknown'; return; }
  const d = new Date(lastGeneratedAt);
  el.textContent = 'Last synced: ' + d.toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'}) + ', ' + d.toLocaleTimeString('en-GB', {hour:'2-digit', minute:'2-digit'});
}

function refreshData(){
  document.getElementById('syncTime').textContent = 'Checking for latest data…';
  loadData();
}

/* Small counts strip under the sync pill so "how many pulled through" is
   answerable at a glance, without digging through GitHub Action logs.
   Created here rather than in index.html so older cached HTML still gets it
   automatically the next time app.js loads. */
function renderDiagnostics(){
  const syncPill = document.querySelector('.sync-pill');
  if(!syncPill) return;

  let el = document.getElementById('syncDiagnostics');
  if(!el){
    el = document.createElement('div');
    el.id = 'syncDiagnostics';
    el.style.cssText = 'font-size:11px; color:var(--text--dark--30); text-align:right; margin-top:2px; cursor:pointer;';
    syncPill.appendChild(el);
  }

  if(!syncDiagnostics){
    el.textContent = '';
    return;
  }

  const d = syncDiagnostics;
  const missing = d.companiesWithNoAccountingProjectFound;
  const unknownProjects = d.projectsByClassification ? d.projectsByClassification.unknown : 0;

  // Every company is included now (Accounting-only fields simply blank for
  // those with no Accounting relationship), so "X of Y synced" stopped being
  // a useful signal — the count that actually matters day-to-day is how many
  // have real Accounting data at all.
  el.innerHTML = `${d.companiesWrittenToSupportHub} companies · ${d.companiesFetchedFromRocketlane - missing} with Accounting data` +
    (unknownProjects ? ` · ${unknownProjects} project(s) unclassified` : '') +
    ' <span style="text-decoration:underline;">details</span>';

  el.onclick = () => {
    alert(
      'Support Hub sync diagnostics\n\n' +
      `Companies fetched from Rocketlane: ${d.companiesFetchedFromRocketlane}\n` +
      `Projects fetched from Rocketlane: ${d.projectsFetchedFromRocketlane}\n` +
      (d.projectsWithNoCompanyLink ? `Projects with no resolvable company link: ${d.projectsWithNoCompanyLink}\n` : '') +
      `\nProjects classified as:\n` +
      `  Onboarding: ${d.projectsByClassification.onboarding}\n` +
      `  Reconciliation: ${d.projectsByClassification.reconciliation}\n` +
      `  Training: ${d.projectsByClassification.training}\n` +
      `  Unknown (not synced): ${d.projectsByClassification.unknown}\n` +
      `\nCompanies written to this Hub: ${d.companiesWrittenToSupportHub}\n` +
      `Companies with no Accounting relationship (still included, Accounting fields blank): ${missing}\n\n` +
      'Full breakdown (including a sample of company names with no Accounting ' +
      'relationship) is in the GitHub Action run logs under Actions → Sync Rocketlane data.'
    );
  };
}


/* ---------------- (ACCOUNTING) 🏷️ Internal Status Tag mapping ---------------- */
/* Maps Rocketlane's "Internal Status Tag" choice field straight onto tone + guidance.
   This is the master status where the tag is set — the other computed rules (reconciliation
   object, restart object, red flag, day-count) still drive the detail panels and the CTA links,
   but the tag decides which banner/label/tone wins.
   NOTE: the two "Nuking and Accounting Reset" options were truncated in the field screenshot,
   so these match on the stable prefix rather than the full label — safe against the exact
   wording of "Option 1"/"Option 2" once you confirm it from Rocketlane. */
const STATUS_TAG_CONFIG = [
  { match:'Awaiting Intro Call', tone:'onboarding', badgeClass:'badge--onboarding',
    guidance:'Client has signed up for Accounting but hasn\u2019t had their intro call yet. Onboarding hasn\u2019t formally started — route any setup questions to the Onboarding Specialist rather than answering them directly.' },
  { match:'Training Phase', tone:'onboarding', badgeClass:'badge--onboarding',
    guidance:'Client is in Accounting product training. Direct workflow/setup questions back to their onboarding project rather than teaching baseline Accounting concepts over Live Chat.' },
  { match:'Awaiting Bridge Second Cut', tone:'onboarding', badgeClass:'badge--onboarding',
    guidance:'Client is waiting on their second data migration cut. Don\u2019t advise on data that may still change \u2014 route migration questions to the Onboarding Specialist.' },
  { match:'Awaiting OB Call Booking', tone:'onboarding', badgeClass:'badge--onboarding',
    guidance:'Client still needs their Opening Balance call booked. Direct Accounting setup, configuration and onboarding workflow questions back to their Accounting project board.' },
  { match:'Onboarding in Progress', tone:'onboarding', badgeClass:'badge--onboarding',
    guidance:'This client is currently going through Accounting Onboarding. Direct Accounting setup, configuration and onboarding workflow questions back to their Accounting project board.' },
  { match:'30 Days Post Go-Live Support', tone:'recent', badgeClass:'badge--recent', useDayCounter:true,
    guidance:'This client is still within their 30-day Accounting post-go-live support period. For onboarding-related workflow queries, direct them back to their Accounting project.' },
  { match:'Live / Archive', tone:'live', badgeClass:'badge--live',
    guidance:'This client is outside their Accounting onboarding support period. Support can assist with normal Street Accounting product/workflow queries.' },
  { match:'Opt-Out Confirmed / Archive', tone:'optout', badgeClass:'badge--optout',
    guidance:'This client is not proceeding with Street Accounting. No onboarding routing applies \u2014 refer only to the opt-out reason if the client raises it again.' },
  { match:'Churned / Archived', tone:'optout', badgeClass:'badge--optout',
    guidance:'This client has churned from Street Accounting. No onboarding routing applies \u2014 check internal notes before any Accounting discussion.' },
  { match:'Nuking and Accounting Reset / Option 1: Manual Reconciliation', tone:'restart', badgeClass:'badge--restart',
    guidance:'This client\u2019s Accounting setup is being reset (manual reconciliation route). Check their current onboarding or reconciliation status before giving advice based on historical Accounting data.' },
  { match:'Nuking and Accounting Reset / Option 2: Clear Accounting & Restart', tone:'restart', badgeClass:'badge--restart',
    guidance:'This client\u2019s Accounting setup is being reset (clear account route). Check their current onboarding or reconciliation status before giving advice based on historical Accounting data.' },
  { match:'Closed / None Responder', tone:'optout', badgeClass:'badge--optout',
    guidance:'Client has gone unresponsive during Accounting onboarding. No active routing applies \u2014 check internal notes before re-engaging.' },
  { match:'Slow Mover', tone:'slow', badgeClass:'badge--slow',
    guidance:'This client is live but using Accounting lightly. Support can handle normal product/workflow queries \u2014 flag to the Accounting Owner if the client would benefit from a refresher session.' },
  { match:'Client Accounting Reconciliation', tone:'recon', badgeClass:'badge--recon',
    guidance:'This client is currently working with the Accounting team on a reconciliation issue. Check the reconciliation summary before advising them to reverse, delete, void or alter historic Accounting transactions.' }
];

function lookupStatusTag(tag){
  if(!tag) return null;
  return STATUS_TAG_CONFIG.find(t => tag === t.match) || null;
}

/* ---------------- routing logic (Rules 1–7) ---------------- */
function daysBetween(a,b){ return Math.floor((b-a)/(1000*60*60*24)); }

function getRouting(c){
  // Internal Status Tag (Rocketlane field) is the master status where it's set.
  // Reconciliation/restart detail objects still supply the extra fields shown in the
  // panels below and the CTA link — the tag just decides which banner/label/tone wins.
  const tagConfig = lookupStatusTag(c.internalStatusTag);
  if(tagConfig){
    let detail = '';
    let dayNum;
    if(tagConfig.useDayCounter && c.goLiveDate){
      dayNum = daysBetween(new Date(c.goLiveDate), today);
      detail = `Day ${dayNum} of 30 · Went live ${fmtDate(c.goLiveDate)}`;
    } else if(c.reconciliation){
      detail = `Route: ${c.reconciliation.route} · Raised ${fmtDate(c.reconciliation.dateRaised)}`;
    } else if(c.restart){
      detail = `${c.restart.route} · Restarted ${fmtDate(c.restart.date)}`;
    } else if(c.onboardingProject){
      detail = `Target go-live: ${fmtDate(c.onboardingProject.targetGoLive)}`;
    } else if(c.goLiveDate){
      detail = `Went live ${fmtDate(c.goLiveDate)}`;
    } else if(c.optOut){
      detail = c.optOut.type;
    }
    let cta = null;
    if(tagConfig.tone==='recon') cta = 'Open Reconciliation Project';
    else if(tagConfig.tone==='restart' || tagConfig.tone==='onboarding' || tagConfig.tone==='recent') cta = 'Open Accounting Project';
    return {
      tone:tagConfig.tone, badgeClass:tagConfig.badgeClass, label:c.internalStatusTag,
      detail, guidance:tagConfig.guidance, cta, dayNum
    };
  }

  // Fallback: no Internal Status Tag recorded — derive from the raw fields instead.
  // Rule 4 — reconciliation overrides everything visually
  if(c.reconciliation){
    return {
      tone:'recon', badgeClass:'badge--recon', label:'Accounting Reconciliation Active',
      detail:`Route: ${c.reconciliation.route} · Raised ${fmtDate(c.reconciliation.dateRaised)}`,
      guidance:`This client is currently working with the Accounting team on a reconciliation issue. Check the reconciliation summary before advising them to reverse, delete, void or alter historic Accounting transactions. Escalate to ${c.reconciliation.specialist}.`,
      cta:'Open Reconciliation Project'
    };
  }
  // Rule 5 — restart/reset
  if(c.restart){
    return {
      tone:'restart', badgeClass:'badge--restart', label:'Accounting Restart / Reset',
      detail:`${c.restart.route} · Restarted ${fmtDate(c.restart.date)}`,
      guidance:`This client's Accounting setup has recently been restarted/reset. Check their current onboarding or reconciliation status before giving advice based on historical Accounting data.`,
      cta:'Open Accounting Project'
    };
  }
  // Rule 7 — opted out
  if(c.optOut){
    return {
      tone:'optout', badgeClass:'badge--optout', label:'Accounting Opted Out',
      detail:`${c.optOut.type}`,
      guidance:`This client is not proceeding with Street Accounting. No onboarding routing applies — refer only to the opt-out reason if the client raises it again.`,
      cta:null
    };
  }
  // Rule 1 — active onboarding
  if(!c.agentLiveWithAccounting && c.onboardingProject){
    return {
      tone:'onboarding', badgeClass:'badge--onboarding', label:'Accounting Onboarding',
      detail:`Target go-live: ${fmtDate(c.onboardingProject.targetGoLive)}`,
      guidance:`This client is currently going through Accounting Onboarding. Direct Accounting setup, configuration and onboarding workflow questions back to their Accounting project board.`,
      cta:'Open Accounting Project'
    };
  }
  // Rule 2 — recently live
  if(c.agentLiveWithAccounting && c.goLiveDate){
    const dayNum = daysBetween(new Date(c.goLiveDate), today);
    if(dayNum>=0 && dayNum<=30){
      return {
        tone:'recent', badgeClass:'badge--recent', label:'Post-Go-Live Support',
        detail:`Day ${dayNum} of 30 · Went live ${fmtDate(c.goLiveDate)}`,
        guidance:`This client is still within their 30-day Accounting post-go-live support period. For onboarding-related workflow queries, direct them back to their Accounting project.`,
        cta:'Open Accounting Project', dayNum
      };
    }
  }
  // Rule 3 — standard live
  if(c.agentLiveWithAccounting){
    return {
      tone:'live', badgeClass:'badge--live', label:'Live with Accounting',
      detail:c.goLiveDate ? `Went live ${fmtDate(c.goLiveDate)}` : '',
      guidance:`This client is outside their Accounting onboarding support period. Support can assist with normal Street Accounting product/workflow queries.`,
      cta:null
    };
  }
  return {tone:'optout', badgeClass:'badge--optout', label:'No Accounting Data', detail:'', guidance:'No Accounting record found for this client yet.', cta:null};
}

function fmtDate(d){
  if(!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', {day:'numeric', month:'short', year:'numeric'});
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
  {key:'training', label:'Training Required'},
  {key:'live', label:'Live Accounting'},
  {key:'optout', label:'Opted Out'}
];
let activeFilter = 'all';

function renderChips(){
  const row = document.getElementById('chipRow');
  row.innerHTML = '';
  filters.forEach(f=>{
    const el = document.createElement('button');
    el.className = 'chip' + (activeFilter===f.key ? ' active' : '');
    el.textContent = f.label;
    el.onclick = ()=>{ activeFilter = f.key; renderChips(); renderResults(); };
    row.appendChild(el);
  });
}

function matchesFilter(c, routing){
  if(activeFilter==='all') return true;
  if(activeFilter==='flag') return c.redFlag;
  if(activeFilter==='training') return !c.training.completed;
  return routing.tone===activeFilter || (activeFilter==='optout' && routing.tone==='optout');
}

/* ---------------- advanced filters (dropdowns under the search bar) ---------------- */
const ADV_FILTER_DEFS = [
  { key:'streetStatus', label:'Street Status', type:'dynamic', getValue:c=>c.streetStatus },
  { key:'segment', label:'Client Segment', type:'dynamic', getValue:c=>c.segment },
  { key:'agentLiveWithStreet', label:'Agent Live with Street', type:'boolean', getValue:c=>c.agentLiveWithStreet },
  { key:'internalStatusTag', label:'Internal Accounting Status', type:'dynamic', getValue:c=>c.internalStatusTag },
  { key:'agentLiveWithAccounting', label:'Agent Live with Accounting', type:'boolean', getValue:c=>c.agentLiveWithAccounting },
  { key:'streetPaymentsClient', label:'Street Payments Client', type:'boolean', getValue:c=>c.streetPayments && c.streetPayments.customer },
  { key:'clientAccountingEnabled', label:'Client Accounting Enabled', type:'boolean', getValue:c=>c.clientAccountingEnabled },
];
let advFilters = {}; // key -> '' (all) | 'yes' | 'no' | a literal dynamic value

function renderAdvFilters(){
  const row = document.getElementById('advFilterRow');
  if(!row) return;
  row.innerHTML = '';

  ADV_FILTER_DEFS.forEach(def=>{
    const select = document.createElement('select');

    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = def.label + ': All';
    select.appendChild(allOpt);

    if(def.type === 'boolean'){
      const yes = document.createElement('option'); yes.value = 'yes'; yes.textContent = def.label + ': Yes'; select.appendChild(yes);
      const no = document.createElement('option'); no.value = 'no'; no.textContent = def.label + ': No'; select.appendChild(no);
    } else {
      const values = new Set();
      companies.forEach(c=>{ const v = def.getValue(c); if(v) values.add(v); });
      Array.from(values).sort().forEach(v=>{
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v;
        select.appendChild(opt);
      });
    }

    select.value = advFilters[def.key] || '';
    select.classList.toggle('active', !!select.value);

    select.onchange = ()=>{
      advFilters[def.key] = select.value;
      select.classList.toggle('active', !!select.value);
      renderAdvFilters(); // to refresh the Clear filters link visibility
      renderResults();
    };

    row.appendChild(select);
  });

  const anyActive = Object.values(advFilters).some(v=>v);
  if(anyActive){
    const clearBtn = document.createElement('button');
    clearBtn.className = 'adv-filters-clear';
    clearBtn.textContent = 'Clear filters';
    clearBtn.onclick = ()=>{
      advFilters = {};
      renderAdvFilters();
      renderResults();
    };
    row.appendChild(clearBtn);
  }
}

function matchesAdvFilters(c){
  return ADV_FILTER_DEFS.every(def=>{
    const selected = advFilters[def.key];
    if(!selected) return true;
    if(def.type === 'boolean'){
      const isYes = !!def.getValue(c);
      return selected === 'yes' ? isYes : !isYes;
    }
    return def.getValue(c) === selected;
  });
}

/* ---------------- render: results list ---------------- */
function renderResults(){
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const list = document.getElementById('resultsList');
  list.innerHTML = '';

  const matches = companies.filter(c=>{
    const routing = getRouting(c);
    const searchOk = !q || c.companyName.toLowerCase().includes(q) || String(c.networkId || '').includes(q) || (c.accountingOwner || '').toLowerCase().includes(q);
    return searchOk && matchesFilter(c, routing) && matchesAdvFilters(c);
  });

  if(matches.length===0){
    list.innerHTML = `<div class="empty-state">No matching client found. Try a different name or Network ID.</div>`;
    return;
  }

  matches.forEach(c=>{
    const routing = getRouting(c);
    const card = document.createElement('div');
    card.className = 'result-card';
    card.onclick = ()=>showDetail(c.companyId);

    let badges = `<span class="badge ${routing.badgeClass}">${routing.label}</span>`;
    if(c.redFlag) badges += `<span class="badge badge--flag">🚩 Additional Support</span>`;
    if(c.segment) badges += `<span class="badge badge--segment">${c.segment}</span>`;

    card.innerHTML = `
      <div class="result-top">
        <div>
          <div class="result-name">${c.companyName}</div>
          <div class="result-sub">Network ID ${c.networkId ?? '—'} · ${c.branches ?? '—'} branch${c.branches>1?'es':''}</div>
        </div>
        <span class="view-link">View client →</span>
      </div>
      <div class="badge-row">${badges}</div>
      <div class="result-meta">
        <div class="meta-item"><div class="meta-label">Street Status</div><div class="meta-value">${c.streetStatus || '—'}</div></div>
        <div class="meta-item"><div class="meta-label">Accounting Status</div><div class="meta-value">${c.internalStatusTag || '—'}</div></div>
        <div class="meta-item"><div class="meta-label">Accounting Owner</div><div class="meta-value">${c.accountingOwner || '—'}</div></div>
        <div class="meta-item"><div class="meta-label">Network ID</div><div class="meta-value">${c.networkId ?? '—'}</div></div>
        <div class="meta-item"><div class="meta-label">Portfolio</div><div class="meta-value">${c.units ?? '—'} managed units</div></div>
      </div>
    `;
    list.appendChild(card);
  });
}

/* ---------------- render: detail view ---------------- */
function showDetail(id){
  const c = companies.find(x=>x.companyId===id);
  const routing = getRouting(c);
  const content = document.getElementById('detailContent');

  let progressBar = '';
  if(routing.dayNum!==undefined){
    const pct = Math.min(100, Math.round((routing.dayNum/30)*100));
    progressBar = `<div class="banner-progress"><div class="banner-progress-fill" style="width:${pct}%"></div></div>`;
  }

  const projectUrl = getRocketlaneProjectUrl(c, routing.tone);
  let ctaHtml = '';
  if(routing.cta && projectUrl){
    ctaHtml = `<a class="banner-cta" href="${projectUrl}" target="_blank" rel="noopener">${routing.cta} ↗</a>`;
  } else if(routing.cta){
    ctaHtml = `<span class="banner-cta" style="opacity:.6; cursor:default;" title="No Rocketlane link recorded for this project">${routing.cta} (link unavailable)</span>`;
  }

  let html = `
    <div class="detail-head">
      <div>
        <h2>${c.companyName}</h2>
        <div class="result-sub">Network ID ${c.networkId ?? '—'} · ${c.units ?? '—'} managed units · CSM ${c.csm || '—'}</div>
      </div>
    </div>

    ${c.redFlag ? `<div class="flag-strip">🚩 Additional support required — see notes below.</div>` : ''}

    <div class="status-banner tone-${routing.tone}">
      <div class="status-title">${routing.label}</div>
      ${routing.detail ? `<div class="status-detail">${routing.detail}</div>` : ''}
      ${progressBar}
      <div class="whattodo"><strong>What should you do?</strong>${routing.guidance}</div>
      ${ctaHtml}
    </div>

    <div class="panel-grid">
      <div class="panel">
        <h3>Client Overview</h3>
        <div class="field-row"><span class="field-label">Street Network ID</span><span class="field-value">${c.networkId ?? '—'}</span></div>
        <div class="field-row"><span class="field-label">Street Status</span><span class="field-value">${c.streetStatus || '—'}</span></div>
        <div class="field-row"><span class="field-label">Client Segment / Business Size</span><span class="field-value">${c.segment || '—'}</span></div>
        <div class="field-row"><span class="field-label">Customer Success Manager (Street)</span><span class="field-value">${c.csmStreet || '—'}</span></div>
        <div class="field-row"><span class="field-label">Onboarding Specialist</span><span class="field-value">${c.onboardingSpecialist || '—'}</span></div>
      </div>
      <div class="panel">
        <h3>Street Onboarding &amp; Adoption</h3>
        <div class="field-row"><span class="field-label">Agent Live with Street</span><span class="field-value">${c.agentLiveWithStreet ? 'Yes' : 'No'}</span></div>
        <div class="field-row"><span class="field-label">Street Go Live Date</span><span class="field-value">${fmtDate(c.streetGoLiveDate)}</span></div>
        <div class="field-row"><span class="field-label">Street Usage</span><span class="field-value">${c.streetUsage || '—'}</span></div>
      </div>
      <div class="panel">
        <h3>Accounting Overview</h3>
        <div class="field-row"><span class="field-label">Accounting Owner</span><span class="field-value">${c.accountingOwner || '—'}</span></div>
        <div class="field-row"><span class="field-label">Accounting Status</span><span class="field-value">${c.accountingStatus || '—'}</span></div>
        <div class="field-row"><span class="field-label">Internal Accounting Status</span><span class="field-value">${c.internalStatusTag || '—'}</span></div>
        <div class="field-row"><span class="field-label">Agent Live with Accounting</span><span class="field-value">${c.agentLiveWithAccounting ? 'Yes' : 'No'}</span></div>
        <div class="field-row"><span class="field-label">Accounting Go Live Date</span><span class="field-value">${fmtDate(c.goLiveDate)}</span></div>
        <div class="field-row"><span class="field-label">Client Accounting Enabled</span><span class="field-value">${c.clientAccountingEnabled ? 'Yes' : 'No'}</span></div>
      </div>
      <div class="panel">
        <h3>Street Payments</h3>
        <div class="field-row"><span class="field-label">Street Payments Client</span><span class="field-value">${c.streetPayments && c.streetPayments.customer ? 'Yes' : 'No'}</span></div>
        <div class="field-row"><span class="field-label">Verification Status</span><span class="field-value">${(c.streetPayments && c.streetPayments.verificationStatus) || '—'}</span></div>
      </div>
  `;

  if(c.reconciliation){
    html += `
      <div class="panel">
        <h3>Accounting Reconciliation</h3>
        <div class="field-row"><span class="field-label">Status</span><span class="field-value">${c.reconciliation.status}</span></div>
        <div class="field-row"><span class="field-label">Route</span><span class="field-value">${c.reconciliation.route}</span></div>
        <div class="field-row"><span class="field-label">Owner</span><span class="field-value">${c.reconciliation.specialist || '—'}</span></div>
        <div class="field-row"><span class="field-label">Date Raised</span><span class="field-value">${fmtDate(c.reconciliation.dateRaised)}</span></div>
        <div class="field-row"><span class="field-label">Review Call</span><span class="field-value">${c.reconciliation.reviewCallBooked}</span></div>
        <div class="field-row"><span class="field-label">Current Difference</span><span class="field-value">${c.reconciliation.currentDifference}</span></div>
        <div class="field-row"><span class="field-label">Outcome</span><span class="field-value">${c.reconciliation.outcome}</span></div>
        ${c.reconciliation.notes ? `
        <div class="field-row" style="display:block; border-bottom:none;">
          <span class="field-label" style="display:block; margin-bottom:4px;">Notes</span>
          <span class="field-value" style="display:block; text-align:left; font-weight:400;">${c.reconciliation.notes}</span>
        </div>` : ''}
      </div>`;
  }
  if(c.restart){
    html += `
      <div class="panel">
        <h3>Accounting Restart</h3>
        <div class="field-row"><span class="field-label">Status</span><span class="field-value">${c.restart.status}</span></div>
        <div class="field-row"><span class="field-label">Route</span><span class="field-value">${c.restart.route}</span></div>
        <div class="field-row"><span class="field-label">Reason</span><span class="field-value">${c.restart.reason}</span></div>
        <div class="field-row"><span class="field-label">Restart Date</span><span class="field-value">${fmtDate(c.restart.date)}</span></div>
      </div>`;
  }
  if(c.optOut){
    html += `
      <div class="panel">
        <h3>Opt-Out</h3>
        <div class="field-row"><span class="field-label">Type</span><span class="field-value">${c.optOut.type}</span></div>
      </div>`;
  }

  html += `
      <div class="panel">
        <h3>Product Training</h3>
        <div class="field-row"><span class="field-label">Last Assigned Trainer</span><span class="field-value">${c.training.trainer || '—'}</span></div>
        <div class="field-row"><span class="field-label">Product Training Status</span><span class="field-value">${c.training.status}</span></div>
        <div class="field-row"><span class="field-label">Last Product Training Date</span><span class="field-value">${fmtDate(c.training.lastDate)}</span></div>
        <div class="field-row"><span class="field-label">Product Training Completed</span><span class="field-value">${c.training.completed ? 'Yes' : 'No'}</span></div>
        <div class="field-row"><span class="field-label">Training Modules Completed</span><span class="field-value">${c.training.modules || '—'}</span></div>
        <div class="field-row"><span class="field-label">Training Formats Used</span><span class="field-value">${c.training.formats || '—'}</span></div>
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
      </div>
    `;
  }

  html += `
    <div class="notes-section">
  `;

  const noteEntries = [
    ['Notes', c.internalNotes.general],
    ['Accounting Restart Notes', c.restart ? c.restart.notes : ''],
    ['Opt-Out Reason', c.optOut ? c.optOut.reason : '']
  ].filter(([,val])=>val);

  if(noteEntries.length){
    noteEntries.forEach(([label,val])=>{
      html += `<details class="note"><summary>${label}</summary><div class="note-body">${val}</div></details>`;
    });
  } else {
    html += `<div class="result-sub">No internal notes recorded.</div>`;
  }

  html += `</div>`;

  content.innerHTML = html;
  document.getElementById('lookup-view').style.display = 'none';
  document.getElementById('detail-view').style.display = 'block';
  window.scrollTo(0,0);
}

function showLookup(){
  document.getElementById('detail-view').style.display = 'none';
  document.getElementById('lookup-view').style.display = 'block';
}


/* Rocketlane doesn't publish a documented customer-facing project URL format, and the
   spec is explicit that we must never fabricate one. Once you confirm the real pattern
   (open any project in Rocketlane and copy its URL structure), fill it in here -- the
   sync script can then attach the right link per project type in rocketlaneLinks. Until
   then this returns null and the UI shows "(link unavailable)" instead of a dead link. */
function getRocketlaneProjectUrl(company, tone){
  if(!company.rocketlaneLinks) return null;
  if(tone === 'recon') return company.rocketlaneLinks.reconciliationProject || null;
  if(tone === 'restart' || tone === 'onboarding' || tone === 'recent') return company.rocketlaneLinks.accountingProject || null;
  return null;
}

loadData();
