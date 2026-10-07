// Pricelist (price) sync — strictly one-way: T4A → CREAGLOBE.
//
// ─── Why this service exists in this shape ───────────────────────────────────
// Metakocka exposes NO endpoint that lists price lists. The only way to see them is
// json/product_list with `return_pricelist: true`: every product carries a `pricelist[]`
// of the lists it sits on, each row giving { count_code, title, currency_code,
// sales_purchase, valid_from, valid_to, buyer, price_def }. Scanning the catalogue and
// de-duplicating therefore *derives* the list of price lists. A list with zero products
// on it is invisible this way — that is a real limitation, handled explicitly below.
//
// ─── The trap this service is built around ───────────────────────────────────
// A price list's `count_code` is a per-company, per-namespace counter. It does NOT
// identify the same list across the two companies. Measured against live data:
//
//     T4A  7  = "PP GOLD 2026"        CREAGLOBE  7  = "PP BRONZE 2026"
//     T4A  8  = "PP PREMIUM 2026"     CREAGLOBE  8  = "PP AGENTS BRONZE 2026"
//     T4A  1  = "RRP 2025"            CREAGLOBE  1  = "Purchase price Ex-W 2025"
//
// Nine count_codes "overlap" and every single pairing is wrong. Syncing by count_code
// would write GOLD prices into the BRONZE list. So this sync NEVER guesses: it only
// syncs pairs that a human has explicitly mapped (source list → target list). Titles
// happen to align 13/13 today, which is good enough to *suggest* a mapping, never to
// apply one.
//
// Worse, `count_code` is not even unique inside one company: T4A code "1" is both
// "RRP 2025" (sales) and "Partner price 2026" (purchase). A list's identity is
// therefore the pair (sales_purchase, count_code) — see plKey().
//
// ─── What a run does ─────────────────────────────────────────────────────────
// Products are matched by `code` (measured 1555/1555 overlap — a perfect join key, the
// same one productSyncService uses) and addressed for writing by CREAGLOBE's own
// `count_code`, exactly as product sync does.
//
//   • product in T4A list, present in CG list  → UPDATE if any T4A-owned field differs
//   • product in T4A list, missing from CG list → ADD to the CG list
//   • product in CG list but not in T4A list    → LEFT ALONE, counted as `extra`
//     (Metakocka documents no reliable "remove product from a price list" call, and the
//      product may legitimately be CREAGLOBE-only.)
//
// Field semantics are "mirror T4A, destroy nothing": the payload is CREAGLOBE's current
// price_def overlaid with T4A's fields. T4A wins on every field it defines; a field only
// CREAGLOBE has (e.g. a discount T4A does not set) is re-sent unchanged, so it survives
// even if Metakocka replaces the row wholesale. Change detection only looks at the
// T4A-owned fields, so CG-only extras never cause churn.
//
// ─── VAT is mirrored 1:1, and a tax is always required ───────────────────────
// A price_def without `tax` (or `tax_factor`) is refused — with a message that misleadingly
// reads as if the value were wrong. T4A leaves VAT blank on whole lists (RRP 2026 and every
// PP 2026 list), so a blank one is written as the 0% code, which is what T4A's blank means.
// CREAGLOBE's own tax is never consulted: T4A's VAT wins, including when it says "none".
// See resolveTax().
//
// T4A is the single source of truth and is NEVER written to: the only writer in this
// file is pushProductUpdate(), and it is only ever handed the CREAGLOBE credentials.
//
// See docs/pricelist_sync.md for the full data survey.

const axios = require("axios");
const config = require("../../config/config.json");

// ── helpers ──────────────────────────────────────────────────────────────────

/** Parses a value to a number, tolerating a comma decimal separator ("1392,62"). */
function parseNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number") return value;
    const n = Number(String(value).replace(",", "."));
    return Number.isFinite(n) ? n : null;
}

/** Trimmed string, or null for blank/absent. */
function str(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
}

/**
 * A price list's identity. `count_code` alone is NOT unique — Metakocka numbers sales and
 * purchase lists in separate namespaces, so T4A code "1" is both "RRP 2025" (sales) and
 * "Partner price 2026" (purchase). Everything in this file keys on this pair.
 */
function plKey(salesPurchase, countCode) {
    return `${str(salesPurchase) || "sales"}|${str(countCode) || ""}`;
}

/** Compares two price_def values: numerically when both look numeric, else as strings. */
function valueEqual(a, b) {
    const na = parseNumber(a);
    const nb = parseNumber(b);
    if (na !== null && nb !== null) return Math.abs(na - nb) < 0.00001;
    return (str(a) ?? "") === (str(b) ?? "");
}

