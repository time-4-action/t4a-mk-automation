# Design Guide — t4a-mk-automation & the t4a-admin UI

Two halves of one system, documented together:

- **Part I — this repo (`t4a-mk-automation`)**: the headless sync engine, its HTTP
  API, data model, sync algorithms and its own small built-in dashboards.
- **Part II — `../t4a-admin`**: the Next.js admin portal, its design system and
  every screen it offers.
- **Part III**: how the two meet — which endpoint drives which screen.

Read Part I if you are changing the engine, Part II if you are changing the UI,
Part III if you are changing the contract between them.

---
---

# Part I — t4a-mk-automation (the engine)

## 1. What it is

A single-process **Node 24 / Express 5** service that bridges **two Metakocka
companies**:

```
T4A (source of truth)  ──────────────►  CREAGLOBE (mirror)
        warehouse stock · products · customers · prices
```

Everything is **one-way**. T4A is never written to. The service runs four
independent syncs on their own cron schedules, records every run, and exposes an
API so an external admin (t4a-admin) can watch and drive it.

| Sync | Direction | What moves |
|---|---|---|
| **Warehouse** | T4A warehouse → CREAGLOBE's matching *virtual* warehouse | Free (available-to-sell) stock per product code |
| **Products** | T4A → CREAGLOBE | Catalogue: create missing products, overwrite differing fields |
| **Customers** | T4A → CREAGLOBE | Partners (+ contacts and delivery addresses) |
| **Pricelists** | T4A → CREAGLOBE | Product prices, for explicitly mapped list pairs only |

There is no framework, no ORM and no build step: `index.js` is the whole server, with the
three more complex syncs factored into `src/services/productSyncService.js`,
`src/services/customerSyncService.js` and `src/services/pricelistSyncService.js`.

**Retired:** the ProMode / Germany warehouse CSV feed (July 2026). Warehouse sync
is now T4A-only. The code is *disabled, not deleted* — see
`docs/deprecated_promode_warehouse_sync.md` for how to revive it.

## 2. Layout

```
index.js                       Express app, routes, cron wiring, warehouse sync, run tracking
cron.js                        loadCronExpression(job) — reads cron.json
config/config.json             Metakocka base URL + endpoint paths, ProMode CSV URL
src/services/
  productSyncService.js        catalogue diff + push (one-way merge)
  customerSyncService.js       partner matching, payload building, push
  pricelistSyncService.js      price-list discovery, mapping-driven price push
public/                        the service's own tiny web dashboards (see §8)
db/patrik.db                   SQLite (run history + per-sync logs)
tmp/                           timestamped JSON result files, served at /data
docs/                          Metakocka API reference + this project's own notes
cron.json                      the live schedules (mutable at runtime)
```

## 3. Boot sequence

`index.js` at startup:

1. Opens SQLite (`DB_FILE_PATH`, default `./db/patrik.db`) and `CREATE TABLE IF
   NOT EXISTS` for every table (§5), plus tolerated `ALTER TABLE` back-fills of
   `sync_runs.details` and `pricelist_map.max_change_pct`.
2. Reads `cron.json` and **starts all four cron jobs immediately**
   (`startOrUpdateWarehousesCron` / `…Products…` / `…Customers…` / `…Pricelists…`).
   Defaults if a key is missing: products `0 * * * *`, customers `0 */6 * * *`,
   pricelists `0 4 * * *`.
   *This matters:* product sync used to only be scheduled when its `PUT` schedule
   endpoint was hit, so a plain restart silently stopped it.
3. Loads `API_KEY` and logs — masked — whether it is present. Without it every
   authenticated request 401s.
4. Serves `/data` (the JSON result files) and `/` (the `public/` dashboards) as
   static, then listens on **port 3000**.

Current shipped schedules (`cron.json`):

```json
{
  "warehouseSync": "0 2-23/3 * * 4",              // every 3h, 02:00–23:00, Thursdays
  "productSync":   "0-59/15 * * * 1,2,3,4,5,6,0", // every 15 min, every day
  "customerSync":  "0 */6 * * *",                 // every 6 hours
  "pricelistSync": "0 4 * * *"                    // daily at 04:00
}
```

## 4. HTTP API

Base: `http://<host>:3000`. Auth is a single shared secret in a header:

```
x-api-key: <API_KEY>
```

`authenticate()` logs *why* a request failed (missing header / mismatch / no key
configured) with masked values, so 401s are diagnosable without leaking the key.

### 4.1 Endpoints

