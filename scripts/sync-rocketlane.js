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
  redFlag: '🚩 Red Flag (Accounting)',
  // REVERTED to Project-sourced 28 Aug 2026 — confirmed live earlier this
  // session (fieldId 2017988, PROJECT-level, SINGLE_CHOICE). Briefly moved to
  // Company during a broad correction, which turned out to be wrong for this
  // field specifically: it silently returned null for real clients (caught
  // via R K Lucas showing "Live with Accounting" but a null Internal
  // Accounting Status). This field also doubles as the marker
  // classifyProjectGroups() uses to detect a company's onboarding project at
  // all — removing it from here didn't just blank the status display, it
  // silently broke onboarding-project detection tenant-wide, which cascades
  // into csm, segment, redFlag, and reconciliation notes all going null too.
  // Do not move this one again without keeping a Project-side marker field
  // for classification, even if the display value itself moves elsewhere.
  internalStatusTag: '(ACCOUNTING) 🏷️ Internal Status Tags',
  // NOTE on the history here: accountingGoLiveDateActual, agentLiveWithStreet
  // and streetUsage were reverted TO here 28 Aug 2026 (same day as
  // internalStatusTag above), then moved BACK to Company again the same day
  // once Amy confirmed (using Bracketts LLP as a concrete example) that all
  // three genuinely hold live data on the Company record — the earlier
  // "revert everything, 2-for-2 pattern" call was too broad. The real
  // problem with Accounting Go Live Date wasn't Project-vs-Company at all;
  // the guessed Company label had "(Actual)" appended, which the real
  // Company-side field doesn't use. Lesson: check the "Missing field
  // mapping" log first to tell a wrong-label problem from a wrong-object
  // problem before reverting a whole field to the other object type.
  // clientAccountingEnabled stays mapped on BOTH objects below — Amy asked
  // for it to prefer the Project value when an Accounting Onboarding project
  // exists, falling back to Company otherwise. See buildCompanyRecord.
  clientAccountingEnabled: 'Client Accounting Enabled',
  // These five were NOT part of this latest correction — Amy only flagged
  // Agent Live with Street, Street Usage, and Accounting Go Live Date as
  // wrong. Left as Project-sourced, unchanged.
  accountingOwner: 'Accounting Owner',
  streetPaymentsCustomer: 'Street Payments Accounting (Griffin)',
  streetPaymentsVerificationStatus: 'Verification status (Street Payments)',
  agentLiveWithAccounting: 'Agent Live with Accounting',
  streetGoLiveDateActual: 'Actual Go Live Date / Out of Set Up Mode', // still tentative as a label match — this is "Street Go Live Date", separate from "Accounting Go Live Date" which moved to Company below
  portfolioSize: 'Portfolio Size (Managed Units-PUM)',
  accountingGoLiveDateTarget: 'Accounting Go-Live Date (Target)',
  openingBalanceCallBooked: 'Opening Balance Organiser',
  accountsTrainingCompleted: 'Accounts Training Completed?',
  segment: 'Client Segment or Business Size', // confirmed as a PROJECT field (2621952) — kept here per Amy's explicit confirmation (28 Aug 2026), unlike everything else in this correction
  csmAccounting: 'Customer Success Manager (Accounting)',
  // Reconciliation-project fields
  reconciliationStatus: 'Reconciliation Status',
  reconciliationRoute: 'Reconciliation Route',
  reconciliationDateRaised: 'Date Raised',
  reconciliationReviewCallBooked: 'Review Call Booked',
  reconciliationSpecialist: 'Accounting Specialist',
  reconciliationOutcome: 'Reconciliation Outcome',
  reconciliationCurrentDifference: 'Current Difference (£)',
  // Training-project fields
  trainingCompleted: 'Training Completed',
  trainingDate: 'Training Date',
  trainingModules: 'Modules Covered',
  trainingFormat: 'Training Format',
  assignedTrainer: 'Assigned Trainer',
  // CONFIRMED live (28 Aug 2026): PROJECT-level, SINGLE_CHOICE, fieldId
  // 2044705 — distinct from the Accounting Internal Status Tag field.
  // Was never wired up before; training.status was previously just derived
  // from the Training Completed Yes/No field.
  trainingInternalStatusTag: 'Training Internal Status Tag',
  // Notes (NOTE fields)
  accountingNote: 'Street Client Accounting Note',
  reconciliationNotes: 'Client Accounting Reconciliation Notes',
  onboardingNotes: 'Onboarding Notes',
};

