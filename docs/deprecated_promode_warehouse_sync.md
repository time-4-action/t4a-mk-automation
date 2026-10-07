# ⛔ DEPRECATED — ProMode (Germany) warehouse sync

**Status:** disabled since **July 2026**. The code is kept, not deleted.

## What it was

Warehouse sync used to pull stock from **two** sources and write each into its own
virtual warehouse inside the CREAGLOBE Metakocka company:

| Source | Where the data came from | CREAGLOBE target warehouse |
|---|---|---|
| **T4A** | Metakocka `warehouse_stock` API (`MK_T4A_WAREHOUSE_ID`) | `MK_CREAGLOBE_WAREHOUSE_ID_T4A` |
| **ProMode / Germany** | ProMode's exported CSV (`config.promode.warehouseStockCSV`) | `MK_CREAGLOBE_WAREHOUSE_ID_GERMANY_ONE` |

The two were never merged — each product code was pushed to its matching virtual warehouse.

## Why it's disabled

T4A no longer uses the ProMode warehouse, so the Germany feed is no longer a real
source of stock. Rather than keep syncing stale (or empty) data, the ProMode leg is
turned off and **warehouse sync is now T4A-only**.

While disabled, no Germany stock is sent in the `sync_stock` request, so the CREAGLOBE
Germany virtual warehouse is simply left out of the sync (this service no longer touches it).

## Where the disabled code lives

Everything is in `index.js`, inside `warehousesSync()` and its wrapper `runWarehouseSync()`:

- **Step 2** — the ProMode CSV fetch + parse is wrapped in a `/* … */` block comment.
- **Step 3** — `combinedStockArray` now spreads only `syncSloStockPreparedArray` (T4A).
- **Step 7** — the Germany `saveSyncFile(...)` call is commented out.
- **`breakdown.germany`** is set to `null`.
- **`runWarehouseSync()` details** — the ProMode entry is removed from `details.warehouses`.

`config.promode.warehouseStockCSV`, the `csv`/`Readable` imports, and `sumByProductCode()`
are all still present because the disabled block references them.

## How to turn it back on

1. Un-comment the **Step 2** block in `warehousesSync()`.
2. Spread `...syncGerStockPreparedArray` back into `combinedStockArray` in **Step 3**.
3. Un-comment the Germany `saveSyncFile(...)` call in **Step 7**.
4. Restore `germany: syncGerStockPreparedArray.length` in the `breakdown` return.
5. Add the ProMode entry back to `details.warehouses` in `runWarehouseSync()`:
   `{ source: "ProMode (Germany)", target: "CREAGLOBE / Germany warehouse", count: b.germany ?? null }`.
6. Confirm `config.promode.warehouseStockCSV` still points at a valid, current CSV.