| Method | Path | Auth | Purpose |
|---|---|:--:|---|
| `GET` | `/api/v1/uptime` | — | Health check |
| `GET` | `/api/v1/status` | ✅ | **Combined status of all four syncs** — the admin's main read |
| `GET` | `/api/v1/runs` | ✅ | Run history — `?type=warehouse\|products\|customers\|pricelists`, `?limit=` (default 20, max 100) |
| `POST` | `/api/v1/warehouse/sync` | ✅ | Start a warehouse sync — **202** `{started,runId}`, **409** if already running |
| `GET` | `/api/v1/warehouse/sync/logs` | — | Last N rows of `warehouse_sync_log` (JSON file links) |
| `PUT` | `/api/v1/schedules/warehouse-sync` | ✅ | Set the warehouse cron expression |
| `GET` | `/api/v1/schedules/warehouse-sync` | — | Read the warehouse cron expression |
| `POST` | `/api/v1/products/sync` | ✅ | Start a product sync — 202 / 409 |
| `GET` | `/api/v1/products/sync/logs` | — | Last N rows of `product_sync_log` |
| `PUT` | `/api/v1/schedules/product-sync` | ✅ | Set the product cron expression |
| `GET` | `/api/v1/schedules/product-sync` | — | Read the product cron expression |
| `POST` | `/api/v1/customers/sync` | ✅ | Start a customer sync. **`?dryRun=true`** computes the plan without writing — 202 / 409 |
| `GET` | `/api/v1/customers/sync/logs` | — | Last N rows of `customer_sync_log` |
| `PUT` | `/api/v1/schedules/customer-sync` | ✅ | Set the customer cron expression |
| `GET` | `/api/v1/schedules/customer-sync` | — | Read the customer cron expression |
| `GET` | `/api/v1/pricelists` | ✅ | Price lists discovered in both companies + title suggestions + saved mappings (`?refresh=true` bypasses a 5-min cache) |
| `GET` | `/api/v1/pricelists/mappings` | ✅ | The saved source→target price-list pairs |
| `PUT` | `/api/v1/pricelists/mappings` | ✅ | Replace the whole mapping set in one transaction |
| `POST` | `/api/v1/pricelists/sync` | ✅ | Start a pricelist sync. **`?dryRun=true`** resolves the plan without writing — 202 / 409 |
| `GET` | `/api/v1/pricelists/sync/logs` | — | Last N rows of `pricelist_sync_log` |
| `PUT` | `/api/v1/schedules/pricelist-sync` | ✅ | Set the pricelist cron expression |
| `GET` | `/api/v1/schedules/pricelist-sync` | — | Read the pricelist cron expression |
| `GET` | `/data/*` | — | Static: the timestamped JSON result files |
| `GET` | `/`, `/warehouse-sync`, `/products-sync`, `/customers-sync`, `/pricelists-sync`, `…/notes` | — | Static: the built-in dashboards |

Note the deliberate asymmetry: **reads of a schedule and of the per-sync logs are
open; every write and the aggregate status/history are keyed.** The dashboards in
`public/` rely on that — they render without a key and only ask for one when you
press an action button.

### 4.2 `GET /api/v1/status`

The contract the admin's Automation section is built on:

```jsonc
{
  "warehouse": {
    "schedule": "0 2-23/3 * * 4",
    "nextRun":  "2026-09-03T02:00:00.000Z",   // computed with cron-parser; null if unparseable
    "isRunning": false,                        // in-process guard, not a DB read
    "lastRun": { /* a sync_runs row, or null */ }
  },
  "products":  { … },
  "customers": { … },
  "pricelists": {
    …,
    "mappingCount": 11    // enabled price-list pairs; 0 means a run would do nothing
  }
}
```

### 4.3 Run endpoints are asynchronous

Every `POST …/sync` returns **immediately**:

- `202 { started: true, runId }` — a `sync_runs` row is inserted as `running` and
  the work continues in a detached async IIFE.
- `409 { started: false, reason: "already_running" }` — the in-process guard
  (`WAREHOUSE_RUNNING` / `PRODUCT_RUNNING` / `CUSTOMER_RUNNING`) blocks a manual
  run from overlapping a scheduled one, or itself.

Clients therefore **poll** `/status` (the admin does, every 4s) until
`isRunning` clears, then read `lastRun` or `/runs`.

### 4.4 Schedule writes

`PUT /api/v1/schedules/<sync>` takes `{ "cronExpression": "…" }`, validates it
with `cron-validator`, persists it into `cron.json` (`CRON_FILE_PATH`), and
re-arms the live `node-cron` job in place. Invalid expressions are rejected
before anything is written.

## 5. Data model (SQLite, `better-sqlite3`)

| Table | Row = | Columns |
|---|---|---|
| `sync_runs` | **one run of any sync** — the unified history | `id`, `type` (`warehouse\|products\|customers`), `trigger` (`manual\|schedule`), `status` (`running\|ok\|error`), `item_count`, `error`, `details` (JSON), `started_at`, `finished_at`, `duration_ms` |
| `warehouse_sync_log` | one saved stock JSON file | `id`, `link`, `sync_name` (default `T4A`), `created_at` |
| `product_sync_log` | one product batch | `id`, `sync_name` (file), `status` (`new`/`updated`), `source_warehouse`, `target_warehouse`, `created_at` |
| `customer_sync_log` | one customer run's file | `id`, `sync_name`, `source_company`, `target_company`, `created`, `updated`, `created_at` |
| `pricelist_sync_log` | one pricelist run's file | `id`, `sync_name`, `source_company`, `target_company`, `added`, `updated`, `created_at` |
| `pricelist_map` | **one mapped price-list pair** | `id`, `source_code`, `source_sales_purchase`, `source_title`, `target_code`, `target_sales_purchase`, `target_title`, `enabled`, `allow_unseen_target`, `max_change_pct`, timestamps. Unique on `(source_sales_purchase, source_code)`. |

`sync_runs` exists because **node-cron exposes no last-run/next-run
information** — the service tracks it itself. `nextRun` is derived from the cron
expression via `cron-parser`; everything else comes from this table.

Timestamps are SQLite `CURRENT_TIMESTAMP`, i.e. `"YYYY-MM-DD HH:MM:SS"` in **UTC
without a zone marker**. Any consumer must normalise them to ISO before parsing
(the admin does this in `parseSqlDate`).

### 5.1 The `details` JSON

The richest part of the contract — it is what a run-details view renders.

**Warehouse:**
```jsonc
{ "type": "warehouse",
  "warehouses": [ { "source": "T4A", "target": "CREAGLOBE / T4A warehouse", "count": 1234 } ],
  "errorCount": 3,
  "errors": [ { "product_code": "ABC", "warehouse_id": "…", "message": "Product not found" } ] }  // capped at 50
```

**Products:**
```jsonc
{ "type": "products",
  "buckets": [ { "key": "changesCREAGLOBE", "count": 12 }, { "key": "newInCREAGLOBE", "count": 3 } ],
  "errorCount": 1,
  "errors": [ { "system": "…", "product_code": "…", "action": "…", "message": "…" } ] }
```

