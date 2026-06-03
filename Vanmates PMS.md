# Vanmates PMS Portal — Claude Memory

> Last updated: 2026-05-19 · Maintained for Aldo (CEO, Vanmates)

> **Security note:** This file lives in a public GitHub repo. The original
> in Aldo's workspace folder (`/sessions/exciting-beautiful-hypatia/mnt/outputs/CLAUDE.md`)
> contains the actual PAT values. Future Claude sessions should ask Aldo
> for credentials, or read them from his local workspace copy.


This file is the persistent context for Claude across sessions. Read it first
when working on the Vanmates Property Management System portal.

---

## Quick reference

| Item | Value |
|---|---|
| Live URL | https://portal.vanmates.com |
| GitHub repo | `aldo-adr23/vanmates-pms-demo` (renamed to `index.html` on Pages) |
| GitHub PAT | `<REDACTED — ask Aldo for the GitHub PAT>` |
| Supabase project | `recbwmihyinlgxnymcmc` |
| Supabase PAT (management) | `<REDACTED — ask Aldo for the Supabase management PAT>` (regenerates often) |
| Resend API key | `<REDACTED — ask Aldo for the Resend API key>` |
| Storage bucket | `lease-docs` |

**Cache versioning convention:** `pms-supabase.js?v=YYYY-MM-DD<letter>`. Most
recent in this conversation: `2026-05-02b`. Increment the letter on every
deploy so browsers pick up the new code.

---

## What this product is

A web-based Property Management System for Vanmates, a Vancouver-based
property management company managing ~120 properties (co-living + Airbnb +
homestays) across Vancouver, Toronto, Montréal, and Guadalajara. The portal
tracks ~530 active tenants, ~50 landlords, ~150 homestay hosts, ~30 homestay
clients, and the homestay matching pipeline. It also handles damage deposits,
maintenance tickets, financials, and team access.

The portal is for Vanmates' internal team (CEO + Ops + Accounting + Property
Managers), not for end-tenants.

---

## Architecture

### Frontend

- **Single-page app** in `vanmates-pms.html` (~1.15 MB, renamed to `index.html`
  on GitHub Pages). Plain HTML/CSS/vanilla JS — no React/framework.
- **Cache-busted external scripts** via `<script src="pms-supabase.js?v=…">`.
- **All UI views are in `<section class="view" data-view="…">` blocks** —
  switching views toggles their visibility.

### Backend

- **Supabase Postgres** for persistence (project `recbwmihyinlgxnymcmc`).
- **Supabase Auth** with email + Google OAuth via `signin.html`.
- **Supabase Storage** bucket `lease-docs` for contract PDFs (signed URLs
  with 1-hour expiry, refreshed on-demand).
- **Supabase Edge Functions** (Deno) for invite-email sending via Resend.
- **GitHub Pages** serves the static portal at `portal.vanmates.com`.

### Data flow

1. Page loads → seed data baked into `vanmates-pms.html` populates global
   arrays: `window.tenants`, `window.properties`, `window.landlords`,
   `window.homestayHosts`, `window.homestayClients`, `window.vacancies`,
   `window.damageDeposits`, `window.homestayApplicants`.
2. `vmDb.hydrate()` runs after DOM ready. For each table it:
   - Fetches active rows (where `deleted_at IS NULL`).
   - Fetches tombstone IDs (where `deleted_at IS NOT NULL`).
   - Merges in localStorage tombstones (see Soft-delete section below).
   - **Defensive check:** if Supabase returns < 10% of local seed count, it
     keeps local data (assumes RLS / auth failure) but still applies
     tombstones from BOTH sources.
   - Otherwise replaces the local array with Supabase data, filtering out
     localStorage-tombstoned IDs.
3. Render functions re-run to repaint the UI.
4. Subsequent edits push to Supabase via `vmDb.upsert(arrayName, record)`
   and `vmDb.delete(arrayName, id, fullRecord)` (fire-and-forget).

### Tables and key fields

