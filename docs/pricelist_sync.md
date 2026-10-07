# Pricelist (Price) Sync — T4A → CREAGLOBE

One-way synchronisation of **product prices** from **T4A** (source of truth) into
**CREAGLOBE**. Implemented in [`src/services/pricelistSyncService.js`](../src/services/pricelistSyncService.js)
and wired into the cron/run/status machinery in [`index.js`](../index.js), exactly like the
warehouse, product and customer syncs.

Unlike the other three, this sync **refuses to guess**. It only writes price-list pairs that
a human has explicitly mapped. The rest of this document explains why.

---

## 1. Metakocka has no "list price lists" endpoint

Of the 57 endpoints in `docs/`, none returns the price lists of a company.
`get_delivery_service_pricelist` sounds right but is **delivery/shipping cost** tables, not
product prices.

The only source is `json/product_list` with `return_pricelist: "true"`. Every product then
carries a `pricelist[]` of the lists it sits on:

```jsonc
{
  "count_code": "1",
  "title": "RRP 2025",
  "currency_code": "EUR",
  "sales_purchase": "sales",
  "valid_from": "2025-08-08+02:00",
  "price_def": { "tax": "EX4", "tax_desc": "22", "price": "1392,62" }
}
```

So the list of price lists is **derived** by scanning the catalogue and de-duplicating
(`indexPricelists`). Two consequences:

- The scan is expensive (a full paginated catalogue read per company), so
  `GET /api/v1/pricelists` caches for 5 minutes; `?refresh=true` forces a fresh read.
- **A price list with no products on it is invisible.** It cannot be distinguished from one
  that does not exist. See §5.

> Note the read/write asymmetry: `product_list` returns **one row per price definition**
> (`price_def` is an object), while `product_update` wants them **grouped per list**
> (`price_def` is an array). `indexProductPrices` regroups.

---

## 2. Why mapping is mandatory: `count_code` lies

A price list's `count_code` is a **per-company counter**. Measured against live data
(1555 T4A products, 1559 CREAGLOBE products):

| T4A code | T4A list | CREAGLOBE code | CREAGLOBE list |
|---|---|---|---|
| 1 | RRP 2025 | 1 | **Purchase price Ex-W 2025** |
| 2 | Partner price 2025 | 2 | **Purchase price Ex-Ger 2025** |
| 7 | **PP GOLD 2026** | 7 | **PP BRONZE 2026** |
| 8 | **PP PREMIUM 2026** | 8 | **PP AGENTS BRONZE 2026** |
| 9 | PP AGENTS BRONZE 2026 | 9 | PP AGENTS SILVER 2026 |

Nine codes overlap and **every pairing is wrong**. A code-keyed sync would write GOLD prices
into the BRONZE list — a silent, catalogue-wide pricing error.

Worse, `count_code` is not unique even *within* one company: Metakocka numbers sales and
purchase lists in separate namespaces, so T4A code `1` is both "RRP 2025" (sales) and
"Partner price 2026" (purchase). A list's identity is therefore the pair
**`(sales_purchase, count_code)`** — `plKey()` in the service.

**Titles, by contrast, align perfectly.** All 13 T4A sales lists have an exact-title twin in
CREAGLOBE. That is good enough to *suggest* a mapping in the UI, never to apply one.

### The live inventory

| | T4A | CREAGLOBE |
|---|---|---|
| Sales lists | 13 | 18 |
| Purchase lists | 1 | 2 |
| Products | 1555 | 1559 |

The correct mapping (by title):

| T4A | Title | → CREAGLOBE |
|---|---|---|
| 1 | RRP 2025 | 16 |
| 2 | Partner price 2025 | 15 |
| 3 | RRP 2026 | 23 |
| 4 | Partner price 2026 | 22 |
| 5 | PP BRONZE 2026 | 7 |
| 6 | PP SILVER 2026 | 10 |
| 7 | PP GOLD 2026 | 11 |
| 8 | PP PREMIUM 2026 | 13 |
| 9 | PP AGENTS BRONZE 2026 | 8 |
| 10 | PP AGENTS SILVER 2026 | 9 |
| 11 | PP AGENTS GOLD 2026 | 12 |
| 12 | PP AGENTS PREMIUM 2026 | 14 |
| 13 | PP TEAM 2026 | 24 |