**Customers:**
```jsonc
{ "type": "customers", "dryRun": false,
  "counts":  { "source": 684, "target": 664, "matched": 578, "created": 12, "updated": 40, "skipped": 0 },
  "buckets": [ … ],
  "changeCount": 52, "changes": [ /* capped at 200 — full list is in the JSON file */ ],
  "errorCount": 0,  "errors":  [ /* capped at 50 */ ] }
```

**Pricelists:**
```jsonc
{ "type": "pricelists", "dryRun": false, "noMappings": false,
  "counts":  { "mappings": 11, "products": 184, "added": 977, "updated": 350,
               "unchanged": 8479, "blocked": 463, "extra": 2749, "skippedMissingProduct": 0 },
  "perList": [ { "source": {…}, "target": {…}, "added": 175, "updated": 0, "unchanged": 743,
                 "blocked": 13, "extra": 1, "skippedMissingProduct": 0, "skipped": null } ],
  "buckets": [ … ],
  "changeCount": 1790, "changes": [ /* capped at 200; action add|update|blocked */ ],
  "errorCount": 0,     "errors":  [ /* capped at 50 */ ] }
```

**Partial failure is a first-class outcome.** A run whose transport succeeded but
whose per-item error list is non-empty is stored as `status: "error"` with a
message like `3 product(s) failed to sync` — never as a clean run.

## 6. The four syncs

### 6.1 Warehouse (`warehousesSync()` in `index.js`)

1. **Paginate** `warehouse_stock` for `MK_T4A_WAREHOUSE_ID` at 1000/page until a
   short page. *Required:* without paging, SKUs beyond page 1 are absent from the
   payload and Metakocka **zeroes their stock** in CREAGLOBE.
2. **Fold rows per product code.** Metakocka returns *multiple rows per product*
   (one per serial number or microlocation). `amount` is a slice of the physical
   stock; `reserved_amount` and `free_amount` **repeat the product-level totals on
   every row**. So:
   - physical = **sum** of `amount` across rows
   - reserved = the repeated value taken **once** (via `max`)
   - free = physical − reserved

   Summing `free_amount` is wrong: 9 serial rows of `{amount:1, reserved:5,
   free:-4}` are physical 9, reserved 5, free 4 — not −36.
   Amounts arrive as strings that may use a comma decimal (`"857,75"`), hence
   `parseNumber()`; `Number("857,75")` is `NaN`.
   Match key is `code`, falling back to `count_code` so nothing is dropped.
3. **Push** `sync_stock` into CREAGLOBE. Negative stock is kept intentionally.
4. **Check twice:** the envelope `opr_code === "0"` *and* the per-product
   `error_list`. The latter (product not found, warehouse not found) is the usual
   reason "stock doesn't match" — it is captured, not swallowed.
5. Heartbeat + save the payload as a JSON file.

Each source warehouse writes into **its own matching virtual warehouse** in
CREAGLOBE. Stock is never merged across warehouses.

### 6.2 Products (`productSyncService.js`)

`listProducts` (paginated) from both companies → `formatProductList` normalises
(including flattening the category tree) → `generateSmartMerge` diffs with
`deepEqualIgnoreCaseUnordered` (case-insensitive strings, order-agnostic arrays)
→ `updateProducts` / `addProducts` against CREAGLOBE only.

- Keyed on the product `code`, which **both companies share**.
- `changesA` / `newInA` are always empty **by design** — the return shape from
  the old two-way merge is kept, but nothing ever flows back to T4A.
- Deliberately **not** overwritten on an existing CREAGLOBE product: `sales`,
  `service`, `purchasing`, and `code`/`count_code`.
- Deltas are written to `./delta` for inspection.

### 6.3 Customers (`customerSyncService.js`)

The hard one, because **partners share no key across companies**: `count_code`
and `mk_id` are per-company internals with *measured 0 overlap*.

- **Two-tier match** (`findMatch`): normalised **tax number** first, exact
  normalised **name** as fallback (≈380 T4A buyers are tax-less consumers).
  `buildMatchIndex` is first-writer-wins so matching is deterministic; a
  `createdKeys` guard stops one run creating the same customer twice.
  *Accepted risk:* two different tax-less customers with the same name collapse
  into one — which is exactly why the dry run exists.
- **Nested data by content signature.** Contacts (`name+email+phone`) and
  addresses (`type+street+post+city`) also have per-company mk_ids, so they are
  matched by signature: the billing address is updated in place, missing
  contacts/addresses are appended. Without this, a blank mk_id would make
  `update_partner` append a fresh duplicate **on every run**.
- `buildUpdatePayload` returns `null` when nothing differs, so no-op writes are
  never fired; `summarizeUpdatePayload` produces the human-readable "what changed
  where" lines the admin shows.
- `add_partner` documents only one contact + one delivery address, so the rest
  are appended afterwards via `buildAppendNestedPayload`.
- **`dryRun`** resolves the entire plan and records a normal run row (badged
  `dryRun: true`) while writing nothing to CREAGLOBE and skipping the JSON file.

### 6.4 Pricelists (`pricelistSyncService.js`)

The one sync that **refuses to guess**. Full survey in `docs/pricelist_sync.md`.

- **No endpoint lists price lists.** They are derived from `product_list` with
  `return_pricelist` — every product reports the lists it sits on. A list with no products
  on it is therefore invisible, and indistinguishable from one that does not exist.
- **`count_code` does not identify a list across companies.** Live data: T4A `7` is
  "PP GOLD 2026", CREAGLOBE `7` is "PP BRONZE 2026". Nine codes overlap; every pairing is
  wrong. Nor is it unique *within* a company — sales and purchase lists are numbered
  separately, so identity is `(sales_purchase, count_code)`.
