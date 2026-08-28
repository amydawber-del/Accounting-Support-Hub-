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

- **The rich fields live on the Project object, not the Company object.**
  Every company checked had an empty custom-fields array. So this sync treats
  the client's Accounting Onboarding project as the primary source of truth,
  and the Company record as just the name/ID to group projects by.
- **"Internal Status Tag" is an ambiguous label** — there are three different
  Rocketlane fields whose label contains that phrase (Accounting's, Training's,
  and an unrelated Street network-settings one). The sync always matches on
  the *full* trimmed label, never a substring, to avoid silently reading the
  wrong field.
- **Field labels can carry stray whitespace or emoji** (e.g. a trailing space
  after "Portfolio Size (Managed Units-PUM) "). The sync trims labels on both
  sides before comparing, so this shouldn't bite you, but it's why hardcoding
  field IDs directly would have been fragile.
- The Projects API supports `companyId.eq` / `companyId.oneOf` for matching
  projects to a company, and `{type}.field.{field_id}.{operator}` for
  filtering by custom field — both used here.

## Known gaps — check these before relying on this fully

- **Project → company linking** (`getProjectCompanyId` in the sync script)
  assumes the field comes back as `customer.companyId` or `company.companyId`.
  This wasn't verified against a real project response (no project-search tool
  was available when this was built) — check the first real run's output and
  adjust if needed.
- **Project classification** (`classifyProject`) currently guesses whether a
  project is the Accounting Onboarding / Reconciliation / Training project by
  which marker field is present, not by a project type or template name. If
  Amy's projects are created from named templates, matching on `projectName`
  or template ID would likely be more reliable — worth revisiting once you can
  see real synced output.
- **Single User fields** (Accounting Owner, Reconciliation Specialist, Assigned
  Trainer, CSM) currently resolve to `null` — they come back from Rocketlane as
  a `userId`, which needs a lookup against `GET /users` to turn into a name.
  Marked with `// TODO` in `buildCompanyRecord`.
- **Street Network ID, branches, and CSM fields** aren't mapped yet — their
  exact labels weren't confirmed against live data.
- **Rocketlane project URLs are never fabricated.** `rocketlaneLinks` is
  written as `null` for every project until you confirm the real URL pattern
  (open any project in Rocketlane and copy its URL structure) and wire it into
  `buildCompanyRecord`.
- **Sandbox user Email / Sandbox user Password** are never read, referenced,
  or added to `FIELD_LABELS` anywhere in this script — by omission, not by a
  denylist check. If you extend the field list, keep it that way.

## Project structure

```
index.html
assets/
  css/styles.css
  js/app.js
data/
  support-clients.json      <- overwritten by the sync; sample data checked in for now
scripts/
  sync-rocketlane.js
.github/workflows/
  sync-rocketlane.yml
```
