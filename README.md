# Street Accounting Support Hub

A read-only Support dashboard showing where a client is up to with Street
Accounting onboarding, reconciliation, restarts and training — without giving
Support edit access to Rocketlane.

## How it works

```
Rocketlane  --(scheduled GitHub Action)-->  data/support-clients.json  -->  index.html
```

`scripts/sync-rocketlane.js` runs on a schedule (every 45 minutes, or on demand),
pulls the relevant Rocketlane data over the REST API, sanitises it against an
explicit allowlist, and writes `data/support-clients.json`. `index.html` +
`assets/js/app.js` fetch that file and render it — they never talk to Rocketlane
or see an API key.

## Setup

### 1. Add the API key as a repository secret

Repository → **Settings** → **Secrets and variables** → **Actions** → **New
repository secret**

Name: `ROCKETLANE_API_KEY`
Value: (from Rocketlane → Settings → API)

Never paste the key into any `.js`/`.html` file — only into this secret.

### 2. Enable GitHub Pages

Repository → **Settings** → **Pages** → Source: **Deploy from a branch** →
Branch: `main` (or whichever branch this lives on) → `/ (root)` → **Save**.

### 3. Run the sync once manually

Repository → **Actions** → **Sync Rocketlane data** → **Run workflow**. Check
the run's logs for any "Missing field mapping" or "duplicate field label"
warnings before trusting the output.

## Testing locally

Don't just double-click `index.html` — browsers block `fetch()` of local files
over `file://`, so the data won't load. Instead, from this folder run:

```
python3 -m http.server 8000
```

then open `http://localhost:8000`. This isn't needed once it's on GitHub
Pages, which serves everything over real HTTP.

## Changing field mappings

Every field this sync reads is looked up **by label**, not by ID, at the top
of `scripts/sync-rocketlane.js`:

```js
const FIELD_LABELS = {
  internalStatusTag: '(ACCOUNTING) 🏷️ Internal Status Tags',
  redFlag: '🚩 Red Flag (Accounting)',
  // ...
};
```

If a field gets renamed in Rocketlane, update the value here — nothing else
needs to change. If a run logs a "Missing field mapping" warning, the label in
this file no longer matches what's in Rocketlane; that item will just show as
"Not recorded" in the Hub rather than breaking the whole sync.

## What we confirmed against live Rocketlane data (28 Aug 2026)

A few things worth knowing before extending this further:

- **Correction: Company-level custom fields are NOT empty tenant-wide** — an
  earlier pass here sampled a few companies (Modert, Chorlton Homes, Dawbs
  Estates) that turned out to be test/demo accounts with nothing filled in,
  and wrongly concluded from that small sample that Company fields go unused
  everywhere. A real client ("Move Revolution") has a full set of populated
  Company custom fields. So this sync now reads from **both** objects:
  Accounting-specific fields (Internal Status Tag, Red Flag, reconciliation,
  training, etc.) come from the Accounting Onboarding **project**, since those
  were individually confirmed there; account-identity fields (Street Status,
  Street Network ID, branches, Street CSM) come from the **Company** record,
  per the original spec's "ACCOUNT GROUP: OVERVIEW" — see `PROJECT_FIELD_LABELS`
  vs `COMPANY_FIELD_LABELS` in the sync script. Worth remembering generally:
  a handful of sampled records finding nothing doesn't mean a field is unused
  across 1,145 companies — check a real, active client specifically.
- **"Internal Status Tag" is an ambiguous label** — there are three different
  Rocketlane fields whose label contains that phrase (Accounting's, Training's,
  and an unrelated Street network-settings one). The sync always matches on
  the *full* trimmed label, never a substring, to avoid silently reading the
  wrong field.
- **Field labels can carry stray whitespace or emoji** (e.g. a trailing space
  after "Portfolio Size (Managed Units-PUM) "). The sync trims labels on both
  sides before comparing, so this shouldn't bite you, but it's why hardcoding
  field IDs directly would have been fragile.
- **"Street Status" is a Company-level field, not the project's pipeline
  status.** An earlier version of this script used the project's native
  "Status" field (whose options are things like "Street: Live", "Street: Slow
  Mover / Stopped") as a stand-in — that was a mistake, corrected now to read
  a genuine `Street Status` field off the Company record instead, matching the
  original spec. **This exact label is unverified**: the MCP tool available
  during development refused `objectType=COMPANY` lookups outright (real
  Rocketlane's REST API supports it; the connected tool just didn't), so there
  was no way to confirm the field's real label or option values the way every
  other field in this doc was checked. Watch the first run's "Missing field
  mapping" warnings for `streetStatus`.
- **"Client Segment or Business Size" is confirmed** — options are `SMB` and
  `Enterprise & Strategic` (not just "Enterprise"). This one genuinely is a
  PROJECT field (fieldId 2621952), unlike Street Status above — the two
  fields living in different places despite both being in the spec's
  "ACCOUNT GROUP: OVERVIEW" section is exactly why nothing here is assumed
  by category; each field was checked individually where possible.
- **"Customer Success Manager (Accounting)" turned out to be SINGLE_CHOICE**
  with named options (e.g. "Amy Dawber (Onboarding)"), not a Single User field
  — so it resolves straight to a name, unlike Accounting Owner/Specialist/
  Trainer below, which still need a `GET /users` lookup. Its Company-level
  counterpart, `Customer Success Manager (Street)`, is unverified in the same
  way as Street Status above.
- The Projects API supports `companyId.eq` / `companyId.oneOf` for matching
  projects to a company, and `{type}.field.{field_id}.{operator}` for
  filtering by custom field — both used here.
- **Project → company linking is confirmed**: Rocketlane's own docs example
  shows a created project's response includes `customer: {companyId, ...}`.
  `getProjectCompanyId()` reads `project.customer.companyId` first, with
  `project.company.companyId` kept only as a defensive fallback.

## Client conversation on the detail page

Each client's page can show the last few messages from the general (client-
visible) Rocketlane conversation on their Accounting Onboarding project —
useful for Support to see what's already been said before replying.