- Therefore **only pairs saved in `pricelist_map` are synced.** Exact-title matching (13/13
  live) suggests pairs in the UI; it never applies one.
- Products join on `code` (1555/1555) and are addressed for writing by CREAGLOBE's own
  `count_code`, like product sync. Updates are grouped one call per product.
- Fields **mirror T4A without destroying**: the payload is CREAGLOBE's current `price_def`
  overlaid with T4A's fields, so CREAGLOBE-only fields survive a wholesale row replace, and
  change detection ignores them so they never cause churn.
- **VAT is mirrored 1:1, and a `tax` is mandatory on write.** Metakocka's error claims the
  value is invalid but actually fires when the field is *absent* (established by experiment —
  see `docs/pricelist_sync.md`). T4A leaves VAT blank on RRP 2026 and every PP 2026 list, so
  `resolveTax()` writes `000` (0%) for a blank one and CREAGLOBE's own tax is never consulted.
  `taxStateOf()` treats blank and `000` as equal so the equivalence causes no churn.
- Two rails: a mapping to an **unseen target** is refused unless it opts in, and a per-pair
  **`max_change_pct`** refuses (and reports) any single price moving further than allowed —
  the guard that caught CREAGLOBE's "RRP 2025" holding gross where T4A holds net (×1.22,
  1093 rows).

## 7. Side effects & observability

- **JSON result files** → `PUBLIC_DATA_FILE_PATH` (default `./tmp`), named
  `{TIMESTAMP}_{SOURCE}.json`, served publicly under `/data`, and linked from
  `warehouse_sync_log`.
- **BetterStack heartbeats** (`warehousesSyncHeartBeat`): success pings the base
  URL, failure pings `base + /fail`. Per-item errors are *not* a failure
  heartbeat — the sync call itself succeeded; they are recorded in the run row.
- **Structured console logging**: every request, every auth decision (with masked
  secrets), and run start/finish lines with a `✅/❌` icon, item count and
  duration.
- Google Drive log upload exists but is **commented out** (too slow); rate
  limiting is likewise present but disabled.

## 8. The built-in dashboards (`public/`)

The service ships its own no-build, no-dependency HTML/CSS/JS UI — a fallback
that works even when the admin portal is down. Deliberately utilitarian: dark
background, Orbitron display font, plain buttons.

| Page | Path | What it does |
|---|---|---|
| Hub | `/` | "Time 4 Action - Metakocka Automation" — three cards linking to the sync pages, plus links to the per-sync notes pages |
| Warehouse Sync | `/warehouse-sync` | Interval + days grid → generated cron, API-key box, **Update Schedule / Clear All / Run Now**, and a job-scheduler log table |
| Products Sync | `/products-sync` | Same |
| Customers Sync | `/customers-sync` | Same, plus a **Preview (Dry Run)** button |
| Pricelists Sync | `/pricelists-sync` | Same, plus **Preview (Dry Run)** and a read-only view of the mapping and of both companies' price lists |
| Notes | `/products-sync/notes`, `/warehouse-sync/notes`, `/customers-sync/notes`, `/pricelists-sync/notes` | Static explanations of what each sync does |

Interaction shape: pick interval + days → a cron expression is generated and
shown in a `<pre>` → paste the API key → press the action. The key is typed per
action and never stored. Logs come from the **unauthenticated** `…/sync/logs`
endpoints, which is why the page renders before any key is entered.

**These pages are the low-fidelity twin of the admin's Automation section.** The
admin covers the same three actions with far more context (status pills, next/last
run, run details with per-item errors, plain-English schedules). Keep both working:
when you add a sync, add both a `public/<name>-sync/` page here and a page in the
admin.

## 9. Configuration & deployment

Environment (`.env`, or `ENV_FILE_PATH`):

```ini
API_KEY=                                # the x-api-key shared secret
MK_SECRET_KEY_T4A=  MK_COMPANY_ID_T4A=  MK_T4A_WAREHOUSE_ID=
MK_SECRET_KEY_CREAGLOBE=  MK_COMPANY_ID_CREAGLOBE=
MK_CREAGLOBE_WAREHOUSE_ID_T4A=  MK_CREAGLOBE_WAREHOUSE_ID_GERMANY_ONE=   # Germany: retired
BETTER_STACK_WH_SYNC_HEARTBEAT=
```

Path overrides (set by the Dockerfile, all pointing into one mounted volume):
`ENV_FILE_PATH`, `CRON_FILE_PATH`, `DB_FILE_PATH`, `PUBLIC_DATA_FILE_PATH`.

`config/config.json` holds the non-secret Metakocka base URL and operation paths
(`warehouse_stock`, `sync_stock`, `product_list/add/update`,
`get/add/update_partner`), the Google Drive macro URLs and the ProMode CSV URL.

Run: `npm run dev` / `npm start` (port 3000). Docker: `node:24-alpine`, all
mutable state on `/data`. CI (`.github/workflows/deploy.yml`) builds
`ghcr.io/time-4-action/t4a-mk-automation` on every push to `main` and rolls it
out to the VM; see `docs/deployment.md`.

`docs/` carries the Metakocka REST reference (partners, products, documents,
warehouse stock, reports…) plus this project's own notes: `customer_sync.md`,
`deprecated_promode_warehouse_sync.md`, `warehouse_stock_sync.md`.

## 10. Rules to keep when changing the engine

- **One-way, always.** T4A is never written to. Any code path that could write
  back is a bug.
- **Page every list endpoint.** Metakocka caps at 1000; a missed page silently
  zeroes data.
- **Never trust `opr_code` alone** — check the per-item `error_list` too, and
  record it.
- **Parse numbers with `parseNumber`** — comma decimals are normal.
- **Match nested data by content signature**, never by mk_id, across companies.
- **A run row for everything**, scheduled or manual, with `details` filled in —
  it is the only history the admin can show.