/**
 * The ONLY fields `product_update` documents inside a price list's `price_def`.
 *
 * Everything else Metakocka returns on a read is derived/read-only. `tax_desc` ("22") is the
 * human label for `tax` ("EX4"); `tax_factor` is an *alternative* to `tax` on write and only
 * appears on a read when `show_tax_factor` is set.
 *
 * (Tested against live CREAGLOBE: echoing `tax_desc` back is in fact ACCEPTED — Metakocka
 * ignores it. It is excluded on principle, not as a bugfix. The real reason this list exists
 * is the change detector: `defsEqual` compares on these fields only, and comparing on a
 * read-only field would pin a row as permanently dirty and rewrite it on every single run.
 * `tax_desc` alone produced 1115 phantom "changes" before this was introduced.)
 *
 * (Separately: Metakocka REQUIRES a tax on every price line — see resolveTax() below. That
 * is what its "not a valid tax" message actually means.)
 */
const WRITABLE_PRICE_DEF_FIELDS = [
    "amount_from",
    "amount_to",
    "discount",
    "tax",
    "price",
    "price_with_tax",
    "lowest_price_30_days",
];

/** Strips a price_def down to the fields Metakocka accepts on write. */
function writableDef(def) {
    const out = {};
    if (!def || typeof def !== "object") return out;
    for (const field of WRITABLE_PRICE_DEF_FIELDS) {
        if (def[field] !== undefined) out[field] = def[field];
    }
    return out;
}

/**
 * Are CREAGLOBE's price definitions already in line with T4A's?
 * Only the fields T4A actually defines are compared — a CG-only field (a discount T4A
 * does not set) must never make the row look "changed" and trigger a pointless write.
 * Rows are aligned by quantity tier (amount_from/amount_to); today no list uses tiers
 * (measured: 0 products with more than one price_def per list), but the comparison is
 * written to survive it if that ever changes.
 */
function defsEqual(sourceDefs, targetDefs) {
    if (sourceDefs.length !== targetDefs.length) return false;
    const sorted = (defs) =>
        [...defs].sort(
            (x, y) => (parseNumber(x.amount_from) ?? 0) - (parseNumber(y.amount_from) ?? 0),
        );
    const a = sorted(sourceDefs).map(writableDef);
    const b = sorted(targetDefs).map(writableDef);
    for (let i = 0; i < a.length; i++) {
        for (const field of Object.keys(a[i])) {
            // Tax is compared separately: it is mirrored 1:1 and is the one field whose
            // ABSENCE in T4A is itself meaningful, so the generic "only compare what T4A
            // sets" rule would hide a wrong VAT in CREAGLOBE.
            if (field === "tax" || field === "tax_factor") continue;
            if (!valueEqual(a[i][field], b[i][field])) return false;
        }
        if (taxStateOf(a[i]) !== taxStateOf(b[i])) return false;
        // Tier boundaries are structural: a differing range is a different row even if the
        // price matches, so compare them in both directions.
        for (const field of ["amount_from", "amount_to"]) {
            if (!valueEqual(a[i][field], b[i][field])) return false;
        }
    }
    return true;
}

/**
 * A price line's VAT state, normalised for comparison.
 *
 * A blank tax and the explicit 0% code mean the same thing — T4A shows a blank VAT column
 * and Metakocka stores that as `000` once written through the API. Treating them as equal is
 * what stops the sync rewriting ~7000 rows forever just to turn "blank" into "0", while
 * still catching a genuinely wrong VAT (CREAGLOBE holding 22% where T4A holds none).
 */
function taxStateOf(def) {
    if (!def) return NO_VAT_TAX_CODE;
    if (def.tax !== undefined && str(def.tax)) return String(def.tax).trim().toUpperCase();
    if (def.tax_factor !== undefined && str(def.tax_factor)) {
        const f = parseNumber(def.tax_factor);
        return f === 0 ? NO_VAT_TAX_CODE : `TF:${f}`;
    }
    return NO_VAT_TAX_CODE;
}

/**
 * The payload row: CREAGLOBE's current definition overlaid with T4A's fields.
 * T4A wins on everything it defines; CG-only fields are carried through untouched so
 * they survive regardless of whether Metakocka patches or replaces the row.
 */
function mergeDef(sourceDef, targetDef) {
    // Both sides are reduced to writable fields first: read-only echoes (tax_desc,
    // tax_factor, …) are rejected by Metakocka, and a CREAGLOBE-only read-only field must
    // not leak into the payload either.
    return { ...writableDef(targetDef), ...writableDef(sourceDef) };
}

