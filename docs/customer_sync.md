# Customer (Partner) Sync — T4A → CREAGLOBE

One-way synchronisation of customers (Metakocka **partners**) from **T4A** (source of truth)
into **CREAGLOBE**. Implemented in [`src/services/customerSyncService.js`](../src/services/customerSyncService.js)
and wired into the cron/run/status machinery in [`index.js`](../index.js), exactly like the
warehouse and product syncs.

## Why this is different from product sync

Product sync keys off a `code` that both companies share, so it can do a clean one-way upsert.
**Partners have no such shared key.** Measured against live data:

| Field                | T4A with value | CREAGLOBE with value | T4A→CG overlap |
|----------------------|----------------|----------------------|----------------|
| `count_code` (šifra) | 672 / 684      | 346 / 664            | **0**          |
| `tax_id_number`      | 301            | 278                  | 257            |
| `customer` (name)    | 684            | 664                  | 578 (exact)    |

`count_code` and `mk_id` are per-company internal ids and never match across companies. Tax
numbers match well but **380 T4A buyers have no tax number** (private consumers). Names match
well but are fuzzy.

## Match strategy

Two-tier identity, resolved in `findMatch()`:

1. **Tax number** — `normTax()` (strip whitespace, upper-case). Primary key.
2. **Exact name** — `normStr()` (trim, lower-case, collapse whitespace). Fallback for the
   tax-less consumers.

A T4A partner that matches an existing CREAGLOBE partner is **updated** (via CREAGLOBE's own
`mk_id`); one that matches nothing is **created**. A `createdKeys` guard prevents creating the
same customer twice within one run.

> ⚠️ **Name-match risk.** Two different tax-less customers with the same name are treated as one
> partner. This is an accepted trade-off for full coverage — use a **dry run** to sanity-check
> the created/updated counts before a real run.

## Contacts & delivery addresses

Synced too, but their mk_ids differ per company, so they're matched by a **content signature**
so repeat runs don't append duplicates:

- **Billing address (`Račun`)** — reconciled *by role*: CREAGLOBE's existing billing address is
  updated in place (by its `mk_id`). Never appended, so a partner never gets a second `Račun`.
- **Other delivery addresses** — `addressSignature()` = `type + street + post_number + city`.
  Update the matched one if province/country drifted; append the ones CREAGLOBE is missing.
- **Contacts** — `contactSignature()` = `name + email + phone/gsm`. Append the ones CREAGLOBE is
  missing, attached to CREAGLOBE's billing address `mk_id`. (Existing contacts are left as-is.)

On **create**, `add_partner` carries the billing address (top level), the primary contact and
the first extra delivery address; `buildAppendNestedPayload()` then appends any remaining
contacts/addresses via `update_partner`.

## Dry run (preview)

Because a bad match could create a duplicate customer, the whole pipeline supports a dry run:

```
POST /api/v1/customers/sync?dryRun=true
```

or the **Preview (dry run)** button in the admin (`/automation/customers`) and the standalone UI
(`/customers-sync`). It lists both companies, resolves every match, and builds every create /
update payload — but **writes nothing**. The plan (matched / created / updated / skipped counts)
is still recorded in the run history so you can inspect it.

## Metakocka endpoints used

| Purpose        | Endpoint (`config.metakocka.*`)          |
|----------------|------------------------------------------|
| List partners  | `get_partner` (no search field = all; paginated by `offset`/`limit`) |
| Create partner | `add_partner`                            |
| Update partner | `update_partner`                         |

See [`get_partner.md`](get_partner.md), [`add_partner.md`](add_partner.md),
[`update_partner.md`](update_partner.md).

## Schedule

Default cron `0 */6 * * *` (every 6 hours) — customer data changes less often than stock. Stored
under the `customerSync` key in `cron.json`; editable from the admin or
`PUT /api/v1/schedules/customer-sync`.

## Run record

Each run writes a `sync_runs` row (`type = 'customers'`) whose `details` JSON is:

```jsonc
{
  "type": "customers",
  "dryRun": false,
  "counts": { "source": 684, "target": 664, "matched": 589, "created": 95, "updated": 420, "skipped": 169 },
  "buckets": [ { "key": "Created in CREAGLOBE", "count": 95 }, ... ],
  "errorCount": 0,
  "errors": [ { "system": "CREAGLOBE", "partner": "...", "tax_id_number": "...", "action": "add|update", "message": "..." } ]
}
```

A JSON snapshot of each real run is also written to the data folder and logged in
`customer_sync_log` with its created/updated counts.
