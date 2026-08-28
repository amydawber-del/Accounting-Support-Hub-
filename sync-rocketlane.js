#!/usr/bin/env node
/**
 * Street Accounting Support Hub — Rocketlane sync
 * ---------------------------------------------------------------------------
 * Rocketlane --> this script (GitHub Action) --> data/support-clients.json --> Support Hub
 *
 * Run with: ROCKETLANE_API_KEY=xxx node scripts/sync-rocketlane.js
 * (In CI this env var comes from the ROCKETLANE_API_KEY repository secret.)
 *
 * VERIFIED AGAINST LIVE DATA on 28 Aug 2026 (see README "What we confirmed" section):
 *   - The rich per-client fields (Internal Status Tag, Red Flag, Agent Live with
 *     Accounting, Portfolio Size, etc.) live on the PROJECT object, not the Company
 *     object. Company custom fields were empty for every company sampled. So this
 *     script treats the Accounting Onboarding project as the primary source of truth
 *     and the Company record as just the name/ID to search and group by.
 *   - "(ACCOUNTING) 🏷️ Internal Status Tags" (fieldId 2017988 in Amy's tenant) is
 *     ONE OF THREE fields whose label contains the phrase "Internal Status Tag" —
 *     there's also a Training-project one and an unrelated Street network-settings
 *     one. Never match on a substring; always match the full trimmed label below.
 *   - Field IDs are NOT hardcoded here (per the "discover dynamically" requirement) —
 *     they're looked up by label at sync time from GET /fields, and trimmed, since
 *     several real labels carry stray trailing whitespace or emoji.
 * ---------------------------------------------------------------------------
 */

const API_BASE = 'https://api.rocketlane.com/api/1.0';
const API_KEY = process.env.ROCKETLANE_API_KEY;

if (!API_KEY) {
  console.error('ROCKETLANE_API_KEY is not set. Aborting — never proceed without it, and never log its value.');
  process.exit(1);
}

// UNVERIFIED: /conversations and /messages don't appear anywhere in Rocketlane's
// public documented REST API (developer.rocketlane.com/reference lists Companies,
// Projects, Fields, Tasks, Phases, Users, Time Entries, Budgets, Spaces — no
// Conversations/Messages section). An MCP tool in Claude reaches this data, but
// there was no way to confirm from this build session whether a plain api-key
// REST call can reach the same thing, or whether it's internal to that connector.
// This is wired up on the assumption the endpoints below are real and match the
// documented URL conventions — if the first Action run logs 404s for these calls,
// that confirms this route isn't available this way, and this feature should come
// out (or be revisited via whatever access Rocketlane support actually recommends).
// Every call below is wrapped so a failure here can never take down the rest of the sync.
const INCLUDE_CLIENT_CONVERSATION = true;
const MAX_CONVERSATION_MESSAGES = 5;

// The exact field labels this sync depends on. Keys are our internal names;
// values must match Rocketlane's fieldLabel exactly (after trimming). If Amy
// renames a field in Rocketlane, update the value here — nothing else needs to change.
//
// Split by object type because that's where Rocketlane actually stores each one —
// confirmed empirically, not assumed: real clients (e.g. "Move Revolution") DO have
// populated Company-level custom fields. An earlier pass here wrongly concluded
// Company fields were unused tenant-wide, based on sampling a few companies that
// turned out to be test/demo accounts with nothing filled in — worth remembering
// before trusting a "field X is empty everywhere" finding off a small sample again.
const PROJECT_FIELD_LABELS = {
  internalStatusTag: '(ACCOUNTING) 🏷️ Internal Status Tags',
  redFlag: '🚩 Red Flag (Accounting)',
  agentLiveWithAccounting: 'Agent Live with Accounting',
  portfolioSize: 'Portfolio Size (Managed Units-PUM)',
  accountingGoLiveDateActual: 'Accounting Go-Live Date (Actual)',
  accountingGoLiveDateTarget: 'Accounting Go-Live Date (Target)',
  openingBalanceCallBooked: 'Opening Balance Organiser',
  clientAccountingEnabled: 'Client Accounting Enabled',
  accountsTrainingCompleted: 'Accounts Training Completed?',
  segment: 'Client Segment or Business Size', // confirmed as a PROJECT field (2621952)
  csmAccounting: 'Customer Success Manager (Accounting)',
  // Reconciliation-project fields
  reconciliationStatus: 'Reconciliation Status',
  reconciliationRoute: 'Reconciliation Route',
  reconciliationDateRaised: 'Date Raised',
  reconciliationReviewCallBooked: 'Review Call Booked',
  reconciliationSpecialist: 'Accounting Specialist',
  reconciliationOutcome: 'Reconciliation Outcome',
  reconciliationCurrentDifference: 'Current Difference (£)',
  // Restart fields (account-group in the original spec; verify location once you
  // can see a real restarted client's project — these are the labels the spec named)
  restartStatus: 'Accounting Restart Status',
  restartRoute: 'Accounting Restart Route',
  restartReason: 'Accounting Restart Reason',
  restartDate: 'Last Accounting Restart Date',
  // Training-project fields
  trainingCompleted: 'Training Completed',
  trainingDate: 'Training Date',
  trainingModules: 'Modules Covered',
  trainingFormat: 'Training Format',
  assignedTrainer: 'Assigned Trainer',
  // Notes (NOTE fields)
  accountingNote: 'Street Client Accounting Note',
  reconciliationNotes: 'Client Accounting Reconciliation Notes',
  onboardingNotes: 'Onboarding Notes',
};