- Keep `202`/`409` semantics on run endpoints; keep the in-process guards.
- Adding a sync means: a runner + guard, `startOrUpdate<X>Cron`, a `cron.json`
  key with a default, a `sync_runs` type, its three routes (`POST run`,
  `GET logs`, `GET/PUT schedule`), a `/status` block, a `public/` page, and an
  admin page.

---
---

# Part II — the t4a-admin UI (`../t4a-admin`)

## 11. What that app is

One Next.js 16 (App Router) application serving **two audiences from one
codebase**:

| Face | Who | Route space | Shell |
|---|---|---|---|
| **Admin portal** | Staff holding an Auth0 admin role | everything except `/portal/*` | Full sectioned sidebar (`components/nav.tsx`) |
| **B2B customer portal** | Any authenticated customer (holds **no role**) | `/portal/*` | Stripped-down "Time 4 Action B2B" sidebar (`components/portal-nav.tsx`) |

`components/app-shell.tsx` picks the shell by pathname; `middleware.ts` →
`lib/proxy.ts` guarantees only the right people reach each space (a logged-in
non-admin who hits an admin route lands on `/portal`, not on `/forbidden`).

The admin is **modular**: nine sections, each gated by its own Auth0 role, each a
surface over a different backend — Auth0, MongoDB, the raw Metakocka REST API,
the warranty service, the partner portal, and **this repo**. A user only sees the
sections they hold a role for; the nav, the home page and the server-side route
gate all read one table (`SECTION_ROLES` in `lib/access.ts`).

## 12. Layout architecture

### 12.1 The frame

`app/layout.tsx` sets up a **fixed, non-scrolling body**:

```
<body class="flex h-screen overflow-hidden">
  <Nav | PortalNav />                              ← fixed-width sidebar, own scroll
  <main class="flex-1 min-w-0 overflow-hidden">    ← the page owns its scrolling
```

Every page follows the same internal skeleton:

```jsx
<div className="flex flex-col h-full">
  <header className="h-14 border-b border-border … sticky top-0 z-10">…</header>
  <div className="flex-1 overflow-y-auto p-4 md:p-8">…</div>
</div>
```

**The most important layout convention in the app**: the header never scrolls
away, only the content region scrolls, each section owns its scroll context.
Detail views that need a sidebar use a two-column grid inside that region.

Providers: `ThemeProvider` (light/dark/system) → `CurrencyProvider` (USD/EUR
display) → `AppShell`.

### 12.2 The admin sidebar

- **Desktop:** 220px expanded / 60px collapsed rail. Collapsed drops group
  headers, showing icon-only links with tooltips.
- **Mobile (<768px):** 48px top bar + hamburger → a 260px drawer over a blurred
  scrim; body scroll locks, drawer closes on navigation.
- **Accordion groups**, open state persisted in
  `localStorage["t4a-nav-open-sections"]`; navigating into a section opens it.
- **Section identity:** a coloured icon chip per group (`SECTION_STYLE`), the same
  hue that section uses on the home page.
- **Active link:** `bg-muted` + `font-medium` + a 3px brand rail on the left.
  `isLinkActive()` cedes to the more specific sibling, so `/automation` isn't lit
  while on `/automation/warehouse`.
- **Footer:** theme toggle → Settings (super-admin) → user card with logout.
- `superAdminOnly` links (every `*/access` page) are hidden for non-super-admins
  *and* blocked server-side.

### 12.3 The portal sidebar

Same geometry, reduced: brand, five flat links (Preorders, Invoices, Offers,
Orders, My Account), theme toggle, user card. Teal accent.

### 12.4 The home page

A server component greeting the user by first name, rendering **one panel per
section they can see** in a 2-column grid: coloured header (icon chip, label,
count pill) over a divided list of link rows with a hover chevron. Panels stagger
in with `.reveal` (`50ms × index`).

## 13. The design system

### 13.1 Tokens (`app/globals.css`)

Tailwind v4 with `@theme inline`; every colour is an **OKLCH custom property** on
`:root`, overridden under `.dark`.

| Token | Light | Role |
|---|---|---|
| `--background` | `oklch(0.985 0.003 80)` | Page ground — warm off-white, "paper, not clinical" |
| `--surface` / `--card` | white | Raised panels, cards, tables |
| `--foreground` | `oklch(0.208 0.042 264)` | Near-black with a blue cast |
| `--muted` / `--muted-foreground` | warm grey | Secondary fills / text |
| `--accent-brand` | `oklch(0.48 0.10 200)` | Teal-cyan brand accent (active rails, focus ring) |
| `--destructive` | red | Danger |
| `--border` / `--input` | `oklch(0.91 0.005 80)` | Hairlines (dark: `white/10`, `white/15`) |
| `--chart-1…5` | — | Recharts palette, theme-swapped |
| `--radius` | `0.625rem` | Base radius; `sm…4xl` derive from it |

Dark mode is a **cool near-black** (`oklch(0.155 0.008 240)` ground), not an
inversion of the warm light theme.

**No-flash theming:** an inline `<head>` script reads `localStorage["theme"]` and
applies `.dark` + `color-scheme` **before paint**; `lib/theme-context.tsx` catches
up on mount and live-follows the OS in `system` mode.

### 13.2 Typography

**Geist Sans** everywhere, **Geist Mono** for codes/SKUs/model ids.
`.font-display` maps to the same sans stack — it marks intent, not a family.
Deliberately small and dense:

- Page title `font-display text-lg font-medium tracking-tight` · hero
  `text-2xl md:text-3xl font-semibold` · card title `text-[13px] font-semibold`
- Body/cells `text-[12px]`–`text-[13px]` · meta `text-[11px]`/`text-[10px]`
- **Eyebrow labels** — `text-[10px] font-semibold uppercase tracking-wider
  text-muted-foreground` — every table header, KPI label and card section label