/** The comparable headline price of a definition: net if given, else gross. */
function headlinePrice(def) {
    if (!def) return null;
    return parseNumber(def.price) ?? parseNumber(def.price_with_tax);
}

/**
 * How far this change moves the price, as a fraction of the current CREAGLOBE price
 * (0.22 = 22% move). null when either side has no comparable price, or when the row is new.
 *
 * This exists because a price sync writes money. Live data showed CREAGLOBE's "RRP 2025"
 * holding 2399 where T4A holds 1966,62 — exactly a ×1.22 VAT factor, i.e. the two companies
 * are not storing the same thing in the same field on that list. Syncing it blind would cut
 * 1093 prices by 18%. A mapping can therefore carry a maxChangePct rail: anything beyond it
 * is refused and reported instead of written.
 */
function priceMoveFraction(sourceDefs, targetDefs) {
    const from = headlinePrice(targetDefs[0]);
    const to = headlinePrice(sourceDefs[0]);
    if (from === null || to === null || from === 0) return null;
    return Math.abs(to - from) / Math.abs(from);
}

/** Compact "price 12 → 14, discount 15 → 20" summary of what a row change does. */
function summarizeDefChange(sourceDefs, targetDefs) {
    const s = sourceDefs[0] || {};
    const t = targetDefs[0] || {};
    const bits = [];
    // Writable fields only — `tax_desc` is derived from `tax`, so reporting it as a change
    // was pure noise (it accounted for 1115 "changes" in the first dry run).
    for (const field of ["price", "price_with_tax", "discount", "tax", "amount_from", "amount_to"]) {
        if (s[field] === undefined && t[field] === undefined) continue;
        if (!valueEqual(s[field], t[field])) {
            bits.push(`${field} ${t[field] ?? "—"} → ${s[field] ?? "—"}`);
        }
    }
    if (sourceDefs.length > 1 || targetDefs.length > 1) {
        bits.push(`${targetDefs.length} → ${sourceDefs.length} tier(s)`);
    }
    return bits.join(", ") || "no visible field change";
}

/** Runs `fn` over `items` with bounded concurrency (Metakocka is one call per product). */
async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
            const idx = i++;
            out[idx] = await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
    return out;
}

// ── Metakocka reads ──────────────────────────────────────────────────────────

/**
 * Every product with its price list rows. Paginated: product_list returns at most 1000
 * records, and a missed page would look like "this product has no prices" and silently
 * skip it.
 */