CREAGLOBE lists with no T4A source — left untouched: Purchase price Ex-W/Ex-Ger 2025,
PP Ex-W BRONZE/SILVER/GOLD/PREMIUM 2025, PP_JibeWear 2025.

Mappings live in the `pricelist_map` table (unique on `(source_sales_purchase,
source_code)` — one source list may only be mapped once, or two mappings would race each
other writing different prices onto the same products).

---

## 3. Matching products

Products are matched by **`code`** (SKU) — measured overlap **1555 / 1555**, a perfect join
key, and the same one `productSyncService` uses. Writes address the product by
**CREAGLOBE's own `count_code`**, again exactly as product sync does.

A T4A product with no counterpart in CREAGLOBE is skipped and counted
(`skippedMissingProduct`); creating products is the Products sync's job.

---

## 4. What a run does

For each mapped pair:

| Situation | Action |
|---|---|
| Priced in T4A, missing from the CREAGLOBE list | **add** |
| On both, a T4A-owned field differs | **update** |
| On both, identical | `unchanged` |
| On the CREAGLOBE list only | **left alone**, counted as `extra` |
| Product absent from CREAGLOBE | skipped, counted |

### VAT is mirrored 1:1 — and a tax is always required on write

Two facts that pull against each other.

**1. Metakocka refuses a price line with no `tax`**, and its error message actively
misleads:

```
Paramether 'tax' is not a valid tax. Supported tax values are: 000,085,095,200,220,...,EX30
```

It reads as "the code you sent is wrong". It actually fires when the field is **absent**.
Established by experiment against the test price list (CREAGLOBE 25):

| payload | result |
|---|---|
| `{"price":"1234"}` | **refused** |
| `{"price":"1234","discount":"10"}` | **refused** |
| `{"price":"1234","amount_from":"0","amount_to":"6"}` | **refused** |
| `{"price":"1234,56"}` / `{"price":"1234.56"}` / `{"price":1234.56}` | **refused** |
| `{"price":"1234","tax":""}` | **refused** |
| `{"price":"1234","tax":"EX4"}` | accepted → 22% |
| `{"price":"1234","tax":"000"}` | accepted → **0%, price with VAT = price** |
| `{"price":"1234","tax_factor":"0.22"}` | accepted → 22% |
| `{"price":"1234","tax":"EX4","tax_desc":"22"}` | accepted (unknown fields ignored) |

Comma decimals, tiers, discounts and read-only echoes are all fine. **Only the presence of
`tax` (or `tax_factor`) matters.**

> ⚠️ **`N20` / `N22` (and `N85` / `N95`) are accepted and then the row DISAPPEARS from the
> price list.** The write reports `opr_code 0` and the product is simply gone on the next
> read. Listed in `DESTRUCTIVE_TAX_CODES`; never send them.

**2. T4A leaves VAT blank on entire lists** — `RRP 2026` and all eight `PP … 2026` lists,
~930 rows each. There is nothing to copy, yet something must be sent.

`000` resolves it: it stores as 0% with "price with VAT" equal to the price, which is
exactly how T4A's blank-VAT rows behave. So:

```
resolveTax(sourceDef):
  T4A sets a tax        -> use it verbatim
  T4A leaves VAT blank  -> "000"   (0%, i.e. what blank means)
```

**CREAGLOBE's existing tax is never consulted.** Mirroring 1:1 means T4A's VAT wins,
including when T4A says "none" — a stale 22% in CREAGLOBE is corrected down to 0%.

#### Comparing VAT without churning