// Company/Account-level fields — per the original spec's "ACCOUNT GROUP: OVERVIEW"
// grouping, and confirmed (unlike the earlier wrong assumption above) that real
// clients do carry data here. Labels below are unverified against a real fieldId —
// the MCP tool connected to this chat refused objectType=COMPANY lookups (only
// PROJECT/TASK/USER allowed), even though Rocketlane's real REST API supports it.
// Check the first run's "Missing field mapping" warnings against this list.
const COMPANY_FIELD_LABELS = {
  streetStatus: 'Street Status',
  networkId: 'Street Network ID',
  branches: 'Number of branches',
  csmStreet: 'Customer Success Manager (Street)',
};

// ---------------------------------------------------------------------------
// Low-level fetch helpers
// ---------------------------------------------------------------------------

async function rocketlaneGet(path, params = {}) {
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { 'api-key': API_KEY, accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Rocketlane ${path} failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`);
  }
  return res.json();
}

/** Fetches every page of a paginated endpoint and concatenates the `data` arrays. */
async function fetchAllPages(path, baseParams = {}) {
  const all = [];
  let pageToken;
  do {
    const page = await rocketlaneGet(path, { ...baseParams, pageSize: 100, pageToken });
    all.push(...(page.data || []));
    pageToken = page.pagination?.nextPageToken;
  } while (pageToken);
  return all;
}

// ---------------------------------------------------------------------------
// Fields: build a label -> field definition index, dynamically, every run
// ---------------------------------------------------------------------------

async function buildFieldIndex(objectType) {
  const fields = await fetchAllPages('/fields', { 'objectType.eq': objectType, includeFields: 'options' });
  const byLabel = new Map();
  for (const f of fields) {
    const label = (f.fieldLabel || '').trim();
    if (byLabel.has(label)) {
      console.warn(`[sync] WARNING: duplicate field label "${label}" for ${objectType} (fieldIds ${byLabel.get(label).fieldId} and ${f.fieldId}) — later one wins. Check PROJECT_FIELD_LABELS/COMPANY_FIELD_LABELS doesn't rely on this label.`);
    }
    byLabel.set(label, f);
  }
  return byLabel;
}