- `tabular-nums` on all numbers; big counts abbreviate (`1.2K`, `3.4M`)

### 13.3 Section colours

| Section | Hue | Icon |
|---|---|---|
| General (Users) | sky | Folder |
| Access | violet | KeyRound |
| AI | emerald | Sparkles |
| Warranty | amber | Wrench |
| Partners | indigo | Handshake |
| **Automation** | **rose** | **Zap** |
| Builder | blue | Blocks |
| Documents | teal | FileText |
| Preorder | lime | ShoppingCart |
| System | slate | Cog |

Pattern: `bg-<hue>-500/10` chip + `text-<hue>-500` icon. `AccessAccent` in
`components/access-manager.tsx` stores **full literal class strings per accent** —
Tailwind can't see interpolated names, so runtime-chosen colours are never
concatenated.

### 13.4 Shape, elevation, spacing

`rounded-xl` cards/inputs, `rounded-2xl` large panels/modals, `rounded-full`
pills. **Elevation is borders, not shadows** (`border border-border` on
`bg-surface`); real shadows only for popovers and modals. Lists use
`divide-y divide-border/50`. Page padding `p-4 md:p-8`, content capped at
`max-w-2xl`/`3xl`/`5xl` or full-width for tables and builders.

### 13.5 Motion

1. **`.skeleton`** — 1.6s shimmer, theme-aware. *Never "Loading…" text.*
   Skeletons mirror the real layout and stagger by `i * 80ms`.
2. **`.reveal`** — 0.4s fade + 4px rise on page load, `i * 40ms`.
3. **Micro-transitions** — `transition-colors` / `duration-150` everywhere.

All three respect `prefers-reduced-motion`. Busy buttons show a spinning
`Loader2` and are `disabled`.

### 13.6 Components

shadcn/ui (New York) on Radix, kept thin: `button` (6 variants × 8 sizes),
`card`, `badge`, `input`, `select`, `table`, `dialog`, `date-picker`, with `cn()`
merging classes. Richer controls are built **locally per section** rather than
growing the kit (the builder's portalled Select and slider-number field, preorder's
steppers and pill status pickers, AI Usage's header multi-select).

Shared feature components: `access-manager` (the one grant/revoke screen, reused
by all six `*/access` pages), `change-log-modal` (save-with-audit diff preview),
`audit-history` (self-fetching timeline), the user dialogs, `theme-toggle`.

## 14. Recurring interaction patterns

- **Page header bar** — `h-14`, hairline, `bg-background/80 backdrop-blur-sm`,
  sticky; title (+ status pill) left, filters and primary action right.
- **List → detail** — dense bordered table, uppercase micro headers, clickable
  rows → hero header + main column + sidebar of action cards.
- **Filter strips** — warranty's connected segmented status bar (each segment is
  a live count *and* the filter); AI Usage's multi-select mounted on a table
  header, portalled so `overflow-hidden` can't clip it.
- **Summary tiles** — a 2/3/5-column grid of bordered tiles, eyebrow label +
  `tabular-nums` value.
- **Two save models:** *autosave* (~900ms debounce + flush on `beforeunload`) for
  the preorder builder and submission review; *explicit save via
  `ChangeLogModal`* where the write must be auditable (warranty workflow and
  email settings).
- **Destructive actions** are two-step or dialog-gated; rare actions hide behind
  a `MoreMenu`.
- **Async jobs** — 202 then poll every 4s, then a run-details modal.
- **localStorage** holds theme, nav accordion state, the selected Documents
  customer (`mk_customer_v1`), the Saved Builds grid/list toggle.
- **Empty states** — dashed panel, muted icon, one sentence, the action that
  fills it.

## 15. The sections, screen by screen

### 15.1 General — Users (sky)

`/users` — table of every non-dev Auth0 user: avatar + identity, spend, AI-access
toggle, role chips, spending limit; header search and "New User"; per-row dialogs
for limit, roles, edit, delete. `/users/new` — name, username, email, password.
`/users/[id]` — hero header, "Usage by model" and "Conversations" cards, and a
sidebar **Access** block with drag-and-drop role assignment (`@dnd-kit`).

### 15.2 Access (violet)

Auth0 roles are called **access types** in the UI.
`/roles` — access types with inline permissions; a gear opens a searchable scope
editor with select-all, diffed against originals. `/roles/assign` — one user
selected gives a drag-and-drop two-column UI; several selected gives a batch view
with `X/Y users` badges and Grant all / Remove all, saved in parallel; sensitive
grants need a toggle-switch confirmation. `/roles/scopes` — searchable scope
reference with a detail panel. `/roles/new`. `/roles/super-admins` —
`AccessManager` over the built-in `admin` role.

### 15.3 AI (emerald)

`/ai/dashboard` — three KPI cards, a **Cost by user** bar chart whose bars link to
the user page, a **Cost by model** donut with a colour-keyed legend; Recharts
wired to `var(--chart-*)`; skeletons reproduce the chart geometry.
`/ai/usage` — the token-level table (convos, input, output, cache read, cache
create, cost) with sortable numeric columns, an email filter, a header-mounted
model multi-select, a 5-tile summary strip and a sticky totals row.
`/ai/access` — `AccessManager` with a "may incur costs" acknowledgement.

### 15.4 Warranty (amber)