`defsEqual` compares only the fields T4A sets, which would hide a wrong VAT (T4A has no
`tax`, so `tax` would never be compared). Tax is therefore compared separately, through
`taxStateOf()`, which treats **blank and `000` as the same thing**:

| T4A | CREAGLOBE | result |
|---|---|---|
| blank | blank | equal — no write |
| blank | `000` | equal — no write |
| blank | `EX4` | **differs** — corrected to `000` |
| `EX4` | blank | **differs** — corrected to `EX4` |

Without that equivalence the sync would rewrite ~7000 rows on every single run purely to
turn a blank into a `0`. With it, a real dry run over the 2026 lists reports **2262
unchanged** and touches only what genuinely differs.

### Only writable fields are ever sent

`product_update` documents exactly seven fields inside a `price_def`:
`amount_from`, `amount_to`, `discount`, `tax`, `price`, `price_with_tax`,
`lowest_price_30_days`. `WRITABLE_PRICE_DEF_FIELDS` is the single source of truth for both
the payload (`mergeDef`) and the change detector (`defsEqual`).

Using it in **both** places is the point. Comparing on a field that cannot be written pins a
row as permanently dirty and rewrites it on every run — `tax_desc` alone produced **1115
phantom "changes"** in a dry run before this was introduced.

> Tested: echoing the read-only `tax_desc` back is *accepted* — Metakocka ignores unknown
> fields. It is excluded to fix the churn above, not because it broke a write.

Change summaries describe the **resolved payload**, not the raw T4A row. Otherwise a tax
inherited from CREAGLOBE renders as `tax EX4 → —`, reading as though the sync were stripping
it.

**Field semantics — mirror T4A, destroy nothing.** The payload is CREAGLOBE's current
`price_def` overlaid with T4A's fields (`mergeDef`). T4A wins on everything it defines; a
field only CREAGLOBE has is re-sent unchanged so it survives even if Metakocka replaces the
row wholesale. Change detection (`defsEqual`) only compares fields T4A owns, so
CREAGLOBE-only extras never cause churn.

The write payload is deliberately **minimal** — the product's `count_code` plus the
`pricelist` array — so a price sync can never accidentally rewrite a name, unit or category.
`pricelist` only names the lists being changed; Metakocka leaves the product's other lists
alone.

Updates are **grouped per product**: one `product_update` carries every changed list for
that product. 13 mapped lists over ~1500 products would otherwise be ~20 000 HTTP calls
instead of ~1 200. Concurrency is capped at 4.

**Quantity tiers** (`amount_from` / `amount_to`) are handled — rows are aligned by tier and
boundaries are compared — but measured live: **zero** products currently use them.

**Nothing is ever removed** from a CREAGLOBE list. Metakocka documents no reliable
"remove product from price list" call, and the product may legitimately be CREAGLOBE-only.

---

## 5. The two safety mechanisms

### 5.1 Unseen target lists

A mapping whose **target** list was not seen in the scan is **refused** with
`target-list-not-seen`. Since a list is only visible through the products on it, an empty
list and a non-existent list look identical — and writing blind to a wrong code is exactly
the failure this whole design exists to prevent. Override per mapping with
`allowUnseenTarget` once you have confirmed the code in Metakocka.

A missing **source** list is reported as `source-list-not-found` (it has no products, or its
code changed) rather than passing as a clean, empty run.

### 5.2 The max-change rail

Each mapping may carry `maxChangePct`. Any single price moving further than that is
**refused and reported**, not written (`action: "blocked"`).

This is not hypothetical. The very first dry run against live data found:

```
RRP 2025 → CG 16 | add=3 upd=1093 unchanged=0
  P01150099043  price 2399 → 1966,39
```

`2399 / 1.22 = 1966.39` — exactly the VAT factor. 674 of 1075 changing rows were a clean
&times;1.22; the rest ranged 1.22–2.40. The two lists are **not storing the same kind of
number** (gross vs net), and a blind sync would have cut 1093 prices by 18%.