/** Resolves a PROJECT_FIELD_LABELS or COMPANY_FIELD_LABELS config against a live field index, warning about anything missing. */
function resolveFieldIds(fieldIndex, labelConfig) {
  const resolved = {};
  const missing = [];
  for (const [key, label] of Object.entries(labelConfig)) {
    const def = fieldIndex.get(label.trim());
    if (def) resolved[key] = def;
    else missing.push(`${key} ("${label}")`);
  }
  if (missing.length) {
    console.warn('[sync] Missing field mapping(s) — these will show as "Not recorded" in the Hub:\n  ' + missing.join('\n  '));
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Generic custom-field value readers (handle null/undefined/disabled fields gracefully)
// ---------------------------------------------------------------------------

function findRawField(entity, fieldDef) {
  if (!fieldDef || !entity.fields) return undefined;
  const match = entity.fields.find((f) => f.fieldId === fieldDef.fieldId);
  return match ? match.fieldValue : undefined;
}

function getTextField(entity, fieldDef) {
  const v = findRawField(entity, fieldDef);
  return v === undefined || v === null || v === '' ? null : String(v);
}
function getBooleanField(entity, fieldDef) {
  const v = findRawField(entity, fieldDef);
  return v === undefined || v === null ? null : Boolean(v);
}
function getDateField(entity, fieldDef) {
  return getTextField(entity, fieldDef); // Rocketlane returns dates as ISO strings already
}
function getNumberField(entity, fieldDef) {
  const v = findRawField(entity, fieldDef);
  return v === undefined || v === null || v === '' ? null : Number(v);
}
/** Single-choice fields return an option VALUE (integer) — resolve it to its label. */
function getChoiceField(entity, fieldDef) {
  const v = findRawField(entity, fieldDef);
  if (v === undefined || v === null || !fieldDef.fieldOptions) return null;
  const opt = fieldDef.fieldOptions.find((o) => o.optionValue === v);
  return opt ? opt.optionLabel : null;
}
function getNoteField(entity, fieldDef) {
  return getTextField(entity, fieldDef);
}

// ---------------------------------------------------------------------------
// Client conversation (general/public chat on a project) — see the UNVERIFIED
// warning above. Never throws: any failure here is logged and treated as "no
// conversation data available" for that company, not a fatal sync error.
// ---------------------------------------------------------------------------

async function fetchGeneralConversationMessages(projectId) {
  try {
    const conversations = await fetchAllPages('/conversations', { projectId });
    if (!conversations.length) return null;

    // Prefer a conversation actually named "General"; otherwise fall back to
    // the first non-private one, since that's the closest match to "the general
    // chat the client can see" without a confirmed naming convention to rely on.
    const general =
      conversations.find((c) => (c.conversationName || '').trim().toLowerCase() === 'general') ||
      conversations.find((c) => c.private === false) ||
      conversations[0];

    const messages = await fetchAllPages('/messages', { conversationId: general.conversationId });

    // Only client-visible messages — this is meant to show Support what the
    // client has actually seen/said, not internal team chatter. Internal notes
    // already have their own section elsewhere in the record.
    const publicMessages = messages.filter((m) => m.private !== true);

    return publicMessages
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, MAX_CONVERSATION_MESSAGES)
      .map((m) => ({
        content: m.content || null,
        createdAt: m.createdAt || null,
        // Single User field, same limitation as accountingOwner/trainer elsewhere —
        // resolving a userId to a name needs a GET /users lookup, not done yet.
        author: null,
      }));
  } catch (err) {
    console.warn(`[sync] Could not fetch conversation for project ${projectId}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch companies and projects
// ---------------------------------------------------------------------------

async function fetchCompanies() {
  // includeAllFields:true is required to get custom field values back on the
  // company object at all (confirmed via the MCP tool's equivalent parameter) —
  // the allowlist is still applied later, at JSON-write time, not here.
  return fetchAllPages('/companies', {
    includeFields: 'companyId,companyName,accountOwner',
    includeAllFields: 'true',
  });
}

async function fetchProjects() {
  // includeAllFields:true is deliberately broad here — the allowlist is applied
  // later, at JSON-write time, not here. Nothing from this raw fetch reaches the
  // frontend directly.
  return fetchAllPages('/projects', { includeAllFields: 'true' });
}

/**
 * ASSUMPTION (isolated here per the "one adapter function" rule — verify this
 * against real output on the first run and adjust if the project response shape
 * differs): the project's linked customer company id could come back as either
 * `customer.companyId` or `company.companyId` depending on API version. We check both.
 */
function getProjectCompanyId(project) {
  return project.customer?.companyId ?? project.company?.companyId ?? null;
}

/**
 * ASSUMPTION (isolated here — no get-projects access was available to confirm this
 * against a real Accounting Onboarding / Reconciliation / Training project, so this
 * classifies by which marker field is present rather than a project type/template
 * name. Check this against real synced data and switch to matching on project name
 * or template if that turns out to be more reliable):
 *   - has the Internal Status Tag field           -> Accounting Onboarding project
 *   - has a Reconciliation Status field            -> Reconciliation project
 *   - has a Training Completed / Assigned Trainer  -> Training project
 */
function classifyProject(project, projectFieldIds) {
  if (findRawField(project, projectFieldIds.internalStatusTag) !== undefined) return 'onboarding';
  if (findRawField(project, projectFieldIds.reconciliationStatus) !== undefined) return 'reconciliation';
  if (
    findRawField(project, projectFieldIds.trainingCompleted) !== undefined ||
    findRawField(project, projectFieldIds.assignedTrainer) !== undefined
  ) {
    return 'training';
  }
  return 'unknown';
}

/** Keeps the most-recently-updated project per (company, kind) if there are several. */
function groupProjectsByCompany(projects, projectFieldIds) {
  const byCompany = new Map();
  for (const project of projects) {
    const companyId = getProjectCompanyId(project);
    if (!companyId) continue;
    const kind = classifyProject(project, projectFieldIds);
    if (kind === 'unknown') continue;

    if (!byCompany.has(companyId)) byCompany.set(companyId, {});
    const bucket = byCompany.get(companyId);
    const existing = bucket[kind];
    if (!existing || new Date(project.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
      bucket[kind] = project;
    }
  }
  return byCompany;
}

// ---------------------------------------------------------------------------
// Build the sanitised per-company record — this is the explicit ALLOWLIST.
// Nothing outside what's assembled here is ever written to the output file.
// In particular: Sandbox user Email / Sandbox user Password are never read,
// never referenced, and never appear below — by omission, not by exclusion.
// ---------------------------------------------------------------------------

async function buildCompanyRecord(company, projects, projectFieldIds, companyFieldIds) {
  const onboarding = projects.onboarding;
  const reconciliation = projects.reconciliation;
  const training = projects.training;

  const recentMessages =
    INCLUDE_CLIENT_CONVERSATION && onboarding
      ? await fetchGeneralConversationMessages(onboarding.projectId)
      : null;

  const internalStatusTag = onboarding ? getChoiceField(onboarding, projectFieldIds.internalStatusTag) : null;
  const redFlag = onboarding ? getBooleanField(onboarding, projectFieldIds.redFlag) : false;
  const agentLiveWithAccounting = onboarding ? getBooleanField(onboarding, projectFieldIds.agentLiveWithAccounting) : false;
  const goLiveDate = onboarding ? getDateField(onboarding, projectFieldIds.accountingGoLiveDateActual) : null;

  return {
    companyId: company.companyId,
    companyName: company.companyName,
    networkId: getNumberField(company, companyFieldIds.networkId),
    units: onboarding ? getNumberField(onboarding, projectFieldIds.portfolioSize) : null,
    branches: getNumberField(company, companyFieldIds.branches),
    accountingOwner: null, // TODO: Single User fields return a userId — resolve against GET /users once confirmed
    // "Customer Success Manager (Accounting)" is SINGLE_CHOICE with named options
    // (not a Single User field), so this resolves cleanly with no userId lookup needed.
    csm: onboarding ? getChoiceField(onboarding, projectFieldIds.csmAccounting) : null,
    csmStreet: getTextField(company, companyFieldIds.csmStreet),
    segment: onboarding ? getChoiceField(onboarding, projectFieldIds.segment) : null,
    // Pulled from the Company/Account record, not the project — per the original
    // spec's "ACCOUNT GROUP: OVERVIEW" grouping. An earlier version of this script
    // read this off the project's native pipeline-status field instead; that was
    // wrong and has been corrected.
    streetStatus: getChoiceField(company, companyFieldIds.streetStatus),
    agentLiveWithAccounting: Boolean(agentLiveWithAccounting),
    goLiveDate,
    internalStatusTag,
    redFlag: Boolean(redFlag),
    optOut: internalStatusTag && /Opt-Out|Closed \/ None Responder/.test(internalStatusTag)
      ? { type: internalStatusTag, reason: onboarding ? getNoteField(onboarding, projectFieldIds.onboardingNotes) : null }
      : null,
    reconciliation: reconciliation
      ? {
          status: getChoiceField(reconciliation, projectFieldIds.reconciliationStatus),
          route: getChoiceField(reconciliation, projectFieldIds.reconciliationRoute),
          specialist: null, // TODO: Single User field — resolve userId via GET /users
          dateRaised: getDateField(reconciliation, projectFieldIds.reconciliationDateRaised),
          reviewCallBooked: getChoiceField(reconciliation, projectFieldIds.reconciliationReviewCallBooked),
          currentDifference: getNoteField(reconciliation, projectFieldIds.reconciliationCurrentDifference),
          outcome: getChoiceField(reconciliation, projectFieldIds.reconciliationOutcome),
          notes: onboarding ? getNoteField(onboarding, projectFieldIds.reconciliationNotes) : null,
        }
      : null,
    restart:
      onboarding && getChoiceField(onboarding, projectFieldIds.restartStatus)
        ? {
            status: getChoiceField(onboarding, projectFieldIds.restartStatus),
            route: getChoiceField(onboarding, projectFieldIds.restartRoute),
            reason: getNoteField(onboarding, projectFieldIds.restartReason),
            date: getDateField(onboarding, projectFieldIds.restartDate),
            notes: null,
          }
        : null,
    training: {
      status: training ? (getBooleanField(training, projectFieldIds.trainingCompleted) ? 'Completed' : 'Booked') : 'Not recorded',
      completed: training ? Boolean(getBooleanField(training, projectFieldIds.trainingCompleted)) : false,
      lastDate: training ? getDateField(training, projectFieldIds.trainingDate) : null,
      trainer: null, // TODO: Single User field — resolve userId via GET /users
      modules: training ? getTextField(training, projectFieldIds.trainingModules) : null,
      formats: training ? getChoiceField(training, projectFieldIds.trainingFormat) : null,
    },
    onboardingProject: onboarding
      ? {
          targetGoLive: getDateField(onboarding, projectFieldIds.accountingGoLiveDateTarget),
          openingBalanceBooked: Boolean(getBooleanField(onboarding, projectFieldIds.openingBalanceCallBooked)),
          clientAccountingEnabled: Boolean(getBooleanField(onboarding, projectFieldIds.clientAccountingEnabled)),
          notes: getNoteField(onboarding, projectFieldIds.onboardingNotes),
        }
      : null,
    internalNotes: {
      accounting: onboarding ? getNoteField(onboarding, projectFieldIds.accountingNote) : '',
      onboarding: onboarding ? getNoteField(onboarding, projectFieldIds.onboardingNotes) : '',
      gapAnalysis: '',
    },
    // Last few messages from the client-visible ("general") conversation on the
    // Accounting Onboarding project. null if unavailable — see INCLUDE_CLIENT_CONVERSATION
    // warning at the top of this file for why that might be the case right now.
    recentMessages,
    // Never fabricated — filled in only once you confirm Rocketlane's real project URL
    // pattern (open a project in the browser and paste the URL structure here).
    rocketlaneLinks: {
      accountingProject: null,
      reconciliationProject: null,
      trainingProject: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('[sync] Fetching field definitions…');
  const projectFieldIndex = await buildFieldIndex('PROJECT');
  const projectFieldIds = resolveFieldIds(projectFieldIndex, PROJECT_FIELD_LABELS);
  const companyFieldIndex = await buildFieldIndex('COMPANY');
  const companyFieldIds = resolveFieldIds(companyFieldIndex, COMPANY_FIELD_LABELS);

  console.log('[sync] Fetching companies…');
  const companies = await fetchCompanies();
  console.log(`[sync] ${companies.length} companies found.`);

  console.log('[sync] Fetching projects…');
  const projects = await fetchProjects();
  console.log(`[sync] ${projects.length} projects found.`);

  const projectsByCompany = groupProjectsByCompany(projects, projectFieldIds);

  const unmatchedCount = projects.length - Array.from(projectsByCompany.values())
    .reduce((sum, bucket) => sum + Object.keys(bucket).length, 0);
  if (unmatchedCount > 0) {
    console.log(`[sync] ${unmatchedCount} project(s) had no company link or didn't match a known kind — skipped.`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    companies: [],
  };

  for (const company of companies) {
    const linkedProjects = projectsByCompany.get(company.companyId);
    if (!linkedProjects || !linkedProjects.onboarding) continue; // no Accounting relationship at all — skip
    // Sequential, not Promise.all — this now makes an extra conversation/messages
    // call per company, and staying sequential keeps us well clear of any rate limit.
    output.companies.push(await buildCompanyRecord(company, linkedProjects, projectFieldIds, companyFieldIds));
  }

  console.log(`[sync] Writing ${output.companies.length} client record(s) with an active Accounting relationship.`);

  const fs = await import('node:fs/promises');
  await fs.mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await fs.writeFile(
    new URL('../data/support-clients.json', import.meta.url),
    JSON.stringify(output, null, 2) + '\n'
  );

  console.log('[sync] Done.');
}

main().catch((err) => {
  console.error('[sync] FAILED:', err.message);
  process.exit(1);
});