Surface over the patrik-warranty-form service, proxied server-side.
`/warranty` — searchable claims table under a **connected segmented status bar**
(each segment a live count and the filter), inline assignee picker.
`/warranty/[id]` — the claim, file thumbnails, and the **Workflow card**: an SVG
pipeline flowchart (Open → In review → Decided, forking into "To send new
product → Finished" or "Rejected") over six staged fields. Not autosaved — Save
opens `ChangeLogModal` with the full diff; below it an audit timeline and notes.
`/warranty/settings` — recipients chip input, subjects/intro/outro, per-field
toggles, live subject preview, same audited save.
Assignees come from Auth0 (`warranty-admin` holders), stored as display names so
removed people still render.

### 15.5 Partners (indigo)

Surface over the t4a-partner-portal admin API. `/partners` — partners joined with
portal activity (Shopify, exports, feeds, last active). `/partners/[sub]` —
insight cards, "most interacted with", activity timeline, internal notes.
`/partners/sync` — the portal's own schedulers: status cards, catalogue run
history, partner supplier feeds, Run now per pipeline and per feed, polling while
in flight. `/partners/access` — manages *who is a partner*.

### 15.6 Automation (rose) — **this repo's UI**

See Part III for the full mapping. Five pages, all rendering from one shared
module `app/automation/automation-shared.tsx` (`SyncCard`, `CronEditorModal`,
`RunDetailsModal`, `RunHistoryTable`, `useAutomation()`, `SingleSyncPage`):

- `/automation` — prose explaining all four syncs, a rolled-up status pill, a
  Refresh button, and the **combined** run history.
- `/automation/warehouse`, `/automation/products`, `/automation/customers`,
  `/automation/pricelists` — one sync each: its card, a "How it works" panel written
  in plain English, and a scoped run history. Customers and Pricelists add
  **Preview (dry run)**, badged `DRY RUN` wherever such a run appears.
- `/automation/access` — `AccessManager` (rose), super-admin only.

Run-history columns are deliberately plain-language: **When / What / How /
Outcome / Took / Items**.

**Pricelists carries an extra surface: the mapping editor**
(`app/automation/pricelists/mapping-editor.tsx`), rendered through `SingleSyncPage`'s
`extra` slot. A table of source→target pairs: each side is a picker over that company's
discovered lists **with a manual code-entry escape hatch** (an empty list is invisible to
the scan yet still addressable), plus a **max change %** box, an enable switch and a
remove button. It refuses to be quiet about the trap — a standing amber panel states the
GOLD/BRONZE collision, a row whose two titles disagree warns inline, and a target the scan
did not see demands an explicit "write anyway" tick. **Suggest by title** fills pairs in
bulk but still requires a deliberate Save. Below the table, both companies' price lists sit
side by side — the answer to "show me what each system actually has". Its run details break
the run down per list and per product (added / updated / blocked / extra).

### 15.7 Builder (blue)

A fully client-side generator of copyable HTML snippets for the marketing site.
`/builder/saved` (shared team builds with live scale-to-fit thumbnails),
`/builder/saved/[id]` (preview, rename, notes, version timeline with
preview/restore), the hub, `/builder/radar-chart`, `/builder/range-bars`, and
`/builder/layout` (rows-and-blocks composer with `@dnd-kit`). Every builder
renders through `BuilderShell`: controls left, **live preview** + syntax-highlighted
**HTML snippet** right, with a viewport-width switcher.
Two rules: the preview runs the **real** hosted renderer (`patrik-components.js`
bundled verbatim), and in the composer **a chart block *is* a saved build** — the
composer arranges, it never edits.

### 15.8 Documents (teal)

Admin browsing of any customer's Metakocka documents:
`/documents/{customer,invoices,offers,orders}` plus `/documents/{kind}/[mkId]`.
A **customer switcher** sits in the page header on all of them — searchable,
debounced, persisted to `localStorage["mk_customer_v1"]` so the choice follows
you across pages and reloads, defaulting to the partner matching the admin's own
email. `documents-shared.tsx` provides payment badges, an online-order badge
(webshop orders carry a trailing slash in their MK number), order-status pills, an
invoice summary strip, and a detail view with SKU-resolved product thumbnails,
lightbox, totals, payment panel, related documents and sanitized MK HTML notes.

*(Note: `CLAUDE.md` still describes the older `/documents/[partnerMkId]/…` shape.)*

### 15.9 Preorder (lime)

The largest section. `/preorder` — campaigns with status pills (draft/open/closed)
and a magic invite link. `/preorder/[id]` — KPIs and submissions.
`/preorder/[id]/edit` — the sheet builder: draggable tab rail, product groups,
variant rows, Metakocka price-list-fed RRP/partner-price columns, per-tab volume
discount tiers, **autosaved**. `/preorder/[id]/preview` — the exact partner
experience; pick a partner and an admin can submit on their behalf.
`/preorder/[id]/submissions/[id]` — per-line confirmed-quantity steppers and
status pickers, live totals against the *saved* lines, push to Metakocka as a
sales order, unlock, delete.
`preorder-shared.tsx` renders the fill experience for both the partner portal and
the admin, in two modes: **Grid** (spreadsheet) and **Guided** (Shopify-like cards
with a product modal), with tier banners, a live summary panel and a
review-before-submit modal.

*(Not documented in `CLAUDE.md` at all.)*

### 15.10 System

`/settings` — a single Display group with a **USD / EUR** segmented toggle. Costs
are stored in USD and converted at display time.

## 16. The customer portal (`/portal/*`)

Customers log in passwordless (Auth0 OTP), hold no role, and are matched to a
Metakocka partner by email server-side. Design mirrors the admin document pages
1:1. Pages: Preorders (invited campaigns + own submission status), the fill
experience (**locked once submitted** — view-only, showing ordered vs. confirmed
with amber where they differ, with an unlock request), invite redemption
(`/portal/preorders/join/[token]`), Invoices/Offers/Orders + detail with PDF
(**ownership re-checked server-side on every detail and PDF fetch**), My Account,
and a friendly `no-account` state.

## 17. Access, empty and error states

`/forbidden` and `/unauthorized` have their own minimal layouts. A missing role
hides a section from the nav *and* the home page, and the middleware blocks the
route regardless — UI hiding is never the security boundary. Every `*/access`
page maps to the admin-only `system` section. Errors render inline as a coloured
`role="alert"` strip (amber degraded, rose failed action), never a blocking
dialog.

## 18. Accessibility & responsiveness

Visible focus everywhere (`focus-visible:ring-2 ring-ring`); `aria-current` on
nav links, `aria-expanded` on accordions, `role="radiogroup"` on the theme and
currency toggles, `aria-label` on icon-only buttons, `sr-only` labels beside lone
icons. Global cursor rules; native number spinners hidden in favour of custom
steppers. Responsiveness is `md`-driven: sidebar → drawer, `p-8 → p-4`, header
filters wrap to a second row, grids collapse, tables scroll in their own
container.

## 19. Adding to the admin UI

**New page in a section:** create `app/<section>/<page>/page.tsx` with the frame
from §12.1, add it to `sections` in `components/nav.tsx` (and optionally the home
cards), reuse the section hue and the table/card/skeleton patterns.

**New section:** add it to `SECTION_ROLES` and `ROUTE_RULES` in `lib/access.ts`
(put `/<section>/access` *before* the broader prefix), add a `SECTION_STYLE` entry
and nav group, add a home panel, proxy any external service server-side under
`app/api/<section>/*` so tokens never reach the browser, and add a thin
`AccessManager` page flagged `superAdminOnly`.

**Keep:** shimmer skeletons that mirror the layout, eyebrow labels, borders for
elevation, literal Tailwind classes for runtime colours, `ChangeLogModal` for
auditable writes, and both themes checked.

---
---

# Part III — how the two connect

## 20. The proxy layer

The admin never talks to this service from the browser. `lib/mk-api.ts`
(`callMkAutomation`) calls it **server-side** with the `x-api-key`, and the
routes under `app/api/automation/*` re-expose it — so `MK_API_TOKEN` never
reaches a client.

```
browser ──► /api/automation/*  (Next route, Auth0-gated)
                 │  server-side, adds x-api-key
                 ▼
        MK_API_BASE /api/v1/*   ← this repo
```

Admin env (both server-side secrets):

```
MK_API_BASE=https://<mk-automation host>
MK_API_TOKEN=<must equal this service's API_KEY>
```

These are distinct from the admin's `MK_SECRET_KEY` / `MK_COMPANY_ID`, which are
the *raw Metakocka* credentials used by the Documents module.

## 21. Endpoint → screen map

| This repo | Admin proxy | Screen |
|---|---|---|
| `GET /api/v1/status` + `GET /api/v1/runs?type=…` (per type, combined) | `GET /api/automation/status` | `useAutomation()` — feeds all four Automation pages |
| `PUT /api/v1/schedules/{warehouse,product,customer}-sync` | `PUT /api/automation/schedules/[type]` | `CronEditorModal` (presets + live `humanizeCron` preview) |
| `POST /api/v1/{warehouse,products,customers}/sync` (202 / 409) | `POST /api/automation/[type]/run` | **Run now** button → running pill → 4s polling |
| `POST /api/v1/customers/sync?dryRun=true` | same route, dry-run flag | **Preview (dry run)** on `/automation/customers` |
| `GET /api/v1/pricelists` | `GET /api/automation/pricelists` | The mapping editor's pickers, suggestions and the two reference columns |
| `GET`/`PUT` `/api/v1/pricelists/mappings` | `/api/automation/pricelists/mappings` | Loading and saving the mapping table |
| `POST /api/v1/pricelists/sync[?dryRun=true]` | `POST /api/automation/pricelists/run` | **Run now** / **Preview (dry run)** on `/automation/pricelists` |
| `sync_runs` rows | via `/status` + `/runs` | `RunHistoryTable` (When/What/How/Outcome/Took/Items) |
| `sync_runs.details` JSON | passthrough | `RunDetailsModal` — warehouses written, change buckets, customer change summaries, per-item error lists, `DRY RUN` badge |

Section gate: `SECTION_ROLES.automation = ["admin", "automation-admin"]`, with
`/automation` and `/api/automation` both in `ROUTE_RULES`.

## 22. Shared contract — what breaks the UI

Shapes are hand-mirrored in `types/automation.ts` on the admin side. Keep them in
sync by hand. In particular:

- **`type` values** (`warehouse` | `products` | `customers`) key the schedule
  routes, the run filter and the per-page slices.
- **Timestamps** are SQLite UTC strings without a zone; the admin's
  `parseSqlDate` normalises them to ISO. Change the format and every date in the
  Automation section shifts by the local offset.
- **`details` JSON** is the run-details view. A new field is additive and safe; a
  renamed one silently blanks a panel.
- **202 / 409** drive the button state machine. Returning 200 would make "Run
  now" look finished instantly.
- **`isRunning`** must be honest — it is the poll's stop condition.

When you add a sync to this repo, the admin needs: a `SingleSyncPage` at
`/automation/<name>`, a nav entry, a home card, an `itemLabel`, a "How it works"
panel, and — if the sync can be previewed — `previewable`.

## 23. Documentation map

| File | Covers |
|---|---|
| `README.md` (this repo) | Setup, the endpoint table, cron examples, sync summaries |
| `docs/customer_sync.md` | Partner matching data, strategy, risks |
| `docs/pricelist_sync.md` | Price-list discovery, the count_code trap, mapping, safety rails |
| `docs/deprecated_promode_warehouse_sync.md` | The retired Germany source and how to revive it |
| `docs/*.md` (rest) | Metakocka REST API reference |
| `design.md` (this file) | The engine's design + the admin UI + the contract |
| `../t4a-admin/CLAUDE.md` | The admin's architecture, per-module deep dives, env vars |
| `../t4a-admin/docs/` | Admin architecture, Auth0 roles, setup guide |