// Company/Account-level fields. streetStatus/networkId/branches/csmStreet
// were confirmed populated on real clients early on.
//
// agentLiveWithStreet, streetUsage, and accountingGoLiveDateActual were
// confirmed live here 28 Aug 2026 using Bracketts LLP as a concrete example
// — all three genuinely hold real data on Company, contradicting the
// Project-side fields I'd found with similar names/purposes. Note the
// corrected labels: no "(Actual)" suffix on the go-live date, and a plainer
// "Agent Live with Street" rather than the Project field's "...(Accounting
// Tracker)" wording — these are evidently different fields with overlapping
// purposes, not the same field misfiled.
//
// clientAccountingEnabled is mapped here too as a FALLBACK only — Amy's
// instruction was to prefer the Project value when an Accounting Onboarding
// project exists, and fall back to this Company value otherwise. See
// buildCompanyRecord for the actual fallback logic.
//
// onboardingSpecialist, accountingStatus, and the four restart fields below
// were never confirmed as living on either object — still the only guesses
// available. onboardingSpecialist is now read as a SINGLE_USER field
// (getSingleUserField), not plain text — confirmed 28 Aug 2026 via Bracketts
// LLP showing a raw userId ("277598") instead of the specialist's name
// ("Lucie"), the same failure signature Accounting Owner had originally.
const COMPANY_FIELD_LABELS = {
  streetStatus: 'Street Status',
  // FIXED 28 Aug 2026 — real label has a trailing colon, confirmed by Amy
  // checking the field directly in Rocketlane. This is why it silently
  // returned null for every company despite the guess looking right: colons
  // aren't whitespace, so .trim() never touches them, and the label
  // comparison is exact. Worth remembering if any other field keeps
  // resolving to null with no obvious cause — check for trailing punctuation
  // in the real label, not just wording.
  networkId: 'Street Network ID:',
  branches: 'Number of branches',
  csmStreet: 'Customer Success Manager (Street)',
  onboardingSpecialist: 'Onboarding Specialist',
  accountingStatus: 'Accounting Status',
  agentLiveWithStreet: 'Agent Live with Street',
  streetUsage: 'Street Usage',
  accountingGoLiveDateActual: 'Accounting Go Live Date',
  clientAccountingEnabled: 'Client Accounting Enabled',
  restartStatus: 'Accounting Restart Status',
  restartRoute: 'Accounting Restart Route',
  restartReason: 'Accounting Restart Reason',
  restartDate: 'Last Accounting Restart Date',
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

/** Multiple-choice fields return an array of option VALUEs — resolve each to
 *  its label and join into a readable string. */
function getMultiChoiceField(entity, fieldDef) {
  const v = findRawField(entity, fieldDef);
  if (v === undefined || v === null || !fieldDef.fieldOptions) return null;
  const values = Array.isArray(v) ? v : [v];
  const labels = values
    .map((val) => fieldDef.fieldOptions.find((o) => o.optionValue === val))
    .filter(Boolean)
    .map((o) => o.optionLabel);
  return labels.length ? labels.join(', ') : null;
}

// ---------------------------------------------------------------------------
// SINGLE_USER field resolution — Accounting Owner, Accounting Specialist and
// Assigned Trainer all come back from Rocketlane as a userId, which needs a
// GET /users lookup to become a display name. This was the long-standing TODO
// in buildCompanyRecord (all three hardcoded to null). /users isn't among the
// endpoints this script had already verified, so this fetch is wrapped the
// same way the conversation/messages fetch is: on any failure, log a warning
// and fall back to null for every Single User field rather than failing the
// whole sync.
// ---------------------------------------------------------------------------

async function fetchUserIndex() {
  try {
    const users = await fetchAllPages('/users', {});
    const byId = new Map();
    for (const u of users) {
      const name =
        [u.firstName, u.lastName].filter(Boolean).join(' ').trim() ||
        u.emailId ||
        u.email ||
        (u.userId !== undefined ? `User ${u.userId}` : null);
      if (u.userId !== undefined && name) byId.set(u.userId, name);
    }
    console.log(`[sync] Resolved ${byId.size} user(s) from /users for Single User field lookups.`);
    return byId;
  } catch (err) {
    console.warn(`[sync] Could not fetch /users — Accounting Owner, Accounting Specialist and Assigned Trainer will show as "Not recorded" this run. Error: ${err.message}`);
    return new Map();
  }
}

/** Resolves a SINGLE_USER custom field to a display name via the user index above.
 *  Handles the raw value coming back as either a bare userId or an object
 *  containing one — this shape hasn't been confirmed against a real populated
 *  field, so both are covered defensively. */
function getSingleUserField(entity, fieldDef, userIndex) {
  const raw = findRawField(entity, fieldDef);
  if (raw === undefined || raw === null) return null;
  const userId = typeof raw === 'object' ? raw.userId ?? raw.id ?? null : raw;
  if (userId === null) return null;
  return userIndex.get(userId) || null;
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
 * UPDATED 28 Aug 2026 — this used to return a single mutually-exclusive kind
 * per project, checked in priority order (Internal Status Tag first). Since
 * the Internal Status Tag field is present on essentially every Accounting
 * project — including ones actively in reconciliation — that meant a
 * project's Reconciliation/Training fields were never even checked once it
 * matched "onboarding", silently hiding the Reconciliation tile even for
 * clients tagged "Client Accounting Reconciliation". This is very plausibly
 * because all these fields live together on ONE project per client in this
 * tenant, not on three separate project records as originally assumed.
 * classifyProjectGroups() now checks each marker independently, so a single
 * project can carry data for more than one group at once. If reconciliation/
 * training genuinely do live on separate project records for some clients,
 * this still works correctly — it just also handles the case where they don't.
 */
function classifyProjectGroups(project, projectFieldIds) {
  const groups = [];
  if (findRawField(project, projectFieldIds.internalStatusTag) !== undefined) groups.push('onboarding');
  if (findRawField(project, projectFieldIds.reconciliationStatus) !== undefined) groups.push('reconciliation');
  if (
    findRawField(project, projectFieldIds.trainingCompleted) !== undefined ||
    findRawField(project, projectFieldIds.assignedTrainer) !== undefined
  ) {
    groups.push('training');
  }
  return groups;
}

/** Kept for the diagnostics summary, which wants one dominant label per
 *  project rather than the full set classifyProjectGroups() now returns. */
function classifyProject(project, projectFieldIds) {
  return classifyProjectGroups(project, projectFieldIds)[0] || 'unknown';
}

/** Keeps the most-recently-updated project per (company, group) if there are
 *  several. A single project can now populate more than one group — see
 *  classifyProjectGroups() above for why that changed. */
function groupProjectsByCompany(projects, projectFieldIds) {
  const byCompany = new Map();
  for (const project of projects) {
    const companyId = getProjectCompanyId(project);
    if (!companyId) continue;
    const groups = classifyProjectGroups(project, projectFieldIds);
    if (!groups.length) continue;

    if (!byCompany.has(companyId)) byCompany.set(companyId, {});
    const bucket = byCompany.get(companyId);
    for (const kind of groups) {
      const existing = bucket[kind];
      if (!existing || new Date(project.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
        bucket[kind] = project;
      }
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

async function buildCompanyRecord(company, projects, projectFieldIds, companyFieldIds, userIndex) {
  const onboarding = projects.onboarding;
  const reconciliation = projects.reconciliation;
  const training = projects.training;

  const recentMessages =
    INCLUDE_CLIENT_CONVERSATION && onboarding
      ? await fetchGeneralConversationMessages(onboarding.projectId)
      : null;

  // REVERTED to Project-sourced 28 Aug 2026 — see the note on
  // PROJECT_FIELD_LABELS above. redFlag and segment were never part of this
  // back-and-forth: redFlag was never moved, segment stays on Project per
  // Amy's explicit confirmation earlier.
  const internalStatusTag = onboarding ? getChoiceField(onboarding, projectFieldIds.internalStatusTag) : null;
  const redFlag = onboarding ? getBooleanField(onboarding, projectFieldIds.redFlag) : false;
  const agentLiveWithAccounting = onboarding ? getBooleanField(onboarding, projectFieldIds.agentLiveWithAccounting) : false;
  // MOVED to Company-sourced 28 Aug 2026 — confirmed via Bracketts LLP
  // showing a real "01 Jul 2026" on the Company record. The corrected label
  // (no "(Actual)" suffix) is what fixed this, not the object type — see the
  // long note on PROJECT_FIELD_LABELS.
  const goLiveDate = getDateField(company, companyFieldIds.accountingGoLiveDateActual);
  // Street Go Live Date (separate field from Accounting Go Live Date above)
  // stays Project-sourced — not something Amy has flagged as wrong.
  const streetGoLiveDate = onboarding ? getDateField(onboarding, projectFieldIds.streetGoLiveDateActual) : null;
  // MOVED to Company-sourced 28 Aug 2026 — confirmed via Bracketts LLP (TRUE
  // on the Company record, was showing No when read from Project).
  const agentLiveWithStreet = getBooleanField(company, companyFieldIds.agentLiveWithStreet);
  // MOVED to Company-sourced 28 Aug 2026 — same Bracketts LLP evidence; the
  // Project-side "Street Usage" field either doesn't hold this client's real
  // data or isn't the one actually in use day-to-day.
  const streetUsage = getMultiChoiceField(company, companyFieldIds.streetUsage);
  // Client Accounting Enabled: prefer the Project value (Accounting
  // Onboarding project board) when one exists, per Amy's explicit
  // instruction — fall back to the Company value otherwise. getBooleanField
  // returns null (not false) when the field is simply absent, so `!== null`
  // correctly distinguishes "explicitly set on the project" from "no value
  // there at all", rather than a real false on the project being masked.
  const clientAccountingEnabledFromProject = onboarding ? getBooleanField(onboarding, projectFieldIds.clientAccountingEnabled) : null;
  const clientAccountingEnabledFromCompany = getBooleanField(company, companyFieldIds.clientAccountingEnabled);
  const clientAccountingEnabled = Boolean(
    clientAccountingEnabledFromProject !== null ? clientAccountingEnabledFromProject : clientAccountingEnabledFromCompany
  );

  return {
    companyId: company.companyId,
    companyName: company.companyName,
    networkId: getNumberField(company, companyFieldIds.networkId),
    units: onboarding ? getNumberField(onboarding, projectFieldIds.portfolioSize) : null,
    branches: getNumberField(company, companyFieldIds.branches),
    accountingOwner: onboarding ? getSingleUserField(onboarding, projectFieldIds.accountingOwner, userIndex) : null,
    // FIXED 28 Aug 2026 — this is a SINGLE_USER field (confirmed via
    // Bracketts LLP showing raw userId "277598" instead of "Lucie"), not
    // plain text. Still an unconfirmed label otherwise.
    onboardingSpecialist: getSingleUserField(company, companyFieldIds.onboardingSpecialist, userIndex),
    // Still unconfirmed either way — see the COMPANY_FIELD_LABELS note.
    accountingStatus: getChoiceField(company, companyFieldIds.accountingStatus),
    clientAccountingEnabled,
    streetPayments: {
      customer: onboarding ? getBooleanField(onboarding, projectFieldIds.streetPaymentsCustomer) : null,
      verificationStatus: onboarding ? getChoiceField(onboarding, projectFieldIds.streetPaymentsVerificationStatus) : null,
    },
    // "Customer Success Manager (Accounting)" is SINGLE_CHOICE with named options
    // (not a Single User field), so this resolves cleanly with no userId lookup needed.
    csm: onboarding ? getChoiceField(onboarding, projectFieldIds.csmAccounting) : null,
    csmStreet: getTextField(company, companyFieldIds.csmStreet),
    segment: onboarding ? getChoiceField(onboarding, projectFieldIds.segment) : null,
    streetStatus: getChoiceField(company, companyFieldIds.streetStatus),
    agentLiveWithStreet: Boolean(agentLiveWithStreet),
    streetGoLiveDate,
    streetUsage,
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
          specialist: getSingleUserField(reconciliation, projectFieldIds.reconciliationSpecialist, userIndex),
          dateRaised: getDateField(reconciliation, projectFieldIds.reconciliationDateRaised),
          reviewCallBooked: getChoiceField(reconciliation, projectFieldIds.reconciliationReviewCallBooked),
          currentDifference: getNoteField(reconciliation, projectFieldIds.reconciliationCurrentDifference),
          outcome: getChoiceField(reconciliation, projectFieldIds.reconciliationOutcome),
          notes: onboarding ? getNoteField(onboarding, projectFieldIds.reconciliationNotes) : null,
        }
      : null,
    // MOVED to Company-sourced reads 28 Aug 2026, per Amy's correction —
    // previously read off the onboarding project (never confirmed live either
    // way; the README flagged this location as unverified from the start).
    restart:
      getChoiceField(company, companyFieldIds.restartStatus)
        ? {
            status: getChoiceField(company, companyFieldIds.restartStatus),
            route: getChoiceField(company, companyFieldIds.restartRoute),
            reason: getNoteField(company, companyFieldIds.restartReason),
            date: getDateField(company, companyFieldIds.restartDate),
            notes: null,
          }
        : null,
    training: {
      // CONFIRMED live field now (Training Internal Status Tag) — replaces
      // the previous derived "Completed"/"Booked"/"Not recorded" guess with
      // Rocketlane's actual training pipeline stage (e.g. "Training
      // Delivered", "Confirmed & Scheduled", "Closed").
      status: training ? (getChoiceField(training, projectFieldIds.trainingInternalStatusTag) || 'Not recorded') : 'Not recorded',
      completed: training ? Boolean(getBooleanField(training, projectFieldIds.trainingCompleted)) : false,
      lastDate: training ? getDateField(training, projectFieldIds.trainingDate) : null,
      trainer: training ? getSingleUserField(training, projectFieldIds.assignedTrainer, userIndex) : null,
      // FIXED: both Modules Covered and Training Format are MULTIPLE_CHOICE
      // fields in Rocketlane, not TEXT/SINGLE_CHOICE — the previous getters
      // (getTextField / getChoiceField) don't handle an array of option
      // values, so these were almost certainly showing raw numeric IDs or
      // silently returning null rather than the real labels.
      modules: training ? getMultiChoiceField(training, projectFieldIds.trainingModules) : null,
      formats: training ? getMultiChoiceField(training, projectFieldIds.trainingFormat) : null,
    },
    onboardingProject: onboarding
      ? {
          targetGoLive: getDateField(onboarding, projectFieldIds.accountingGoLiveDateTarget),
          openingBalanceBooked: Boolean(getBooleanField(onboarding, projectFieldIds.openingBalanceCallBooked)),
          // clientAccountingEnabled removed from here 28 Aug 2026 — it's now
          // a top-level Company-sourced field (see clientAccountingEnabled
          // above) per Amy's correction. This nested object is no longer
          // displayed anywhere in the UI; kept only for targetGoLive/
          // openingBalanceBooked in case a future tile wants them back.
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

  console.log('[sync] Fetching users (for Accounting Owner / Specialist / Trainer lookups)…');
  const userIndex = await fetchUserIndex();

  // ---- Diagnostics: classify every project up front so we can report exact
  // counts and reasons, not just a final total. This is the main thing this
  // script was missing — "149 projects in Rocketlane" vs "X synced" needs a
  // breakdown to be actionable, not just a final number.
  let noCompanyLinkCount = 0;
  const kindCounts = { onboarding: 0, reconciliation: 0, training: 0, unknown: 0 };
  for (const project of projects) {
    if (!getProjectCompanyId(project)) { noCompanyLinkCount++; continue; }
    kindCounts[classifyProject(project, projectFieldIds)]++;
  }

  const projectsByCompany = groupProjectsByCompany(projects, projectFieldIds);

  const output = {
    generatedAt: new Date().toISOString(),
    companies: [],
  };

  // UPDATED 28 Aug 2026, per Amy: every company should appear in the Hub —
  // Street-only clients included — with Accounting fields simply blank/null
  // when there's no Accounting relationship, rather than the company being
  // excluded entirely. buildCompanyRecord already handles a missing
  // `onboarding`/`reconciliation`/`training` project gracefully everywhere
  // (`onboarding ? ... : null`), so nothing here changes except no longer
  // skipping the push. companiesWithNoAccountingRelationship is kept as a
  // diagnostic count (renamed from "skipped") since it's still useful to
  // know how many of the 1,146 have no Accounting data at all — they're just
  // included now instead of dropped.
  const companiesWithNoAccountingRelationship = [];
  for (const company of companies) {
    const linkedProjects = projectsByCompany.get(company.companyId) || {};
    const hasAnyAccountingProject =
      linkedProjects.onboarding || linkedProjects.reconciliation || linkedProjects.training;
    if (!hasAnyAccountingProject) {
      companiesWithNoAccountingRelationship.push(company.companyName);
    }
    // Sequential, not Promise.all — this now makes an extra conversation/messages
    // call per company, and staying sequential keeps us well clear of any rate limit.
    output.companies.push(await buildCompanyRecord(company, linkedProjects, projectFieldIds, companyFieldIds, userIndex));
  }

  const skippedNoAccountingProject = companiesWithNoAccountingRelationship; // kept for the log/diagnostics code below, unchanged

  // Written into the JSON itself (not just the run log) so the counts are
  // visible without digging through Action logs — check this after every run.
  // Catches the exact failure class that hit Internal Accounting Status:
  // a field mapping that resolves cleanly (no "Missing field mapping"
  // warning) but returns null for everyone because the wrong object was
  // queried. A company with a confirmed onboarding project but a blank
  // Internal Accounting Status is a strong signal something's wrong with
  // that specific field's source, not the data itself.
  const missingStatusDespiteOnboarding = output.companies.filter(
    (c) => projectsByCompany.get(c.companyId)?.onboarding && !c.internalStatusTag
  ).length;

  output.syncDiagnostics = {
    companiesFetchedFromRocketlane: companies.length,
    projectsFetchedFromRocketlane: projects.length,
    projectsWithNoCompanyLink: noCompanyLinkCount,
    projectsByClassification: kindCounts,
    companiesWrittenToSupportHub: output.companies.length,
    companiesWithNoAccountingProjectFound: skippedNoAccountingProject.length,
    companiesWithOnboardingProjectButNoInternalStatusTag: missingStatusDespiteOnboarding,
  };

  if (missingStatusDespiteOnboarding > 0) {
    console.warn(`[sync] WARNING: ${missingStatusDespiteOnboarding} compan(y/ies) have a confirmed onboarding project but no Internal Accounting Status value — check the internalStatusTag field mapping is reading from the right object before trusting this run's data.`);
  }

  console.log('[sync] ---- Diagnostics ----');
  console.log(`[sync] Companies fetched from Rocketlane: ${companies.length}`);
  console.log(`[sync] Projects fetched from Rocketlane: ${projects.length}`);
  if (noCompanyLinkCount > 0) {
    console.log(`[sync]   ${noCompanyLinkCount} project(s) had no resolvable company link (see getProjectCompanyId) — check whether real project responses use customer.companyId or something else entirely.`);
  }
  console.log(`[sync]   Classified as onboarding:     ${kindCounts.onboarding}`);
  console.log(`[sync]   Classified as reconciliation:  ${kindCounts.reconciliation}`);
  console.log(`[sync]   Classified as training:        ${kindCounts.training}`);
  console.log(`[sync]   Classified as unknown (dropped): ${kindCounts.unknown} — these had none of the marker fields checked in classifyProject(). If this number is large relative to your real project count, the marker-field heuristic is likely missing real Accounting projects; consider matching on project name/template instead (see README).`);
  console.log(`[sync] Companies written to support-clients.json: ${output.companies.length}`);
  console.log(`[sync] Companies with no Accounting relationship at all (still included, Accounting fields blank): ${skippedNoAccountingProject.length}`);
  if (skippedNoAccountingProject.length) {
    console.log('[sync]   Sample (first 20) — cross-check a few against Rocketlane if this count looks too high, e.g. if a company you know has Accounting data isn\'t in the sample but the count suggests it should be:');
    console.log('[sync]   ' + skippedNoAccountingProject.slice(0, 20).join(', '));
  }
  console.log('[sync] ----------------------');

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