**This is unverified.** `/conversations` and `/messages` don't appear
anywhere in Rocketlane's public documented REST API — only Companies,
Projects, Fields, Tasks, Phases, Users, Time Entries, Budgets, and Spaces are
listed at developer.rocketlane.com/reference. An AI tool connector reached
this data during development, but there was no way to confirm whether a plain
`api-key` REST call (which is all this script can use) reaches the same
thing, or something internal to that connector that isn't available this way.

It's wired up on the assumption the endpoints follow Rocketlane's normal
conventions (`GET /conversations?projectId=X`, then `GET
/messages?conversationId=X`). **Check the first real Action run's logs**:
- If you see `[sync] Could not fetch conversation for project ...` warnings
  for every client, this route isn't reachable this way — set
  `INCLUDE_CLIENT_CONVERSATION = false` at the top of
  `scripts/sync-rocketlane.js` to stop trying, and the rest of the sync is
  unaffected either way (this failure never blocks anything else).
- If it works, `recentMessages` will be populated normally.

Only messages that aren't marked private are pulled — this is meant to show
what the client has actually seen, not internal team notes (those are already
shown separately, in the Internal Notes section).

## Known gaps — check these before relying on this fully

- **Project classification** (`classifyProject`) currently guesses whether a
  project is the Accounting Onboarding / Reconciliation / Training project by
  which marker field is present, not by a project type or template name. If
  Amy's projects are created from named templates, matching on `projectName`
  or template ID would likely be more reliable — worth revisiting once you can
  see real synced output.
- **Single User fields (Accounting Owner, Accounting Specialist, Assigned
  Trainer) are now resolved via `GET /users`** — fixed 28 Aug 2026.
  `fetchUserIndex()` pulls the full user list once per sync and
  `getSingleUserField()` maps each field's raw `userId` to a display name.
  Two things worth knowing:
  - `GET /users` itself was never confirmed against this tenant before this
    fix — if the first run after this change logs `[sync] Could not fetch
    /users`, that endpoint/shape isn't what was assumed, and all three fields
    will show as "Not recorded" until that's corrected.
  - **`Accounting Owner` was missing from `PROJECT_FIELD_LABELS` entirely**
    before this fix — not just unresolved. It's a confirmed PROJECT-level
    `SINGLE_USER` field (fieldId 2284675). Worth remembering: a field
    hardcoded to `null` with a `// TODO` can mean "needs a lookup" (true for
    Specialist/Trainer) or "was never wired up in the first place" (true for
    Owner) — check the field's actually in the labels list before assuming
    the only gap is the user-resolution step.
- **Street Status, Street Network ID, branches, and Street CSM are mapped but
  unverified** (see the note above) — their exact field labels weren't
  confirmed against live data the way most other fields in this doc were,
  because the available tooling couldn't query Company-level fields directly.
- **Rocketlane project URLs are never fabricated.** `rocketlaneLinks` is
  written as `null` for every project until you confirm the real URL pattern
  (open any project in Rocketlane and copy its URL structure) and wire it into
  `buildCompanyRecord`.
- **Sandbox user Email / Sandbox user Password** are never read, referenced,
  or added to `FIELD_LABELS` anywhere in this script — by omission, not by a
  denylist check. If you extend the field list, keep it that way.

## Bugs found and fixed during development

The front end was originally built against a mock dataset that used `id` and
`name` as the company's key fields. When the real sync script's JSON schema
was written using `companyId` and `companyName` instead, several places in
`assets/js/app.js` were never updated to match — search, the "View client"
click-through, and the detail page header were all silently broken (`c.name`
renders as blank, not an error). Caught by testing the rendered output in a
headless browser against the real sample data rather than just checking for
syntax errors — worth doing again after any schema change.

## Password gate

The page is behind a client-side password screen (`assets/js/gate.js`) —
password: `SpearStreetHQ` (only its SHA-256 hash is stored in the source, not
the plaintext). Successful entry is remembered in the browser's `localStorage`
so it won't re-prompt on every visit from the same browser.

**Read this before treating it as real security:**
- This is a static GitHub Pages site with no backend. The gate only hides the
  *page* — it does nothing to protect `data/support-clients.json` itself,
  which stays directly fetchable by URL, gate or no gate.
- It can be bypassed entirely by anyone who opens browser dev tools and either
  reads the network response or flips the display styles by hand. It stops
  casual/accidental access, not a determined one.
- If the client data here genuinely needs protecting, the real options are:
  making the GitHub repo private (Pages then needs a paid GitHub plan to
  serve), or fronting the whole site with something like Cloudflare Access.
  Worth considering if reconciliation figures or internal notes shouldn't be
  world-readable to anyone with the link.

To change the password, replace `GATE_PASSWORD_HASH` in `assets/js/gate.js`
with the new password's SHA-256 hash (e.g. via `echo -n "newpassword" |
shasum -a 256` in a terminal).

## Project structure

```
index.html
assets/
  css/styles.css
  js/app.js
  js/gate.js
data/
  support-clients.json      <- overwritten by the sync; sample data checked in for now
scripts/
  sync-rocketlane.js
.github/workflows/
  sync-rocketlane.yml
```