By contrast the 2026 lists agree on 743–782 products each and differ on only 13–92 — those
are genuine staleness worth correcting, plus ~175 products per list missing 2026 prices
entirely, which is the actual business gap this sync was built to close.

**Recommendation: do not map the 2025 lists** until the net/gross question is settled in
Metakocka. Map the 2026 lists with a rail (25% was used in testing) and review the blocked
rows.

---

## 6. API

| Method | Endpoint | Auth | Purpose |
|---|---|:--:|---|
| `GET` | `/api/v1/pricelists` | ✅ | Discovered lists per company + title suggestions + saved mappings. `?refresh=true` bypasses the 5-minute cache. |
| `GET` | `/api/v1/pricelists/mappings` | ✅ | The saved source→target pairs |
| `PUT` | `/api/v1/pricelists/mappings` | ✅ | Replace the whole set in one transaction |
| `POST` | `/api/v1/pricelists/sync` | ✅ | Run now. `?dryRun=true` resolves the plan without writing. 202 / 409 |
| `GET` | `/api/v1/pricelists/sync/logs` | ❌ | Recent saved result files |
| `PUT` | `/api/v1/schedules/pricelist-sync` | ✅ | Set the cron expression |
| `GET` | `/api/v1/schedules/pricelist-sync` | ❌ | Read the cron expression |

`GET /api/v1/status` gains a `pricelists` block carrying the usual
`schedule` / `nextRun` / `isRunning` / `lastRun`, plus **`mappingCount`** so the UI can say
"nothing mapped yet" instead of showing a meaningless green run.

Default schedule: **`0 4 * * *`** (daily, 04:00). Prices change rarely and a run rewrites
money, so it should not fire more often than someone would want to review it. With no
mappings saved a run is a recorded no-op (`noMappings: true`), so leaving the schedule armed
on a fresh install is safe.

### `sync_runs.details` for a pricelist run

```jsonc
{
  "type": "pricelists",
  "dryRun": false,
  "noMappings": false,
  "counts": { "mappings": 11, "products": 184, "added": 977, "updated": 350,
              "unchanged": 8479, "blocked": 463, "extra": 2749, "skippedMissingProduct": 0 },
  "perList": [ { "source": {...}, "target": {...}, "added": 175, "updated": 0,
                 "unchanged": 743, "blocked": 13, "extra": 1,
                 "skippedMissingProduct": 0, "skipped": null } ],
  "buckets": [ { "key": "added", "count": 977 }, ... ],
  "changeCount": 1790, "changes": [ /* capped at 200 */ ],
  "errorCount": 0,    "errors":  [ /* capped at 50 */ ]
}
```

The full, uncapped record of every run is written to
`{TIMESTAMP}_pricelists_T4A_to_CREAGLOBE.json` under `PUBLIC_DATA_FILE_PATH` and indexed in
the `pricelist_sync_log` table. Dry runs deliberately write no file.

---

## 7. Where the UI lives

- **Admin portal** — `Automation → Pricelists` (`/automation/pricelists`): status card,
  schedule editor, Run now, Preview (dry run), the **mapping editor** (pickers over the
  discovered lists plus manual code entry, a per-pair max-change %, an enable toggle, and
  warnings when two mapped titles disagree or a target was not seen), both companies' lists
  side by side, and a pricelists-only run history whose details view breaks the run down per
  list and per product.
- **Service dashboard** — `/pricelists-sync`: the no-dependency fallback. Schedule builder,
  Run now, Preview, a read-only view of the mapping and of both companies' lists, and the
  run log. Notes at `/pricelists-sync/notes`.

---

## 8. Checklist before enabling a new pair

1. **Rescan** so both lists are current.
2. Confirm the two titles describe the same thing (the editor warns when they differ).
3. Set a **max change %** — 25% is a reasonable starting rail.
4. Run **Preview (dry run)** and read the per-list breakdown.
5. Look at every **blocked** row: a cluster at one constant ratio means the two lists hold
   different kinds of number, not stale prices.
6. Only then enable it and let a real run write.