| Array name | Postgres table | Primary key source |
|---|---|---|
| `properties` | `properties` | `record.name` |
| `tenants` | `tenants` | `record.email` (fallback to `record.id`) |
| `landlords` | `landlords` | `record.id` |
| `homestayHosts` | `homestay_hosts` | `record.id` |
| `homestayClients` | `homestay_clients` | `record.id` |
| `vacancies` | `vacancies` | `record.id` |
| `damageDeposits` | `damage_deposits` | `record.id` |
| `homestayApplicants` | `homestay_applicants` | `record.id` |

Every row in Postgres has shape `{ id, data: JSONB, deleted_at, updated_by, … }`
with selected scalar columns mirrored for indexing.

### RLS (Row-Level Security)

- Any signed-in teammate can `SELECT`.
- Only `role='admin'` can `INSERT` / `UPDATE` / `DELETE`.
- This caused soft-delete failures for non-admin roles (Accounting, Ops) —
  addressed by the **localStorage tombstone fallback** (see below).

### Soft-delete + tombstones

Implemented in `pms-supabase.js`:

- `vmDb.delete(arrayName, id, fullRecord)` does THREE things in order:
  1. **Always** writes a localStorage tombstone (`vm-pms-tombstones-v1`
     key) — synchronous, can't fail, works for any role.
  2. Tries `UPDATE deleted_at = now() WHERE id = ?` (Phase 1).
  3. If 0 rows affected, tries `UPSERT { id, data, deleted_at }` to create
     a tombstone for seed-only rows (Phase 2).
- `hydrate()` merges Supabase tombstones + localStorage tombstones and
  filters local arrays accordingly — so deletes stick across refreshes
  regardless of role.
- Trade-off: localStorage tombstones are **per-browser**. To sync across
  devices, an admin (Aldo) must perform the delete, OR Denisse must be
  promoted to admin, OR RLS must be relaxed.

---

## File layout (in workspace folder `/sessions/exciting-beautiful-hypatia/mnt/outputs/`)

| File | Purpose |
|---|---|
| `vanmates-pms.html` | The main portal (renamed `index.html` on Pages) |
| `pms-supabase.js` | Persistence layer (hydrate / upsert / delete / file upload) |
| `signin.html` | Auth UI (email + Google) |
| `forgot-password.html` | Password reset |
| `invite-email-template.html` | Template for invite emails (Resend) |
| `phase2-schema.sql` | Postgres schema for all 8 tables |
| `phase2-seeds-all.sql` | Initial seed for Supabase tables |
| `edge-functions/` | Deno edge functions (invite sender) |
| `noi-annex-house-april-2026.pdf` | Sample NOI / P&L (linked from property panels) |
| `lease-annex-house.pdf` | Sample lease (linked from landlord panels) |
| `host-profile-tremblay.pdf` | Sample host profile |
| `launch-checklist.md`, `phase2-*-status.md` | Project status notes |

---

## Deploy process

Every time the HTML or JS changes:

1. Update local file in `/sessions/exciting-beautiful-hypatia/mnt/outputs/`.
2. Bump the cache tag inside the HTML:
   ```python
   re.sub(r'pms-supabase\.js\?v=[^"]+', 'pms-supabase.js?v=NEW_TAG', html)
   ```
3. Validate JS syntax: `node --check /tmp/inline.js` (after extracting all
   inline `<script>` blocks from the HTML).
4. Fetch the current SHA via the GitHub Contents API.
5. PUT the new content (base64-encoded) to
   `/repos/aldo-adr23/vanmates-pms-demo/contents/index.html` (HTML) and/or
   `/repos/aldo-adr23/vanmates-pms-demo/contents/pms-supabase.js` (JS).
6. **Poll** `https://portal.vanmates.com/?_v=…` until the new cache tag
   appears (usually 30-60 s).
7. Test in a Chrome MCP tab with `?cb=…` cache-buster.

**IMPORTANT:** If you only deploy the HTML but the bug is in `pms-supabase.js`,
the fix won't take effect. Always check which file needs updating and deploy
both if needed.

---

## Common debugging patterns

### "I can't open the detail panel for this tenant"

The `openTenant()` function reads several fields that crash if undefined:
`t.ini`, `t.pay`, `t.tags`, `t.flag`, `t.country`, `t.school`. Newly-added
tenants via the quick "+ Add tenant" flow used to be missing some of these.
Now hardened with defaults at the top of `openTenant()`. If a new bug
appears, check the console for `TypeError: Cannot read properties of undefined`.