async function listProductsWithPricelists(secret_key, company_id) {
    const url = `${config.metakocka.baseUrl}${config.metakocka.productListPath}`;
    const PAGE_SIZE = 1000;
    const products = [];
    let offset = 0;

    for (;;) {
        const res = await axios.post(
            url,
            { secret_key, company_id, return_pricelist: "true", limit: PAGE_SIZE, offset },
            { headers: { "Content-Type": "application/json" } },
        );

        if (res.data.opr_code !== "0") {
            throw new Error(`product_list failed: ${res.data.opr_desc || res.data.opr_code}`);
        }

        // product_list is an array of products, or a single object when the request narrows
        // to one product. Normalise so callers never branch.
        const raw = res.data.product_list;
        const page = Array.isArray(raw) ? raw : raw ? [raw] : [];
        products.push(...page);

        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    return products;
}

/** The `pricelist` field is an array, a single object, or absent. Always give an array. */
function pricelistRowsOf(product) {
    const raw = product.pricelist;
    if (Array.isArray(raw)) return raw;
    return raw && typeof raw === "object" ? [raw] : [];
}

/**
 * Derives the price lists present in a company from a scanned product list.
 * Metakocka has no endpoint for this — see the header. A list carrying no products is
 * invisible here; that is why a mapping to an unseen target is refused by default rather
 * than written blind.
 */
function indexPricelists(products) {
    const lists = new Map();

    for (const product of products) {
        const seenOnThisProduct = new Set();
        for (const row of pricelistRowsOf(product)) {
            const key = plKey(row.sales_purchase, row.count_code);
            if (!lists.has(key)) {
                lists.set(key, {
                    key,
                    code: str(row.count_code),
                    salesPurchase: str(row.sales_purchase) || "sales",
                    title: str(row.title),
                    currency: str(row.currency_code),
                    validFrom: str(row.valid_from),
                    validTo: str(row.valid_to),
                    buyer: str(row.buyer),
                    productCount: 0,
                    priceDefCount: 0,
                    fields: new Set(),
                });
            }
            const list = lists.get(key);
            list.priceDefCount++;
            if (!seenOnThisProduct.has(key)) {
                list.productCount++;
                seenOnThisProduct.add(key);
            }
            for (const field of Object.keys(row.price_def || {})) list.fields.add(field);
        }
    }

    return lists;
}

/** Public shape of a discovered price list (Sets flattened for JSON). */
function toPricelistView(list) {
    return {
        key: list.key,
        code: list.code,
        salesPurchase: list.salesPurchase,
        title: list.title,
        currency: list.currency,
        validFrom: list.validFrom,
        validTo: list.validTo,
        buyer: list.buyer,
        productCount: list.productCount,
        priceDefCount: list.priceDefCount,
        fields: [...list.fields].sort(),
    };
}

/**
 * Discovery: the price lists of one company, newest-numbered last.
 * Used by GET /api/v1/pricelists to populate the mapping editor.
 */
async function listPricelists(secret_key, company_id) {
    const products = await listProductsWithPricelists(secret_key, company_id);
    const lists = [...indexPricelists(products).values()].map(toPricelistView);
    lists.sort(
        (a, b) =>
            a.salesPurchase.localeCompare(b.salesPurchase) ||
            (parseNumber(a.code) ?? 0) - (parseNumber(b.code) ?? 0),
    );
    return { lists, productCount: products.length };
}

/**
 * productCode → (pricelist key → price_def[]).
 * Products with no `code` are dropped: `code` is the cross-company join key and a blank
 * one cannot be matched to anything.
 */
function indexProductPrices(products) {
    const byProduct = new Map();

    for (const product of products) {
        const code = str(product.code);
        if (!code) continue;

        const perList = new Map();
        for (const row of pricelistRowsOf(product)) {
            const key = plKey(row.sales_purchase, row.count_code);
            if (!row.price_def || typeof row.price_def !== "object") continue;
            // The read side gives one row per price definition; the write side wants them
            // grouped into a price_def array per list. Regroup here.
            const defs = perList.get(key) || [];
            defs.push({ ...row.price_def });
            perList.set(key, defs);
        }

        byProduct.set(code, { product, perList });
    }

    return byProduct;
}

// ── Metakocka writes (CREAGLOBE only) ────────────────────────────────────────

/**
 * Pushes one product's price list changes. The payload is deliberately MINIMAL — the
 * product's own `count_code` plus the `pricelist` array — so a price sync can never
 * accidentally rewrite a name, unit or category. `pricelist` only ever names the lists
 * being changed, and Metakocka leaves every other list on that product alone.
 */
async function pushProductUpdate(targetCountCode, pricelist, secret_key, company_id) {
    const url = `${config.metakocka.baseUrl}${config.metakocka.productUpdatePath}`;
    const res = await axios.post(
        url,
        {
            secret_key,
            company_id,
            count_code: targetCountCode,
            pricelist,
        },
        { headers: { "Content-Type": "application/json" } },
    );
    return res.data;
}

/**
 * The code that means "no VAT".
 *
 * Metakocka refuses a price line with no `tax` at all, but T4A leaves VAT blank on whole
 * lists (RRP 2026 and every PP 2026 list, ~930 rows each). Verified on the test list:
 *
 *     sent {"price":"1234","tax":"000"}  -> stored {tax:"000", tax_desc:"0", tax_factor:"0"}
 *
 * i.e. VAT 0% and "price with VAT" equal to the price — exactly how T4A's blank-VAT rows
 * read. So an absent tax maps to this, and VAT stays 1:1 with T4A.
 */
const NO_VAT_TAX_CODE = "000";

/**
 * Tax codes that must never be written. `N20` / `N22` are accepted by Metakocka and then the
 * row DISAPPEARS from the price list — the write reports success and the product is simply
 * gone from the list on the next read. Found by experiment; never send these.
 */
const DESTRUCTIVE_TAX_CODES = new Set(["N85", "N95", "N20", "N22"]);

/**
 * VAT is mirrored 1:1 from T4A.
 *
 * Metakocka's error for a missing tax is badly worded and cost us a while:
 *
 *     Paramether 'tax' is not a valid tax. Supported tax values are: 000,085,...,EX30
 *
 * It reads like "your code is wrong" but fires when the field is ABSENT. Verified on the
 * test price list — every payload without a tax was refused and every payload with one was
 * accepted, regardless of anything else in it:
 *
 *     FAIL {"price":"1234"}                      OK {"price":"1234","tax":"EX4"}
 *     FAIL {"price":"1234","discount":"10"}      OK {"price":"1234","tax":"000"}
 *     FAIL {"price":"1234,56"}                   OK {"price":"1234","tax_factor":"0.22"}
 *
 * So a tax must always be sent, and T4A decides which one:
 *   • T4A sets a tax on the line  -> use it verbatim
 *   • T4A leaves VAT blank        -> NO_VAT_TAX_CODE, which stores as 0% (T4A's own meaning)
 *
 * CREAGLOBE's existing tax is deliberately NOT consulted: mirroring 1:1 means T4A's VAT
 * wins, including when T4A says "none".
 */
function resolveTax(sourceDef) {
    if (sourceDef) {
        if (sourceDef.tax !== undefined && str(sourceDef.tax)) return { tax: sourceDef.tax };
        if (sourceDef.tax_factor !== undefined && str(sourceDef.tax_factor)) {
            return { tax_factor: sourceDef.tax_factor };
        }
    }
    return { tax: NO_VAT_TAX_CODE };
}

// ── Metakocka reads ──────────────────────────────────────────────────────────

/**
 * Every product with its price list rows. Paginated: product_list returns at most 1000
 * records, and a missed page would look like "this product has no prices" and silently
 * skip it.
 */
async function listProductsWithPricelists(secret_key, company_id) {
    const url = `${config.metakocka.baseUrl}${config.metakocka.productListPath}`;
    const PAGE_SIZE = 1000;
    const products = [];
    let offset = 0;

    for (;;) {
        const res = await axios.post(
            url,
            { secret_key, company_id, return_pricelist: "true", limit: PAGE_SIZE, offset },
            { headers: { "Content-Type": "application/json" } },
        );

        if (res.data.opr_code !== "0") {
            throw new Error(`product_list failed: ${res.data.opr_desc || res.data.opr_code}`);
        }

        // product_list is an array of products, or a single object when the request narrows
        // to one product. Normalise so callers never branch.
        const raw = res.data.product_list;
        const page = Array.isArray(raw) ? raw : raw ? [raw] : [];
        products.push(...page);

        if (page.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    return products;
}

/** The `pricelist` field is an array, a single object, or absent. Always give an array. */
function pricelistRowsOf(product) {
    const raw = product.pricelist;
    if (Array.isArray(raw)) return raw;
    return raw && typeof raw === "object" ? [raw] : [];
}

/**
 * Derives the price lists present in a company from a scanned product list.
 * Metakocka has no endpoint for this — see the header. A list carrying no products is
 * invisible here; that is why a mapping to an unseen target is refused by default rather
 * than written blind.
 */
function indexPricelists(products) {
    const lists = new Map();

    for (const product of products) {
        const seenOnThisProduct = new Set();
        for (const row of pricelistRowsOf(product)) {
            const key = plKey(row.sales_purchase, row.count_code);
            if (!lists.has(key)) {
                lists.set(key, {
                    key,
                    code: str(row.count_code),
                    salesPurchase: str(row.sales_purchase) || "sales",
                    title: str(row.title),
                    currency: str(row.currency_code),
                    validFrom: str(row.valid_from),
                    validTo: str(row.valid_to),
                    buyer: str(row.buyer),
                    productCount: 0,
                    priceDefCount: 0,
                    fields: new Set(),
                });
            }
            const list = lists.get(key);
            list.priceDefCount++;
            if (!seenOnThisProduct.has(key)) {
                list.productCount++;
                seenOnThisProduct.add(key);
            }
            for (const field of Object.keys(row.price_def || {})) list.fields.add(field);
        }
    }

    return lists;
}

/** Public shape of a discovered price list (Sets flattened for JSON). */
function toPricelistView(list) {
    return {
        key: list.key,
        code: list.code,
        salesPurchase: list.salesPurchase,
        title: list.title,
        currency: list.currency,
        validFrom: list.validFrom,
        validTo: list.validTo,
        buyer: list.buyer,
        productCount: list.productCount,
        priceDefCount: list.priceDefCount,
        fields: [...list.fields].sort(),
    };
}

/**
 * Discovery: the price lists of one company, newest-numbered last.
 * Used by GET /api/v1/pricelists to populate the mapping editor.
 */
async function listPricelists(secret_key, company_id) {
    const products = await listProductsWithPricelists(secret_key, company_id);
    const lists = [...indexPricelists(products).values()].map(toPricelistView);
    lists.sort(
        (a, b) =>
            a.salesPurchase.localeCompare(b.salesPurchase) ||
            (parseNumber(a.code) ?? 0) - (parseNumber(b.code) ?? 0),
    );
    return { lists, productCount: products.length };
}

/**
 * productCode → (pricelist key → price_def[]).
 * Products with no `code` are dropped: `code` is the cross-company join key and a blank
 * one cannot be matched to anything.
 */
function indexProductPrices(products) {
    const byProduct = new Map();

    for (const product of products) {
        const code = str(product.code);
        if (!code) continue;

        const perList = new Map();
        for (const row of pricelistRowsOf(product)) {
            const key = plKey(row.sales_purchase, row.count_code);
            if (!row.price_def || typeof row.price_def !== "object") continue;
            // The read side gives one row per price definition; the write side wants them
            // grouped into a price_def array per list. Regroup here.
            const defs = perList.get(key) || [];
            defs.push({ ...row.price_def });
            perList.set(key, defs);
        }

        byProduct.set(code, { product, perList });
    }

    return byProduct;
}

// ── Metakocka writes (CREAGLOBE only) ────────────────────────────────────────

/**
 * Pushes one product's price list changes. The payload is deliberately MINIMAL — the
 * product's own `count_code` plus the `pricelist` array — so a price sync can never
 * accidentally rewrite a name, unit or category. `pricelist` only ever names the lists
 * being changed, and Metakocka leaves every other list on that product alone.
 */
async function pushProductUpdate(targetCountCode, pricelist, secret_key, company_id) {
    const url = `${config.metakocka.baseUrl}${config.metakocka.productUpdatePath}`;
    const res = await axios.post(
        url,
        {
            secret_key,
            company_id,
            count_code: targetCountCode,
            pricelist,
        },
        { headers: { "Content-Type": "application/json" } },
    );
    return res.data;
}

// ── orchestration ────────────────────────────────────────────────────────────

const CONCURRENCY = 4;

/**
 * Synchronises prices one way: T4A (master) → CREAGLOBE (mirror).
 *
 * @param {object}   opts
 * @param {Array}    opts.mappings   Enabled source→target list pairs. Each:
 *                                   { id, sourceCode, sourceSalesPurchase, sourceTitle,
 *                                     targetCode, targetSalesPurchase, targetTitle,
 *                                     allowUnseenTarget }
 * @param {boolean} [opts.dryRun]    Resolve the whole plan WITHOUT writing to CREAGLOBE.
 * @returns {Promise<object>} success flag, counts, per-list breakdown, changes and errors.
 */
async function pricelistsSync(opts = {}) {
    const dryRun = !!opts.dryRun;
    const mappings = (opts.mappings || []).filter((m) => m.enabled !== false);

    if (mappings.length === 0) {
        // Not an error — a fresh install simply has nothing mapped yet. Saying so plainly
        // beats a "0 changes, all good" that hides an unconfigured sync.
        return {
            success: true,
            dryRun,
            noMappings: true,
            counts: { mappings: 0, products: 0, added: 0, updated: 0, unchanged: 0, blocked: 0, extra: 0, skippedMissingProduct: 0 },
            perList: [],
            buckets: [],
            changes: [],
            warnings: [],
            errors: [],
        };
    }

    const [sourceProducts, targetProducts] = await Promise.all([
        listProductsWithPricelists(process.env.MK_SECRET_KEY_T4A, process.env.MK_COMPANY_ID_T4A),
        listProductsWithPricelists(process.env.MK_SECRET_KEY_CREAGLOBE, process.env.MK_COMPANY_ID_CREAGLOBE),
    ]);

    const sourceLists = indexPricelists(sourceProducts);
    const targetLists = indexPricelists(targetProducts);
    const sourceByCode = indexProductPrices(sourceProducts);
    const targetByCode = indexProductPrices(targetProducts);

    const errors = [];
    const changes = [];
    const perList = [];

    // productCode → the pricelist[] entries queued for it. One product_update per product
    // carries every list that changed for it: 13 mapped lists over ~1500 products would
    // otherwise be ~20k HTTP calls instead of ~1.5k.
    const queued = new Map();

    let added = 0;
    let updated = 0;
    let unchanged = 0;
    let extraTotal = 0;
    let skippedMissingProduct = 0;

    let blockedTotal = 0;

    for (const mapping of mappings) {
        // null / absent = no limit. 0 would mean "block every change", so treat only a
        // finite positive number as a rail.
        const rawLimit = parseNumber(mapping.maxChangePct);
        const maxChangePct = rawLimit !== null && rawLimit > 0 ? rawLimit : null;
        const sourceKey = plKey(mapping.sourceSalesPurchase, mapping.sourceCode);
        const targetKey = plKey(mapping.targetSalesPurchase, mapping.targetCode);
        const sourceList = sourceLists.get(sourceKey);
        const targetList = targetLists.get(targetKey);

        const listReport = {
            mappingId: mapping.id ?? null,
            source: {
                code: mapping.sourceCode,
                salesPurchase: str(mapping.sourceSalesPurchase) || "sales",
                title: sourceList?.title ?? mapping.sourceTitle ?? null,
            },
            target: {
                code: mapping.targetCode,
                salesPurchase: str(mapping.targetSalesPurchase) || "sales",
                title: targetList?.title ?? mapping.targetTitle ?? null,
            },
            added: 0,
            updated: 0,
            unchanged: 0,
            blocked: 0,
            extra: 0,
            skippedMissingProduct: 0,
            skipped: null,
        };

        if (!sourceList) {
            // The mapped T4A list no longer carries any product (renumbered, emptied or
            // deleted). Nothing to copy — say so instead of reporting a clean run.
            listReport.skipped = "source-list-not-found";
            errors.push({
                system: "T4A",
                scope: "mapping",
                list: `${listReport.source.salesPurchase} ${mapping.sourceCode}`,
                action: "read",
                message: `Source price list ${mapping.sourceCode} (${listReport.source.salesPurchase}) was not found in T4A — it has no products on it, or its code changed.`,
            });
            perList.push(listReport);
            continue;
        }

        if (!targetList && !mapping.allowUnseenTarget) {
            // Price lists are only visible through the products on them, so an empty CG list
            // is indistinguishable from one that does not exist. Writing blind could land
            // prices on the wrong list (codes differ per company) — refuse unless the
            // mapping explicitly opts in.
            listReport.skipped = "target-list-not-seen";
            errors.push({
                system: "CREAGLOBE",
                scope: "mapping",
                list: `${listReport.target.salesPurchase} ${mapping.targetCode}`,
                action: "write",
                message: `Target price list ${mapping.targetCode} (${listReport.target.salesPurchase}) was not seen in CREAGLOBE. Metakocka only reveals a price list through the products on it, so it is either empty or does not exist. Put one product on it in Metakocka, or tick "allow unseen target" on the mapping to write anyway.`,
            });
            perList.push(listReport);
            continue;
        }

        for (const [code, source] of sourceByCode) {
            const sourceDefs = source.perList.get(sourceKey);
            if (!sourceDefs || sourceDefs.length === 0) continue; // not on this T4A list

            const target = targetByCode.get(code);
            if (!target) {
                // The product itself is missing from CREAGLOBE. Creating products is product
                // sync's job, not ours — skip and report.
                listReport.skippedMissingProduct++;
                skippedMissingProduct++;
                continue;
            }

            const targetCountCode = str(target.product.count_code);
            if (!targetCountCode) {
                errors.push({
                    system: "CREAGLOBE",
                    product_code: code,
                    action: "update",
                    message: "CREAGLOBE product has no count_code, so it cannot be addressed for a price update.",
                });
                continue;
            }

            const targetDefs = target.perList.get(targetKey) || [];
            const isAdd = targetDefs.length === 0;

            if (!isAdd && defsEqual(sourceDefs, targetDefs)) {
                listReport.unchanged++;
                unchanged++;
                continue;
            }

            // Resolve the payload FIRST so the rail and the change summary both describe what
            // will actually be written rather than the raw T4A row. VAT is mirrored 1:1: the
            // tax always comes from T4A, and a blank one becomes the 0% code (Metakocka
            // refuses a line with no tax at all).
            const mergedDefs = sourceDefs.map((sourceDef, i) => {
                const merged = mergeDef(sourceDef, targetDefs[i]);
                // Whatever CREAGLOBE had is replaced, not merged — otherwise a stale EX4
                // would survive a T4A row that carries no VAT.
                delete merged.tax;
                delete merged.tax_factor;
                return { ...merged, ...resolveTax(sourceDef) };
            });

            // Safety rail: refuse a price move larger than the mapping allows. Guards against
            // a mapped pair whose two lists do not hold the same kind of number (net vs gross
            // is the observed case) quietly rewriting a whole catalogue. Adds are exempt —
            // there is no previous price to move away from.
            if (!isAdd && maxChangePct !== null) {
                const move = priceMoveFraction(mergedDefs, targetDefs);
                if (move !== null && move * 100 > maxChangePct) {
                    listReport.blocked++;
                    blockedTotal++;
                    changes.push({
                        productCode: code,
                        productName: str(target.product.name),
                        list: listReport.target.title || mapping.targetCode,
                        action: "blocked",
                        summary: `${summarizeDefChange(mergedDefs, targetDefs)} — ${(move * 100).toFixed(1)}% move exceeds the ${maxChangePct}% limit, not written`,
                    });
                    continue;
                }
            }

            const entry = queued.get(code) || {
                productCode: code,
                productName: str(target.product.name),
                targetCountCode,
                pricelist: [],
            };
            entry.pricelist.push({ count_code: mapping.targetCode, price_def: mergedDefs });
            queued.set(code, entry);

            if (isAdd) {
                listReport.added++;
                added++;
            } else {
                listReport.updated++;
                updated++;
            }

            changes.push({
                productCode: code,
                productName: str(target.product.name),
                list: listReport.target.title || mapping.targetCode,
                action: isAdd ? "add" : "update",
                summary: isAdd
                    ? `added at ${mergedDefs.map((d) => d.price ?? d.price_with_tax ?? "—").join(" / ")}`
                    : summarizeDefChange(mergedDefs, targetDefs),
            });
        }

        // Products on the CREAGLOBE list that T4A's list does not carry. Never removed —
        // Metakocka documents no reliable "remove product from price list" call, and the
        // product may legitimately be CREAGLOBE-only. Counted so the drift stays visible.
        for (const [code, target] of targetByCode) {
            if (!(target.perList.get(targetKey) || []).length) continue;
            const source = sourceByCode.get(code);
            if (source && (source.perList.get(sourceKey) || []).length) continue;
            listReport.extra++;
            extraTotal++;
        }

        perList.push(listReport);
    }

    const updates = [...queued.values()];

    if (!dryRun) {
        const key = process.env.MK_SECRET_KEY_CREAGLOBE;
        const company = process.env.MK_COMPANY_ID_CREAGLOBE;

        await mapLimit(updates, CONCURRENCY, async (update) => {
            const fail = (message) =>
                errors.push({
                    system: "CREAGLOBE",
                    product_code: update.productCode,
                    action: "update",
                    message,
                    // The exact payload Metakocka refused. Its messages are not always about
                    // what they appear to be about (see resolveTax), so the payload is the
                    // only reliable starting point.
                    payload: JSON.stringify(update.pricelist).slice(0, 500),
                });

            try {
                const data = await pushProductUpdate(update.targetCountCode, update.pricelist, key, company);
                if (data.opr_code !== "0") {
                    fail(data.opr_desc_app || data.opr_desc || `opr_code ${data.opr_code}`);
                }
            } catch (err) {
                fail(
                    err.response?.data?.opr_desc_app ||
                        err.response?.data?.opr_desc ||
                        err.message ||
                        String(err),
                );
            }
        });
    }

    const warnings = [];

    // Buckets mirror the shape the other syncs use for the admin's run-details view.
    const buckets = [
        { key: "added", count: added },
        { key: "updated", count: updated },
        { key: "unchanged", count: unchanged },
        { key: "blockedByLimit", count: blockedTotal },
        { key: "extraInCreaglobe", count: extraTotal },
        { key: "skippedMissingProduct", count: skippedMissingProduct },
    ];

    return {
        success: errors.length === 0,
        dryRun,
        counts: {
            mappings: mappings.length,
            products: updates.length,
            added,
            updated,
            unchanged,
            blocked: blockedTotal,
            extra: extraTotal,
            skippedMissingProduct,
            sourceProducts: sourceProducts.length,
            targetProducts: targetProducts.length,
        },
        perList,
        buckets,
        changes,
        warnings,
        errors,
    };
}

/**
 * Suggests source→target pairs by exact (case-insensitive) title, sales lists only.
 * A suggestion is never applied on its own — it only pre-fills the mapping editor, because
 * a wrong pair writes one tier's prices into another.
 */
function suggestMappings(sourceLists, targetLists) {
    const byTitle = new Map();
    for (const list of targetLists) {
        if (list.salesPurchase !== "sales") continue;
        const title = (list.title || "").trim().toLowerCase();
        if (title && !byTitle.has(title)) byTitle.set(title, list);
    }

    return sourceLists
        .filter((list) => list.salesPurchase === "sales")
        .map((list) => {
            const hit = byTitle.get((list.title || "").trim().toLowerCase());
            return {
                sourceCode: list.code,
                sourceSalesPurchase: list.salesPurchase,
                sourceTitle: list.title,
                sourceProductCount: list.productCount,
                targetCode: hit ? hit.code : null,
                targetSalesPurchase: hit ? hit.salesPurchase : null,
                targetTitle: hit ? hit.title : null,
                targetProductCount: hit ? hit.productCount : null,
                confidence: hit ? "title-exact" : "none",
            };
        });
}

module.exports = {
    pricelistsSync,
    listPricelists,
    suggestMappings,
    // exported for tests / reuse
    plKey,
    parseNumber,
    defsEqual,
    mergeDef,
    writableDef,
    resolveTax,
    taxStateOf,
    WRITABLE_PRICE_DEF_FIELDS,
    NO_VAT_TAX_CODE,
    DESTRUCTIVE_TAX_CODES,
};