The row click handler uses `data-email`. For tenants without email it now
falls back to `t.id` — same lookup logic on the openTenant side.

### "My delete doesn't stick after refresh"

1. Check the user's role — non-admins are blocked by RLS from writing.
2. Check `localStorage["vm-pms-tombstones-v1"]` — if the id is there, the
   local tombstone is working.
3. Check Supabase `deleted_at` column — if null, the cross-device write
   was rejected. Either promote the user to admin or have admin redo the
   delete.

### "Hard refresh isn't picking up my changes"

- Chrome aggressively caches. Try DevTools → Network → "Disable cache" +
  reload, or open in incognito.
- Verify with `document.querySelector('script[src*="pms-supabase"]').src` in
  the console — it should show the latest cache tag.

### "JS errors that hide the panel"

The detail panel often fails silently because click handlers don't
try/catch. To diagnose: open DevTools console BEFORE clicking, then click.
The TypeError appears in the console even when the UI stays blank.

---

## Roles + access

Stored in the `team_members` table. Roles in use:
- `admin` — full access (Aldo)
- `ops` — operations manager
- `accounting` — finance/accounting (Denisse)
- `property` — property manager
- `viewer` — read-only

`CURRENT_USER` is hydrated from `team_members` on boot. Page-level access is
gated by `allowed_pages` (an array of view keys, or `null` for admins =
all access).

---

## Style conventions

- **Comments** in code should be informative — explain WHY, not just WHAT.
- **Cache-bust** the JS reference whenever shipping changes that touch
  loading code paths.
- **Show toasts** on async failures, not silent console errors.
- **Action menus**: ⋯ → menu with Edit + Delete, positioned with
  `position:fixed` and a max-width to avoid going off-screen.
- **Date inputs** use `type="date"`, store as `YYYY-MM-DD` strings.
- **Money** rendered via `fmt(n)` helper which adds commas and `$` prefix.
- **Initials** computed from first two words of name (or first 2 chars of
  single-word names).
- **Country flags** mapped from country string via `flagMap` in
  `openAddTenantModal`; fallback `🌐`.

---

## Recent fix log (selected)

| Date | Fix | Cache |
|---|---|---|
| 2026-05-19 | Tenant contract PDF upload + PandaDoc link | `2026-05-01u` |
| 2026-05-19 | City filter for Properties uses `p.city` (no longer tenant-derived) | `2026-05-01v` |
| 2026-05-19 | Map view → Back to grid actually re-renders | `2026-05-01w` |
| 2026-05-19 | Move-in date editable in Edit tenant modal | `2026-05-01x` |
| 2026-05-19 | localStorage tombstone fallback for non-admin deletes | `2026-05-01y` |
| 2026-05-19 | Delete property menu visible to all roles (was admin-gated) | `2026-05-01z` |
| 2026-05-19 | New tenants from Add tenant get pay/school/tags defaults; openTenant hardened; row keys fall back to id | `2026-05-02a` |
| 2026-05-19 | Current tenants rows in property panel now clickable | `2026-05-02b` |

---

## Known issues / open items

- **Promote Denisse to Admin** — the Edit Member modal doesn't let Aldo
  change roles. Needs a role dropdown wiring fix.
- **Hydrate doesn't sync cross-device for non-admin deletes** — by design
  (RLS blocks). To make a delete persist on another device, an admin
  needs to re-run it OR RLS needs relaxing.
- **Delete options for other entities** — only Delete property currently
  has the admin gate removed. Delete tenant / landlord / homestay client /
  deposit still hide for non-admins. Easy follow-up if requested.
- **Tenant search bar previously had a regression** where one bad record
  with undefined fields would throw and freeze the chip rendering after
  the first character. Fixed with `lc()` null-safe helper. Same kind of
  bug could appear elsewhere — when a renderer references many tenant
  fields, wrap in null-safe access or defensive defaults.

---

## How Aldo communicates

- Mix of Spanish + English (mostly Spanish for bug reports, English for
  feature requests).
- Sends screenshots to show issues.
- Concise — short messages, expects me to dig in and fix.
- Wants verification: "haz un test ya que lo arregles y confirma que sí
  funciona" — when I fix something, I should browser-test it end-to-end
  before reporting back.
