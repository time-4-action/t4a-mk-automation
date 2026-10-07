require("./src/config/env");

// Node.js built-in modules
const fs = require("fs").promises;
const path = require("path");

// Third-party modules
const axios = require("axios");
const cron = require("node-cron");
const express = require("express");
const { isValidCron } = require("cron-validator");
const { CronExpressionParser } = require("cron-parser");
const Database = require('better-sqlite3');
const csv = require('csv-parser');
const { Readable } = require('stream');

// Local modules
const { loadCronExpression } = require("./cron");
// After cron.js has loaded the .env and before any service runs: refuses production targets
// unless APP_ENV=production, and applies MK_BASE_URL.
const { IS_PRODUCTION } = require("./src/config/envGuard");
const config = require("./config/config.json");
const { error } = require("console");
const { productsSync, PRODUCTS_SYNC_PARAMS } = require("./src/services/productSyncService");
const { customersSync } = require("./src/services/customerSyncService");
const { pricelistsSync, listPricelists, suggestMappings } = require("./src/services/pricelistSyncService");

console.log(process.env.WHAT_ENV)

const app = express();
const PORT = 3000;

// Tell Express to trust proxy headers like 'X-Forwarded-For'
app.set('trust proxy', ["192.168.1.180"]);

// prevent API overload
// const apiLimiter = rateLimit({
//     windowMs: 15 * 60 * 1000, // 15 minutes
//     max: 100, // limit each IP to 100 requests per windowMs
//     message: {
//         error: "Too many requests from this IP, please try again later."
//     },
//     standardHeaders: true, // Return rate limit info in headers
//     legacyHeaders: false,   // Disable old headers
// });

// // Apply rate limiting to all incoming requests
// app.use(apiLimiter);

// Parse JSON payloads and make them available on req.body
app.use(express.json());

// Request logger — logs every API call so you can see what was triggered and, together with the
// auth logging below, exactly why a request was (un)authorized. Static assets are skipped.
app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
        const hasKey = !!req.header("x-api-key");
        console.log(
            `${logTs()} → ${req.method} ${req.originalUrl} from ${req.ip}` +
            ` | x-api-key: ${hasKey ? "present" : "MISSING"}`
        );
    }
    next();
});

// SQLite database
const db = new Database(process.env.DB_FILE_PATH || "./db/patrik.db");
db.prepare(`
  CREATE TABLE IF NOT EXISTS warehouse_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link TEXT,
    sync_name TEXT DEFAULT 'T4A',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS product_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_name TEXT,              -- e.g., timestamped JSON file name
    status TEXT,                 -- "new" or "updated" for this batch
    source_warehouse TEXT,       -- warehouse name the data came from
    target_warehouse TEXT,       -- warehouse name the data is synced to
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS customer_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_name TEXT,              -- timestamped JSON file name
    source_company TEXT,        -- 'T4A'
    target_company TEXT,        -- 'CREAGLOBE'
    created INTEGER,            -- partners created in target this run
    updated INTEGER,           -- partners updated in target this run
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

db.prepare(`
  CREATE TABLE IF NOT EXISTS pricelist_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_name TEXT,              -- timestamped JSON file name
    source_company TEXT,         -- 'T4A'
    target_company TEXT,         -- 'CREAGLOBE'
    added INTEGER,               -- product/price rows added to a target list this run
    updated INTEGER,             -- product/price rows updated in a target list this run
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();

// Source → target price-list pairs, entered by a human.
//
// This table is the whole safety mechanism of the pricelist sync. A price list's
// count_code is a per-company counter and does NOT identify the same list across the two
// companies — live data has T4A 7 = "PP GOLD 2026" against CREAGLOBE 7 = "PP BRONZE 2026".
// Syncing by code would write GOLD prices into BRONZE, so nothing is ever synced that is
// not explicitly paired here. Identity is (sales_purchase, count_code): Metakocka numbers
// sales and purchase lists separately, so the code alone is ambiguous even within one
// company.
db.prepare(`
  CREATE TABLE IF NOT EXISTS pricelist_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_code TEXT NOT NULL,             -- T4A price list count_code
    source_sales_purchase TEXT NOT NULL DEFAULT 'sales',
    source_title TEXT,                     -- snapshot, for display when a list goes empty
    target_code TEXT NOT NULL,             -- CREAGLOBE price list count_code
    target_sales_purchase TEXT NOT NULL DEFAULT 'sales',
    target_title TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    allow_unseen_target INTEGER NOT NULL DEFAULT 0,
    -- Safety rail: refuse any single price move larger than this percentage and report it
    -- instead of writing. NULL = no limit. Exists because two mapped lists can hold
    -- different KINDS of number (live data had CREAGLOBE storing gross where T4A stores
    -- net), and a blind sync would then rewrite a whole catalogue by the VAT factor.
    max_change_pct REAL,
    -- (default_tax was dropped: VAT is mirrored 1:1 from T4A, so a blank one becomes the 0%
    -- code automatically and there is nothing for a human to choose. The column is left in
    -- place, unused, so existing databases need no migration.)
    default_tax TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run();
// One source list may only be mapped once — two mappings for the same source would race
// each other writing different prices onto the same products.
db.prepare(`
  CREATE UNIQUE INDEX IF NOT EXISTS pricelist_map_source_unique
  ON pricelist_map (source_sales_purchase, source_code)
`).run();

// Unified run history for the admin "Automation" page: one row per warehouse/product
// sync (scheduled or manual) with its outcome, duration and item count. node-cron exposes
// no last-run/next-run info, so we track it ourselves here.
db.prepare(`
  CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,                   -- 'warehouse' | 'products' | 'customers' | 'pricelists'
    trigger TEXT,                -- 'manual' | 'schedule'
    status TEXT,                 -- 'running' | 'ok' | 'error'
    item_count INTEGER,
    error TEXT,
    details TEXT,                -- JSON: per-warehouse breakdown / product change buckets + error list
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    finished_at DATETIME,
    duration_ms INTEGER
  )
`).run();
// Back-fill columns added to pricelist_map after the table first shipped.
try { db.prepare(`ALTER TABLE pricelist_map ADD COLUMN max_change_pct REAL`).run(); } catch (e) { /* column already exists */ }
try { db.prepare(`ALTER TABLE pricelist_map ADD COLUMN default_tax TEXT`).run(); } catch (e) { /* column already exists */ }

// Back-fill the details column on databases created before it existed.
try { db.prepare(`ALTER TABLE sync_runs ADD COLUMN details TEXT`).run(); } catch (e) { /* column already exists */ }

// Holds the warehouse sync cron job instance for later control
var WAREHOUSE_SYNC_CRON_JOB;
var PRODUCT_SYNC_CRON_JOB;
var CUSTOMER_SYNC_CRON_JOB;
var PRICELIST_SYNC_CRON_JOB;

// Load initial cron expression (e.g., "*/5 * * * *" → every 5 minutes)
const initialCronExpression = loadCronExpression();

// Start or update the warehouse sync job with the loaded schedule
startOrUpdateWarehousesCron(initialCronExpression);

// Start the product sync job too. Without this it was only ever scheduled when the
// PUT /api/v1/schedules/product-sync endpoint was hit, so on a plain restart the
// product sync never ran on its cron schedule. Fall back to hourly if the key is absent.
const initialProductCronExpression = loadCronExpression("productSync") || "0 * * * *";
startOrUpdateProductsCron(initialProductCronExpression);

// Start the customer (partner) sync job on boot too. One-way T4A → CREAGLOBE, like products.
// Default to every 6 hours if the key is absent — customer data changes less often than stock.
const initialCustomerCronExpression = loadCronExpression("customerSync") || "0 */6 * * *";
startOrUpdateCustomersCron(initialCustomerCronExpression);

// Start the pricelist (price) sync job on boot too. One-way T4A → CREAGLOBE. Default to
// daily at 04:00: prices change rarely, and a run rewrites money — it should not fire more
// often than someone would want to review it. A run with no mappings configured is a no-op.
const initialPricelistCronExpression = loadCronExpression("pricelistSync") || "0 4 * * *";
startOrUpdatePricelistsCron(initialPricelistCronExpression);

// API key from environment for route authentication
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
    console.warn(`${logTs()} ⚠️  API_KEY is NOT set in the environment — every authenticated request will be rejected with 401.`);
} else {
    console.log(`${logTs()} 🔑 API_KEY loaded (${maskSecret(API_KEY)}).`);
}

// Short timestamp prefix for log lines (local time, HH:MM:SS).
function logTs() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `[${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}]`;
}

// Masks a secret for logging: never prints the full value. e.g. "ab…yz (len 24)".
function maskSecret(s) {
    if (s == null || s === "") return "(none)";
    const str = String(s);
    if (str.length <= 4) return `**** (len ${str.length})`;
    return `${str.slice(0, 2)}…${str.slice(-2)} (len ${str.length})`;
}

// Middleware to verify API key. On failure it logs WHY (missing header, key mismatch, or the
// server having no API_KEY configured) with masked values so the reason is visible in the logs
// without ever leaking the actual key.
function authenticate(req, res, next) {
    const apiKey = req.header("x-api-key");

    if (!API_KEY) {
        console.error(`${logTs()} ⛔ 401 ${req.method} ${req.originalUrl} — server has no API_KEY configured.`);
        return res.status(401).json({ error: "Unauthorized" });
    }
    if (!apiKey) {
        console.error(`${logTs()} ⛔ 401 ${req.method} ${req.originalUrl} from ${req.ip} — no x-api-key header sent.`);
        return res.status(401).json({ error: "Unauthorized" });
    }
    if (apiKey !== API_KEY) {
        console.error(
            `${logTs()} ⛔ 401 ${req.method} ${req.originalUrl} from ${req.ip} — x-api-key mismatch.` +
            ` received ${maskSecret(apiKey)}, expected ${maskSecret(API_KEY)}.`
        );
        return res.status(401).json({ error: "Unauthorized" });
    }

    console.log(`${logTs()} ✅ auth ok — ${req.method} ${req.originalUrl}`);
    next();
}

// Liveness probe for the deploy and the public check. No auth and no DB, so an outage of
// Metakocka or SQLite never triggers a rollback.
app.get("/healthz", (req, res) => {
    res.json({ ok: true, version: process.env.APP_VERSION || "dev", env: IS_PRODUCTION ? "production" : "development" });
});

// GET endpoint to check server uptime / health
app.get("/api/v1/uptime", (req, res) => {
    // Respond with a simple success message
    res.json({ success: true });
});

// POST endpoint to trigger warehouse data sync. Runs in the background and records the
// outcome in sync_runs; responds 202 immediately (or 409 if a sync is already running).
app.post("/api/v1/warehouse/sync", authenticate, (req, res) => {
    const r = runWarehouseSync("manual");
    if (!r.started) {
        return res.status(409).json({ error: "A warehouse sync is already running." });
    }
    res.status(202).json({ started: true, runId: r.runId, startedAt: new Date().toISOString() });
});

app.get("/api/v1/warehouse/sync/logs", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;

        const rows = db.prepare(`
            SELECT link, sync_name, created_at
            FROM warehouse_sync_log
            ORDER BY created_at DESC
            LIMIT ?
        `).all(limit);

        res.json(rows);
    } catch (err) {
        console.error("Error fetching warehouse logs:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

// PUT endpoint to trigger update of warehouse sync cron schedule
app.put("/api/v1/schedules/warehouse-sync", authenticate, async (req, res) => {
    try {
        const { warehouseSync } = req.body;

        // Ensure cron expression is provided
        if (!warehouseSync) {
            return res.status(400).json({ error: "warehouseSync (cron expression) is required" });
        }

        // Validate the cron expression format
        if (!isValidCron(warehouseSync, { seconds: false }) || !cron.validate(warehouseSync)) {
            return res.status(400).json({ error: "Invalid cron expression" });
        }

        const cronFilePath = process.env.CRON_FILE_PATH || path.join(__dirname, "cron.json");
        let currentConfig = {};

        try {
            // Load existing cron configuration if it exists
            const fileContent = await fs.readFile(cronFilePath, "utf8");
            currentConfig = JSON.parse(fileContent);
        } catch (err) {
            if (err.code !== "ENOENT") throw err; // Ignore missing file, but throw other errors
        }

        // Update the config with the new cron expression
        currentConfig.warehouseSync = warehouseSync;

        // Apply the new schedule immediately
        startOrUpdateWarehousesCron(warehouseSync);

        // Persist the updated config
        await fs.writeFile(cronFilePath, JSON.stringify(currentConfig, null, 2), "utf8");

        res.json({
            message: "Warehouse cron expression updated successfully",
            warehouseSync
        });
    } catch (err) {
        console.error("Error updating cron.json:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

// GET endpoint to fetch the current warehouse-sync cron expression (no auth)
app.get("/api/v1/schedules/warehouse-sync", async (req, res) => {
    try {
        // Determine cron.json file path (env override or default)
        const cronFilePath = process.env.CRON_FILE_PATH || path.join(__dirname, "cron.json");
        let currentConfig = {};

        try {
            // Read and parse existing cron configuration
            const fileContent = await fs.readFile(cronFilePath, "utf8");
            currentConfig = JSON.parse(fileContent);
        } catch (err) {
            if (err.code !== "ENOENT") throw err; // ignore missing file, throw other errors
        }

        // Return current cron expression, or fallback to default
        res.json({
            warehouseSync: currentConfig.warehouseSync || loadCronExpression()
        });
    } catch (err) {
        console.error("Error reading cron.json:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});


// POST endpoint to trigger product sync. Background + recorded; 202 (or 409 if running).
app.post("/api/v1/products/sync", authenticate, (req, res) => {
    const r = runProductSync("manual");
    if (!r.started) {
        return res.status(409).json({ error: "A product sync is already running." });
    }
    res.status(202).json({ started: true, runId: r.runId, startedAt: new Date().toISOString() });
});

app.get("/api/v1/products/sync/logs", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const rows = db.prepare(`
            SELECT sync_name, status, source_warehouse, target_warehouse, created_at
            FROM product_sync_log
            ORDER BY created_at DESC
            LIMIT ?
        `).all(limit);

        res.json(rows);
    } catch (err) {
        console.error("Error fetching product logs:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

app.put("/api/v1/schedules/product-sync", authenticate, async (req, res) => {
    try {
        const { productSync } = req.body;

        if (!productSync) return res.status(400).json({ error: "productSync (cron expression) is required" });
        if (!isValidCron(productSync, { seconds: false }) || !cron.validate(productSync)) return res.status(400).json({ error: "Invalid cron expression" });

        const cronFilePath = process.env.CRON_FILE_PATH || path.join(__dirname, "cron.json");
        let currentConfig = {};

        try {
            const fileContent = await fs.readFile(cronFilePath, "utf8");
            currentConfig = JSON.parse(fileContent);
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }

        currentConfig.productSync = productSync;

        // Apply immediately
        startOrUpdateProductsCron(productSync);

        await fs.writeFile(cronFilePath, JSON.stringify(currentConfig, null, 2), "utf8");

        res.json({ message: "Product cron expression updated successfully", productSync });
    } catch (err) {
        console.error("Error updating cron.json for products:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

app.get("/api/v1/schedules/product-sync", async (req, res) => {
    try {
        const cronFilePath = process.env.CRON_FILE_PATH || path.join(__dirname, "cron.json");
        let currentConfig = {};

        try {
            const fileContent = await fs.readFile(cronFilePath, "utf8");
            currentConfig = JSON.parse(fileContent);
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }

        res.json({
            productSync: currentConfig.productSync || "0 * * * *" // default every hour
        });
    } catch (err) {
        console.error("Error reading cron.json for products:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

// POST endpoint to trigger customer sync. Background + recorded; 202 (or 409 if running).
// Pass ?dryRun=true to compute the plan (matches / creates / updates) WITHOUT writing to
// CREAGLOBE — the run is still recorded so you can preview it in the admin.
app.post("/api/v1/customers/sync", authenticate, (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.query.dryRun === "1";
    const r = runCustomerSync("manual", { dryRun });
    if (!r.started) {
        return res.status(409).json({ error: "A customer sync is already running." });
    }
    res.status(202).json({ started: true, runId: r.runId, dryRun, startedAt: new Date().toISOString() });
});

app.get("/api/v1/customers/sync/logs", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const rows = db.prepare(`
            SELECT sync_name, source_company, target_company, created, updated, created_at
            FROM customer_sync_log
            ORDER BY created_at DESC
            LIMIT ?
        `).all(limit);

        res.json(rows);
    } catch (err) {
        console.error("Error fetching customer logs:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

app.put("/api/v1/schedules/customer-sync", authenticate, async (req, res) => {
    try {
        const { customerSync } = req.body;

        if (!customerSync) return res.status(400).json({ error: "customerSync (cron expression) is required" });
        if (!isValidCron(customerSync, { seconds: false }) || !cron.validate(customerSync)) return res.status(400).json({ error: "Invalid cron expression" });

        const cronFilePath = process.env.CRON_FILE_PATH || path.join(__dirname, "cron.json");
        let currentConfig = {};

        try {
            const fileContent = await fs.readFile(cronFilePath, "utf8");
            currentConfig = JSON.parse(fileContent);
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }

        currentConfig.customerSync = customerSync;

        // Apply immediately
        startOrUpdateCustomersCron(customerSync);

        await fs.writeFile(cronFilePath, JSON.stringify(currentConfig, null, 2), "utf8");

        res.json({ message: "Customer cron expression updated successfully", customerSync });
    } catch (err) {
        console.error("Error updating cron.json for customers:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

app.get("/api/v1/schedules/customer-sync", async (req, res) => {
    try {
        const cronFilePath = process.env.CRON_FILE_PATH || path.join(__dirname, "cron.json");
        let currentConfig = {};

        try {
            const fileContent = await fs.readFile(cronFilePath, "utf8");
            currentConfig = JSON.parse(fileContent);
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }

        res.json({
            customerSync: currentConfig.customerSync || "0 */6 * * *" // default every 6 hours
        });
    } catch (err) {
        console.error("Error reading cron.json for customers:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

// ── Pricelist sync ───────────────────────────────────────────────────────────────────
//
// Metakocka has NO endpoint that lists price lists, so /pricelists derives them by
// scanning json/product_list with return_pricelist and de-duplicating. A list carrying no
// products is therefore invisible — which is exactly why a mapping to an unseen target is
// refused unless it opts in.

/** DB row → the shape pricelistSyncService expects. */
function toMappingView(row) {
    return {
        id: row.id,
        sourceCode: row.source_code,
        sourceSalesPurchase: row.source_sales_purchase,
        sourceTitle: row.source_title,
        targetCode: row.target_code,
        targetSalesPurchase: row.target_sales_purchase,
        targetTitle: row.target_title,
        enabled: row.enabled === 1,
        allowUnseenTarget: row.allow_unseen_target === 1,
        maxChangePct: row.max_change_pct === null || row.max_change_pct === undefined ? null : Number(row.max_change_pct),
        updatedAt: row.updated_at
    };
}

function readMappings() {
    return db.prepare(`SELECT * FROM pricelist_map ORDER BY id`).all().map(toMappingView);
}

// GET the mapped source→target price-list pairs.
app.get("/api/v1/pricelists/mappings", authenticate, (req, res) => {
    try {
        res.json({ mappings: readMappings() });
    } catch (err) {
        console.error("Error reading pricelist mappings:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

// PUT replaces the whole mapping set in one transaction — the admin's mapping editor saves
// the table as a unit, and a partial write would leave prices pointing at the wrong lists.
app.put("/api/v1/pricelists/mappings", authenticate, (req, res) => {
    try {
        const incoming = req.body?.mappings;
        if (!Array.isArray(incoming)) {
            return res.status(400).json({ error: "mappings (array) is required" });
        }

        const clean = [];
        const seen = new Set();
        for (const m of incoming) {
            const sourceCode = m.sourceCode == null ? "" : String(m.sourceCode).trim();
            const targetCode = m.targetCode == null ? "" : String(m.targetCode).trim();
            const sourceSp = String(m.sourceSalesPurchase || "sales").trim();
            const targetSp = String(m.targetSalesPurchase || "sales").trim();

            if (!sourceCode || !targetCode) {
                return res.status(400).json({ error: "every mapping needs a sourceCode and a targetCode" });
            }
            if (!["sales", "purchase"].includes(sourceSp) || !["sales", "purchase"].includes(targetSp)) {
                return res.status(400).json({ error: "salesPurchase must be 'sales' or 'purchase'" });
            }

            // A source list may only be mapped once — two mappings for one source would race
            // each other writing different prices onto the same products.
            const key = `${sourceSp}|${sourceCode}`;
            if (seen.has(key)) {
                return res.status(400).json({ error: `source price list ${sourceCode} (${sourceSp}) is mapped more than once` });
            }
            seen.add(key);

            // Optional safety rail. Reject nonsense early rather than silently ignoring it.
            let maxChangePct = null;
            if (m.maxChangePct !== null && m.maxChangePct !== undefined && m.maxChangePct !== "") {
                maxChangePct = Number(m.maxChangePct);
                if (!Number.isFinite(maxChangePct) || maxChangePct <= 0) {
                    return res.status(400).json({ error: "maxChangePct must be a positive number of percent, or null for no limit" });
                }
            }

            clean.push({
                max_change_pct: maxChangePct,
                source_code: sourceCode,
                source_sales_purchase: sourceSp,
                source_title: m.sourceTitle == null ? null : String(m.sourceTitle),
                target_code: targetCode,
                target_sales_purchase: targetSp,
                target_title: m.targetTitle == null ? null : String(m.targetTitle),
                enabled: m.enabled === false ? 0 : 1,
                allow_unseen_target: m.allowUnseenTarget === true ? 1 : 0
            });
        }

        const replace = db.transaction((rows) => {
            db.prepare(`DELETE FROM pricelist_map`).run();
            const insert = db.prepare(`
                INSERT INTO pricelist_map
                  (source_code, source_sales_purchase, source_title,
                   target_code, target_sales_purchase, target_title,
                   enabled, allow_unseen_target, max_change_pct, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `);
            for (const r of rows) {
                insert.run(
                    r.source_code, r.source_sales_purchase, r.source_title,
                    r.target_code, r.target_sales_purchase, r.target_title,
                    r.enabled, r.allow_unseen_target, r.max_change_pct
                );
            }
        });
        replace(clean);

        console.log(`${logTs()} 🔗 pricelist mappings replaced — ${clean.length} pair(s), ${clean.filter(r => r.enabled).length} enabled.`);
        res.json({ mappings: readMappings() });
    } catch (err) {
        console.error("Error saving pricelist mappings:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

// Discovery: the price lists visible in each company, plus title-matched suggestions and
// the mappings already saved. Cached briefly — it costs a full catalogue scan per company.
let PRICELIST_DISCOVERY_CACHE = null;
const PRICELIST_DISCOVERY_TTL_MS = 5 * 60 * 1000;

app.get("/api/v1/pricelists", authenticate, async (req, res) => {
    try {
        const fresh = req.query.refresh === "true" || req.query.refresh === "1";
        if (!fresh && PRICELIST_DISCOVERY_CACHE && Date.now() - PRICELIST_DISCOVERY_CACHE.at < PRICELIST_DISCOVERY_TTL_MS) {
            return res.json({ ...PRICELIST_DISCOVERY_CACHE.value, cached: true, mappings: readMappings() });
        }

        const [source, target] = await Promise.all([
            listPricelists(process.env.MK_SECRET_KEY_T4A, process.env.MK_COMPANY_ID_T4A),
            listPricelists(process.env.MK_SECRET_KEY_CREAGLOBE, process.env.MK_COMPANY_ID_CREAGLOBE)
        ]);

        const value = {
            source: { company: "T4A", productCount: source.productCount, lists: source.lists },
            target: { company: "CREAGLOBE", productCount: target.productCount, lists: target.lists },
            suggestions: suggestMappings(source.lists, target.lists),
            scannedAt: new Date().toISOString()
        };
        PRICELIST_DISCOVERY_CACHE = { at: Date.now(), value };

        res.json({ ...value, cached: false, mappings: readMappings() });
    } catch (err) {
        console.error("Error discovering pricelists:", err);
        res.status(502).json({ error: err.message || "Could not read price lists from Metakocka" });
    }
});

// POST triggers a pricelist sync. Background + recorded; 202 (or 409 if running).
// ?dryRun=true resolves the whole plan WITHOUT writing anything to CREAGLOBE.
app.post("/api/v1/pricelists/sync", authenticate, (req, res) => {
    const dryRun = req.query.dryRun === "true" || req.query.dryRun === "1";
    const r = runPricelistSync("manual", { dryRun });
    if (!r.started) {
        return res.status(409).json({ error: "A pricelist sync is already running." });
    }
    res.status(202).json({ started: true, runId: r.runId, dryRun, startedAt: new Date().toISOString() });
});

app.get("/api/v1/pricelists/sync/logs", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 10;
        const rows = db.prepare(`
            SELECT sync_name, source_company, target_company, added, updated, created_at
            FROM pricelist_sync_log
            ORDER BY created_at DESC
            LIMIT ?
        `).all(limit);

        res.json(rows);
    } catch (err) {
        console.error("Error fetching pricelist logs:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

app.put("/api/v1/schedules/pricelist-sync", authenticate, async (req, res) => {
    try {
        const { pricelistSync } = req.body;

        if (!pricelistSync) return res.status(400).json({ error: "pricelistSync (cron expression) is required" });
        if (!isValidCron(pricelistSync, { seconds: false }) || !cron.validate(pricelistSync)) return res.status(400).json({ error: "Invalid cron expression" });

        const cronFilePath = process.env.CRON_FILE_PATH || path.join(__dirname, "cron.json");
        let currentConfig = {};

        try {
            const fileContent = await fs.readFile(cronFilePath, "utf8");
            currentConfig = JSON.parse(fileContent);
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }

        currentConfig.pricelistSync = pricelistSync;

        // Apply immediately
        startOrUpdatePricelistsCron(pricelistSync);

        await fs.writeFile(cronFilePath, JSON.stringify(currentConfig, null, 2), "utf8");

        res.json({ message: "Pricelist cron expression updated successfully", pricelistSync });
    } catch (err) {
        console.error("Error updating cron.json for pricelists:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

app.get("/api/v1/schedules/pricelist-sync", async (req, res) => {
    try {
        const cronFilePath = process.env.CRON_FILE_PATH || path.join(__dirname, "cron.json");
        let currentConfig = {};

        try {
            const fileContent = await fs.readFile(cronFilePath, "utf8");
            currentConfig = JSON.parse(fileContent);
        } catch (err) {
            if (err.code !== "ENOENT") throw err;
        }

        res.json({
            pricelistSync: currentConfig.pricelistSync || "0 4 * * *" // default daily at 04:00
        });
    } catch (err) {
        console.error("Error reading cron.json for pricelists:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

// Unified status for the admin "Automation" page: both schedules, their next fire time,
// whether a sync is currently running, and the last recorded run for each.
app.get("/api/v1/status", authenticate, (req, res) => {
    try {
        const cfg = readCronConfig();
        const warehouseCron = cfg.warehouseSync || loadCronExpression("warehouseSync");
        const productCron = cfg.productSync || "0 * * * *";
        const customerCron = cfg.customerSync || "0 */6 * * *";
        const pricelistCron = cfg.pricelistSync || "0 4 * * *";
        res.json({
            warehouse: {
                schedule: warehouseCron,
                nextRun: nextRunOf(warehouseCron),
                isRunning: WAREHOUSE_RUNNING,
                lastRun: lastRunOf("warehouse")
            },
            products: {
                schedule: productCron,
                nextRun: nextRunOf(productCron),
                isRunning: PRODUCT_RUNNING,
                lastRun: lastRunOf("products")
            },
            customers: {
                schedule: customerCron,
                nextRun: nextRunOf(customerCron),
                isRunning: CUSTOMER_RUNNING,
                lastRun: lastRunOf("customers")
            },
            pricelists: {
                schedule: pricelistCron,
                nextRun: nextRunOf(pricelistCron),
                isRunning: PRICELIST_RUNNING,
                lastRun: lastRunOf("pricelists"),
                // Surfaced so the admin can say "nothing mapped yet" instead of showing a
                // green, clean, entirely meaningless run.
                mappingCount: db.prepare(`SELECT COUNT(*) AS n FROM pricelist_map WHERE enabled = 1`).get().n
            }
        });
    } catch (err) {
        console.error("Error building status:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});

// Recent run history. Optional ?type=warehouse|products and ?limit= (max 100).
app.get("/api/v1/runs", authenticate, (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const type = req.query.type;
        const rows = type
            ? db.prepare(`SELECT * FROM sync_runs WHERE type = ? ORDER BY id DESC LIMIT ?`).all(type, limit)
            : db.prepare(`SELECT * FROM sync_runs ORDER BY id DESC LIMIT ?`).all(limit);
        res.json(rows);
    } catch (err) {
        console.error("Error fetching runs:", err);
        res.status(500).json({ error: "Internal Server Error!" });
    }
});






app.use("/data", express.static(process.env.PUBLIC_DATA_FILE_PATH || "tmp"));
app.use(express.static("public"));

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});


// Parse a value to a number, tolerating comma decimal separators on strings.
// Returns 0 for empty/invalid input so it never poisons downstream sums.
function parseNumber(value) {
    if (value == null || value === '') return 0;
    const n = typeof value === 'string' ? Number(value.replace(',', '.')) : Number(value);
    return Number.isFinite(n) ? n : 0;
}

function getTimestamp() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0'); // Months are 0-based
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const ms = String(now.getMilliseconds()).padStart(3, '0'); // Add ms

    return `${yyyy}${mm}${dd}_${hh}${min}${ss}${ms}`;
}

// ── Run tracking (powers the admin "Automation" page: status + Run now + history) ──────
// In-process guards prevent a manual run from overlapping a scheduled one (or itself).
let WAREHOUSE_RUNNING = false;
let PRODUCT_RUNNING = false;
let CUSTOMER_RUNNING = false;
let PRICELIST_RUNNING = false;

/** Next fire time of a cron expression as an ISO string, or null if it can't be parsed. */
function nextRunOf(cronExpression) {
    try {
        return CronExpressionParser.parse(cronExpression).next().toDate().toISOString();
    } catch {
        return null;
    }
}

/** Reads cron.json synchronously (for the status endpoint). Returns {} if absent. */
function readCronConfig() {
    const cronFilePath = process.env.CRON_FILE_PATH || path.join(__dirname, "cron.json");
    try {
        return JSON.parse(require("fs").readFileSync(cronFilePath, "utf8"));
    } catch {
        return {};
    }
}

/** Inserts a 'running' run row and returns its id. */
function recordRunStart(type, trigger) {
    const info = db.prepare(
        `INSERT INTO sync_runs (type, trigger, status, started_at) VALUES (?, ?, 'running', CURRENT_TIMESTAMP)`
    ).run(type, trigger);
    return info.lastInsertRowid;
}

/** Stamps a run row with its outcome, duration and (JSON) details. */
function recordRunFinish(id, { status, itemCount = null, error = null, details = null, startedAtMs }) {
    const durationMs = startedAtMs ? Date.now() - startedAtMs : null;
    db.prepare(
        `UPDATE sync_runs SET status = ?, item_count = ?, error = ?, details = ?, finished_at = CURRENT_TIMESTAMP, duration_ms = ? WHERE id = ?`
    ).run(status, itemCount, error, details, durationMs, id);
    const icon = status === "ok" ? "✅" : status === "error" ? "❌" : "⏹";
    console.log(
        `${logTs()} ${icon} run #${id} finished: ${status}` +
        `${itemCount != null ? ` · ${itemCount} item(s)` : ""}` +
        `${durationMs != null ? ` · ${durationMs}ms` : ""}` +
        `${error ? ` · ${error}` : ""}`
    );
}

/** Most recent run for a type (for the status endpoint), or null. */
function lastRunOf(type) {
    return db.prepare(
        `SELECT id, type, trigger, status, item_count, error, details, started_at, finished_at, duration_ms
         FROM sync_runs WHERE type = ? ORDER BY id DESC LIMIT 1`
    ).get(type) || null;
}

/** Total products touched by a product sync result (changes + new across both systems). */
function countProductChanges(result) {
    if (!result || typeof result !== "object") return 0;
    return Object.entries(result)
        .filter(([k, v]) => Array.isArray(v) && (k.startsWith("changes") || k.startsWith("newIn")))
        .reduce((sum, [, v]) => sum + v.length, 0);
}

/**
 * Starts a warehouse sync (scheduled or manual). Runs in the background and records the
 * outcome in sync_runs. Returns immediately: `{ started:true, runId }`, or
 * `{ started:false, reason:'already_running' }` when one is already in flight.
 */
function runWarehouseSync(trigger) {
    if (WAREHOUSE_RUNNING) {
        console.warn(`${logTs()} ⏭  warehouse sync (${trigger}) skipped — already running.`);
        return { started: false, reason: "already_running" };
    }
    WAREHOUSE_RUNNING = true;
    const startedAtMs = Date.now();
    const runId = recordRunStart("warehouse", trigger);
    console.log(`${logTs()} ▶️  warehouse sync started (${trigger}) — run #${runId}.`);
    (async () => {
        try {
            const result = await warehousesSync();
            const b = result?.breakdown || {};
            // Per-product sync failures reported by Metakocka (product not found in CREAGLOBE, etc.).
            const rawErrors = Array.isArray(result?.errors) ? result.errors : [];
            const errors = rawErrors.slice(0, 50).map((e) => ({
                product_code: e.product_code || null,
                warehouse_id: e.warehouse_id || null,
                message: e.error || e.opr_desc || "Unknown error"
            }));
            // Each source warehouse is written into its OWN matching virtual warehouse in the
            // CREAGLOBE company — the stock is kept separate per warehouse, never merged.
            // The ProMode (Germany) source is retired, so only T4A is listed now. When it's
            // re-enabled, add back: { source: "ProMode (Germany)", target: "CREAGLOBE / Germany warehouse", count: b.germany ?? null }
            const details = JSON.stringify({
                type: "warehouse",
                warehouses: [
                    { source: "T4A", target: "CREAGLOBE / T4A warehouse", count: b.t4a ?? null }
                ],
                errorCount: rawErrors.length,
                errors
            });
            recordRunFinish(runId, {
                status: rawErrors.length > 0 ? "error" : "ok",
                itemCount: b.total ?? result?.data?.length ?? null,
                error: rawErrors.length > 0 ? `${rawErrors.length} product(s) failed to sync` : null,
                details,
                startedAtMs
            });
        } catch (err) {
            recordRunFinish(runId, { status: "error", error: err.message || String(err), startedAtMs });
        } finally {
            WAREHOUSE_RUNNING = false;
        }
    })();
    return { started: true, runId };
}

/**
 * Starts a product sync (scheduled or manual). Background + recorded like the warehouse one.
 */
function runProductSync(trigger) {
    if (PRODUCT_RUNNING) {
        console.warn(`${logTs()} ⏭  product sync (${trigger}) skipped — already running.`);
        return { started: false, reason: "already_running" };
    }
    PRODUCT_RUNNING = true;
    const startedAtMs = Date.now();
    const runId = recordRunStart("products", trigger);
    console.log(`${logTs()} ▶️  product sync started (${trigger}) — run #${runId}.`);
    (async () => {
        try {
            const result = await productsSync(...PRODUCTS_SYNC_PARAMS);
            const fileTimestamp = getTimestamp();
            await saveProductSyncFile(result, fileTimestamp, "T4A", "CREAGLOBE");

            // Per-company change buckets (changes<Name> / newIn<Name>) for the run-details view.
            const buckets = Object.entries(result || {})
                .filter(([k, v]) => Array.isArray(v) && (k.startsWith("changes") || k.startsWith("newIn")))
                .map(([k, v]) => ({ key: k, count: v.length }));
            // The actual per-item errors, normalised to {system, product_code, action, message}.
            const rawErrors = Array.isArray(result?.errors) ? result.errors : [];
            const errors = rawErrors.slice(0, 50).map((e) => ({
                system: e.system || null,
                product_code: e.product_code || e.update?.code || e.product?.code || null,
                action: e.action || null,
                message:
                    e.opr_desc_app || e.opr_desc ||
                    (typeof e.error === "string"
                        ? e.error
                        : (e.error?.opr_desc_app || e.error?.opr_desc || (e.error ? JSON.stringify(e.error).slice(0, 200) : null))) ||
                    "Unknown error"
            }));
            const details = JSON.stringify({ type: "products", buckets, errorCount: rawErrors.length, errors });

            recordRunFinish(runId, {
                status: result?.success === false ? "error" : "ok",
                itemCount: countProductChanges(result),
                error: result?.success === false ? `${rawErrors.length} item error(s)` : null,
                details,
                startedAtMs
            });
        } catch (err) {
            recordRunFinish(runId, { status: "error", error: err.message || String(err), startedAtMs });
        } finally {
            PRODUCT_RUNNING = false;
        }
    })();
    return { started: true, runId };
}

/**
 * Starts a customer (partner) sync — one-way T4A → CREAGLOBE, like products. Background +
 * recorded. `opts.dryRun` computes the plan without writing to CREAGLOBE. Returns immediately.
 */
function runCustomerSync(trigger, opts = {}) {
    if (CUSTOMER_RUNNING) {
        console.warn(`${logTs()} ⏭  customer sync (${trigger}) skipped — already running.`);
        return { started: false, reason: "already_running" };
    }
    CUSTOMER_RUNNING = true;
    const dryRun = !!opts.dryRun;
    const startedAtMs = Date.now();
    const runId = recordRunStart("customers", trigger);
    console.log(`${logTs()} ▶️  customer sync started (${trigger}${dryRun ? ", DRY RUN" : ""}) — run #${runId}.`);
    (async () => {
        try {
            const result = await customersSync({ dryRun });
            const c = result?.counts || {};

            if (!dryRun) {
                const fileTimestamp = getTimestamp();
                await saveCustomerSyncFile(result, fileTimestamp, "T4A", "CREAGLOBE");
            }

            // Per-item errors (add_partner / update_partner failures), normalised for the UI.
            const rawErrors = Array.isArray(result?.errors) ? result.errors : [];
            const errors = rawErrors.slice(0, 50).map((e) => ({
                system: e.system || "CREAGLOBE",
                partner: e.partner || null,
                tax_id_number: e.tax_id_number || null,
                action: e.action || null,
                message: e.message || "Unknown error"
            }));

            // Per-customer "what updated where" breakdown. Capped so the details JSON stays a
            // sensible size; the full list is always in the saved JSON file.
            const rawChanges = Array.isArray(result?.changes) ? result.changes : [];
            const changes = rawChanges.slice(0, 200);

            const details = JSON.stringify({
                type: "customers",
                dryRun,
                counts: {
                    source: c.source ?? null,
                    target: c.target ?? null,
                    matched: c.matched ?? null,
                    created: c.created ?? null,
                    updated: c.updated ?? null,
                    skipped: c.skipped ?? null
                },
                buckets: Array.isArray(result?.buckets) ? result.buckets : [],
                changeCount: rawChanges.length,
                changes,
                errorCount: rawErrors.length,
                errors
            });

            recordRunFinish(runId, {
                status: rawErrors.length > 0 ? "error" : "ok",
                itemCount: (c.created ?? 0) + (c.updated ?? 0),
                error: rawErrors.length > 0 ? `${rawErrors.length} customer(s) failed to sync` : null,
                details,
                startedAtMs
            });
        } catch (err) {
            recordRunFinish(runId, { status: "error", error: err.message || String(err), startedAtMs });
        } finally {
            CUSTOMER_RUNNING = false;
        }
    })();
    return { started: true, runId };
}

/**
 * Starts a pricelist (price) sync — one-way T4A → CREAGLOBE. Background + recorded.
 * `opts.dryRun` resolves the plan without writing to CREAGLOBE. Returns immediately.
 *
 * Only the source→target list pairs saved in `pricelist_map` are synced: a price list's
 * count_code does not identify the same list across companies, so nothing is ever guessed.
 */
function runPricelistSync(trigger, opts = {}) {
    if (PRICELIST_RUNNING) {
        console.warn(`${logTs()} ⏭  pricelist sync (${trigger}) skipped — already running.`);
        return { started: false, reason: "already_running" };
    }
    PRICELIST_RUNNING = true;
    const dryRun = !!opts.dryRun;
    const startedAtMs = Date.now();
    const runId = recordRunStart("pricelists", trigger);
    console.log(`${logTs()} ▶️  pricelist sync started (${trigger}${dryRun ? ", DRY RUN" : ""}) — run #${runId}.`);
    (async () => {
        try {
            const mappings = readMappings();
            const result = await pricelistsSync({ dryRun, mappings });
            const c = result?.counts || {};

            if (!dryRun && !result?.noMappings) {
                const fileTimestamp = getTimestamp();
                await savePricelistSyncFile(result, fileTimestamp, "T4A", "CREAGLOBE");
            }

            const rawErrors = Array.isArray(result?.errors) ? result.errors : [];
            const errors = rawErrors.slice(0, 50).map((e) => ({
                system: e.system || "CREAGLOBE",
                scope: e.scope || "product",
                product_code: e.product_code || null,
                list: e.list || null,
                action: e.action || null,
                message: e.message || "Unknown error"
            }));

            // Per-product "what changed on which list". Capped so the details JSON stays a
            // sensible size; the full list is always in the saved JSON file.
            const rawChanges = Array.isArray(result?.changes) ? result.changes : [];
            const changes = rawChanges.slice(0, 200);

            const details = JSON.stringify({
                type: "pricelists",
                dryRun,
                noMappings: !!result?.noMappings,
                counts: {
                    mappings: c.mappings ?? null,
                    products: c.products ?? null,
                    added: c.added ?? null,
                    updated: c.updated ?? null,
                    unchanged: c.unchanged ?? null,
                    blocked: c.blocked ?? null,
                    extra: c.extra ?? null,
                    skippedMissingProduct: c.skippedMissingProduct ?? null
                },
                // One row per mapped list pair — the heart of the run-details view.
                perList: Array.isArray(result?.perList) ? result.perList : [],
                buckets: Array.isArray(result?.buckets) ? result.buckets : [],
                changeCount: rawChanges.length,
                changes,
                // Actionable, non-fatal notes: today, lists where no tax code could be
                // resolved so the rows were skipped rather than guessed at.
                warnings: Array.isArray(result?.warnings) ? result.warnings.slice(0, 20) : [],
                errorCount: rawErrors.length,
                errors
            });

            recordRunFinish(runId, {
                status: rawErrors.length > 0 ? "error" : "ok",
                itemCount: (c.added ?? 0) + (c.updated ?? 0),
                error: rawErrors.length > 0 ? `${rawErrors.length} price update(s) failed` : null,
                details,
                startedAtMs
            });
        } catch (err) {
            recordRunFinish(runId, { status: "error", error: err.message || String(err), startedAtMs });
        } finally {
            PRICELIST_RUNNING = false;
        }
    })();
    return { started: true, runId };
}

async function warehousesSync() {
    try {
        // Step 1: Get stock from T4A (paginated — the warehouse_stock endpoint returns
        // at most `limit` (default 1000) items per request, so we must loop over offsets.
        // Without this, SKUs beyond the first page are absent from the sync payload and
        // Metakocka would zero out their stock in CREAGLOBE.)
        const PAGE_SIZE = 1000;
        let sloWhStockArray = [];
        let offset = 0;

        while (true) {
            const warehouseStockResponse = await axios.post(
                `${config.metakocka.baseUrl}${config.metakocka.warehouseStockPath}`,
                {
                    "secret_key": process.env.MK_SECRET_KEY_T4A,
                    "company_id": process.env.MK_COMPANY_ID_T4A,
                    "wh_id_list": process.env.MK_T4A_WAREHOUSE_ID,
                    "limit": PAGE_SIZE,
                    "offset": offset
                },
                {
                    headers: {
                        "Content-Type": "application/json"
                    }
                }
            );

            if (!warehouseStockResponse.data || !warehouseStockResponse.data.stock_list) {
                // Fail heartbeat to BetterStack
                await warehousesSyncHeartBeat(false, warehouseStockResponse.data);
                throw new Error("Stock response missing or invalid");
            }

            const page = warehouseStockResponse.data.stock_list;
            sloWhStockArray.push(...page);

            // Last page reached when fewer than a full page is returned.
            if (page.length < PAGE_SIZE) break;
            offset += PAGE_SIZE;
        }
        console.log("Step 1")

        // Metakocka returns MULTIPLE rows per product within the same warehouse — one per
        // serial number (serialized products) or per microlocation. Each such row carries a
        // slice of the physical stock in `amount` (e.g. amount=1 per serial), while
        // `reserved_amount` and `free_amount` repeat the SAME product-level totals on every
        // row. So free stock CANNOT be read off (or summed from) `free_amount`; we must:
        //   1. sum `amount` across all rows for the product  -> true physical on-hand
        //   2. subtract the reservation ONCE (it's repeated, not per-row)
        //   3. free = physical - reserved
        // Example: 9 serial rows each {amount:1, reserved:5, free:-4} -> physical 9, reserved 5, free 4.
        // (Summing free_amount would wrongly give -36.) All rows share one warehouse here because
        // the request is filtered by wh_id_list, so the reservation is a single per-warehouse value.
        const t4aByCode = sloWhStockArray.reduce((acc, item) => {
            // `count_code` is always present; `code` is optional. Prefer `code` (the sync
            // match key) but fall back to `count_code` so items aren't silently dropped.
            const code = item.code || item.count_code;
            if (!code) return acc;

            if (!acc[code]) {
                acc[code] = {
                    product_code: code,
                    physical: 0,
                    reserved: 0,
                    warehouse_id: process.env.MK_CREAGLOBE_WAREHOUSE_ID_T4A
                };
            }
            // Amounts arrive as strings and may use a comma decimal separator (e.g. "857,75"),
            // so parse via parseNumber — raw Number("857,75") returns NaN.
            acc[code].physical += parseNumber(item.amount);
            // reserved_amount is the product-level reservation repeated on each row, so take it
            // once (max guards against rows that omit it or report 0).
            acc[code].reserved = Math.max(acc[code].reserved, parseNumber(item.reserved_amount));
            return acc;
        }, {});

        let syncSloStockPreparedArray = Object.values(t4aByCode).map(p => ({
            product_code: p.product_code,
            // Free (available-to-sell) stock. Negative values are kept intentionally — we
            // support negative stock and must sync it through.
            amount: p.physical - p.reserved,
            warehouse_id: p.warehouse_id
        }));

        // ── Step 2: Germany / ProMode stock — RETIRED, NO LONGER USED ──────────────────
        // The Germany warehouse feed was fetched from ProMode's exported CSV
        // (config.promode.warehouseStockCSV) and written into the CREAGLOBE "Germany" virtual
        // warehouse. T4A stopped using the ProMode warehouse in July 2026, so this source is
        // DISABLED and warehouse sync is now T4A-only.
        //
        // The implementation is intentionally KEPT (not deleted) so it can be revived quickly
        // if the ProMode relationship ever resumes. To turn it back on:
        //   1. un-comment the block below,
        //   2. spread `...syncGerStockPreparedArray` back into `combinedStockArray` (Step 3),
        //   3. restore the Germany entry in the `breakdown` return + runWarehouseSync() details,
        //   4. un-comment the Germany saveSyncFile() call in Step 7.
        // While disabled no Germany stock is sent, so the CREAGLOBE Germany virtual warehouse
        // is simply left out of the sync. See docs/deprecated_promode_warehouse_sync.md.
        /*
        // Step 2: Get stock from Germany Main (ProMode)
        const germanyWarehouseResponse = await axios.get(config.promode.warehouseStockCSV, { responseType: 'text' })

        const germanyWhStockArray = [];
        const stream = Readable.from(germanyWarehouseResponse.data);
        for await (const row of stream.pipe(csv({ separator: ";" }))) {
            germanyWhStockArray.push(row);
        }

        let syncGerStockPreparedArray = germanyWhStockArray.map(item => ({
            product_code: item.barcode,
            // CSV quantities may use a comma decimal separator (e.g. "1,5"); normalise to a
            // number so sumByProductCode doesn't turn a code's total into NaN.
            amount: parseNumber(item.quantity),
            warehouse_id: process.env.MK_CREAGLOBE_WAREHOUSE_ID_GERMANY_ONE
        }));

        syncGerStockPreparedArray = sumByProductCode(syncGerStockPreparedArray);

        console.log("Step 2")
        */

        // Step 3: Warehouse stock to sync. ProMode/Germany is retired (see Step 2), so the
        // payload is now just the T4A warehouse. Re-enabling ProMode = spread
        // `...syncGerStockPreparedArray` back in here.
        const combinedStockArray = [
            ...syncSloStockPreparedArray
        ]
        console.log("Step 3")

        // Step 4: Sync stock to CREAGLOBE warehouse
        const stockSyncResponse = await axios.post(
            `${config.metakocka.baseUrl}${config.metakocka.syncStockPath}`,
            {
                "secret_key": process.env.MK_SECRET_KEY_CREAGLOBE,
                "company_id": process.env.MK_COMPANY_ID_CREAGLOBE,
                "stock_list": combinedStockArray
            },
            {
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );
        console.log("Step 4")

        // Success is signalled by opr_code "0" (opr_desc is a human-readable message that
        // may change/localize, so don't match on its exact text).
        if (stockSyncResponse.data.opr_code !== "0") {
            // Fail heartbeat to BetterStack
            await warehousesSyncHeartBeat(false, stockSyncResponse.data);
            throw new Error("Error warehouse sync!");
        }

        // Even with opr_code "0", sync_stock reports PER-PRODUCT failures in `error_list`
        // (e.g. "Product not found", "Warehouse not found") — see docs/warehouse_stock_sync.md §2.2.
        // These are the usual reason stock "doesn't match": the item exists in T4A but the
        // sync silently skips it in CREAGLOBE. Surface them so a run isn't reported clean.
        const syncErrorList = Array.isArray(stockSyncResponse.data.error_list)
            ? stockSyncResponse.data.error_list
            : [];
        if (syncErrorList.length > 0) {
            console.error(`Warehouse sync: ${syncErrorList.length} product(s) failed to sync:`, syncErrorList);
        }

        // Step 5: Successful heartbeat for BetterStack (the sync call itself succeeded;
        // per-item errors are recorded in the run history, not treated as a total failure).
        warehousesSyncHeartBeat();
        console.log("Step 5")

        var fileTimestamp = getTimestamp();

        // Step 7: Save JSON file
        (async () => {
            try {
                // Save SLO stock
                await saveSyncFile(syncSloStockPreparedArray, fileTimestamp, "T4A");

                // Save GER stock — RETIRED with the ProMode source (see Step 2). Re-enable
                // alongside the Germany fetch above.
                // await saveSyncFile(syncGerStockPreparedArray, fileTimestamp, "Germany");
            } catch (err) {
                console.log("Error saving JSON file: ", err)
            }
        })();

        // LEGACY: Google drive is really slow. We will not use it unless we need to
        // Upload to google drive
        // Step 5 & 6: Fire-and-forget Google Drive operations
        // so that warehouse sync endpoint is faster &
        // GDrive is synced in background
        // (async () => {
        //     try {
        //         const storeStockLogFileResponse = await axios.post(
        //             config.googleDrive.macros.saveLogFile,
        //             {
        //                 api_key: process.env.API_KEY,
        //                 items: syncStockPreparedArray
        //             }
        //         );

        //         if (storeStockLogFileResponse.data.success) {
        //             await axios.post(
        //                 config.googleDrive.macros.updateSyncList,
        //                 {
        //                     api_key: process.env.API_KEY,
        //                     stock_link: storeStockLogFileResponse.data.stock_log_link
        //                 }
        //             );
        //         } else {
        //             console.error("Drive log save failed");
        //         }
        //     } catch (err) {
        //         console.error("Background Google Drive sync failed:", err.message || err);
        //     }
        // })(); // immediately invoked async function
        return {
            response: stockSyncResponse.data,
            data: combinedStockArray,
            // Per-product sync failures reported by Metakocka (empty on a fully clean run).
            errors: syncErrorList,
            // Counts per source warehouse — each is written into its own CREAGLOBE virtual warehouse.
            // `germany` is null: the ProMode/Germany source is retired (see Step 2).
            breakdown: {
                t4a: syncSloStockPreparedArray.length,
                germany: null,
                total: combinedStockArray.length,
                errorCount: syncErrorList.length
            }
        };

    } catch (err) {
        console.error("Warehouse Sync failed:", err.message || err);
        throw err;
    }
}

// Schedules a sync job, or returns null if node-cron rejects the expression. cron.json lives on
// the server and is edited outside this repo; node-cron ≥4.6 throws on expressions it used to
// accept (e.g. "0 0 31 2 *", a common "never run" trick), and a throw here at boot would crash
// the whole server instead of just leaving that one job unscheduled.
function scheduleCron(name, cronExpression, fn) {
    try {
        return cron.schedule(cronExpression, fn);
    } catch (err) {
        console.error(`${logTs()} ⛔ ${name} sync NOT scheduled — invalid cron "${cronExpression}": ${err.message}`);
        return null;
    }
}

function startOrUpdateWarehousesCron(cronExpression) {
    // Stop existing job if running
    if (WAREHOUSE_SYNC_CRON_JOB) {
        WAREHOUSE_SYNC_CRON_JOB.stop();
        console.log("Stopped existing warehouse sync cron job");
    }

    // Start new cron job (records the run + outcome via the wrapper).
    WAREHOUSE_SYNC_CRON_JOB = scheduleCron("warehouse", cronExpression, () => {
        runWarehouseSync("schedule");
    });

    if (WAREHOUSE_SYNC_CRON_JOB) console.log("Warehouse sync cron job scheduled:", cronExpression);
}

function startOrUpdateProductsCron(cronExpression) {
    // Stop existing job if running
    if (PRODUCT_SYNC_CRON_JOB) {
        PRODUCT_SYNC_CRON_JOB.stop();
        console.log("Stopped existing product sync cron job");
    }

    // Start new cron job (records the run + outcome via the wrapper).
    PRODUCT_SYNC_CRON_JOB = scheduleCron("product", cronExpression, () => {
        runProductSync("schedule");
    });

    if (PRODUCT_SYNC_CRON_JOB) console.log("Product sync cron job scheduled:", cronExpression);
}

function startOrUpdateCustomersCron(cronExpression) {
    // Stop existing job if running
    if (CUSTOMER_SYNC_CRON_JOB) {
        CUSTOMER_SYNC_CRON_JOB.stop();
        console.log("Stopped existing customer sync cron job");
    }

    // Scheduled runs always write (dryRun defaults to false).
    CUSTOMER_SYNC_CRON_JOB = scheduleCron("customer", cronExpression, () => {
        runCustomerSync("schedule");
    });

    if (CUSTOMER_SYNC_CRON_JOB) console.log("Customer sync cron job scheduled:", cronExpression);
}

function startOrUpdatePricelistsCron(cronExpression) {
    // Stop existing job if running
    if (PRICELIST_SYNC_CRON_JOB) {
        PRICELIST_SYNC_CRON_JOB.stop();
        console.log("Stopped existing pricelist sync cron job");
    }

    // Scheduled runs always write (dryRun defaults to false). With no mappings saved the
    // run is a recorded no-op, so leaving the schedule armed on a fresh install is safe.
    PRICELIST_SYNC_CRON_JOB = scheduleCron("pricelist", cronExpression, () => {
        runPricelistSync("schedule");
    });

    if (PRICELIST_SYNC_CRON_JOB) console.log("Pricelist sync cron job scheduled:", cronExpression);
}


async function warehousesSyncHeartBeat(success = true, errorMessage = {}) {
    try {
        const url = success
            ? process.env.BETTER_STACK_WH_SYNC_HEARTBEAT
            : `${process.env.BETTER_STACK_WH_SYNC_HEARTBEAT}/fail`;

        const heartBeatResponse = await axios.post(url, errorMessage);

        return heartBeatResponse.data;
    } catch (err) {
        console.log("Betterstack heartbeat problem:", err.message || err);
    }
}

// Utility function to save JSON and log to DB
async function saveSyncFile(dataArray, fileTimestamp, syncName) {
    try {
        // Use current directory if PUBLIC_DATA_FILE_PATH is empty
        const folderPath = process.env.PUBLIC_DATA_FILE_PATH || "./tmp";

        // Ensure the folder exists
        await fs.mkdir(folderPath, { recursive: true });

        // Build file path
        const filePath = path.join(folderPath, `${fileTimestamp}_${syncName}.json`);

        // Write JSON file
        await fs.writeFile(filePath, JSON.stringify(dataArray, null, 2));

        // Insert into DB
        db.prepare(`
            INSERT INTO warehouse_sync_log (link, sync_name) 
            VALUES (?, ?)
        `).run(`${fileTimestamp}_${syncName}.json`, syncName);

        console.log(`✅ Saved ${syncName} sync file: ${filePath}`);
    } catch (err) {
        console.error(`❌ Error saving JSON for ${syncName}:`, err);
    }
}
async function saveProductSyncFile(dataArray, fileTimestamp, sourceWarehouse, targetWarehouse, status) {
    try {
        const folderPath = process.env.PUBLIC_DATA_FILE_PATH || "./tmp";
        await fs.mkdir(folderPath, { recursive: true });

        const filePath = path.join(
            folderPath,
            `${fileTimestamp}_products_${sourceWarehouse}_to_${targetWarehouse}.json`
        );

        await fs.writeFile(filePath, JSON.stringify(dataArray, null, 2));

        // Insert a single log row for the whole sync
        db.prepare(`
            INSERT INTO product_sync_log 
            (sync_name, status, source_warehouse, target_warehouse) 
            VALUES (?, ?, ?, ?)
        `).run(
            `${fileTimestamp}_products_${sourceWarehouse}_to_${targetWarehouse}.json`,
            status,
            sourceWarehouse,
            targetWarehouse
        );

        console.log(`✅ Saved product sync file: ${filePath}`);
    } catch (err) {
        console.error(`❌ Error saving product sync for ${sourceWarehouse}:`, err);
    }
}


async function saveCustomerSyncFile(result, fileTimestamp, sourceCompany, targetCompany) {
    try {
        const folderPath = process.env.PUBLIC_DATA_FILE_PATH || "./tmp";
        await fs.mkdir(folderPath, { recursive: true });

        const fileName = `${fileTimestamp}_customers_${sourceCompany}_to_${targetCompany}.json`;
        const filePath = path.join(folderPath, fileName);

        await fs.writeFile(filePath, JSON.stringify(result, null, 2));

        const c = result?.counts || {};
        db.prepare(`
            INSERT INTO customer_sync_log
            (sync_name, source_company, target_company, created, updated)
            VALUES (?, ?, ?, ?, ?)
        `).run(fileName, sourceCompany, targetCompany, c.created ?? 0, c.updated ?? 0);

        console.log(`✅ Saved customer sync file: ${filePath}`);
    } catch (err) {
        console.error(`❌ Error saving customer sync for ${sourceCompany}:`, err);
    }
}

async function savePricelistSyncFile(result, fileTimestamp, sourceCompany, targetCompany) {
    try {
        const folderPath = process.env.PUBLIC_DATA_FILE_PATH || "./tmp";
        await fs.mkdir(folderPath, { recursive: true });

        const fileName = `${fileTimestamp}_pricelists_${sourceCompany}_to_${targetCompany}.json`;
        const filePath = path.join(folderPath, fileName);

        // The full, uncapped record: every change and every error. The run's `details`
        // column caps both so the DB row stays small; this file is the complete audit.
        await fs.writeFile(filePath, JSON.stringify(result, null, 2));

        const c = result?.counts || {};
        db.prepare(`
            INSERT INTO pricelist_sync_log
            (sync_name, source_company, target_company, added, updated)
            VALUES (?, ?, ?, ?, ?)
        `).run(fileName, sourceCompany, targetCompany, c.added ?? 0, c.updated ?? 0);

        console.log(`✅ Saved pricelist sync file: ${filePath}`);
    } catch (err) {
        console.error(`❌ Error saving pricelist sync for ${sourceCompany}:`, err);
    }
}

function sumByProductCode(data) {
    return Object.values(
        data.reduce((acc, item) => {
            const code = item.product_code;
            if (!code) return acc; // skip if no code

            if (!acc[code]) {
                acc[code] = { ...item, amount: parseNumber(item.amount) };
            } else {
                acc[code].amount += parseNumber(item.amount);
            }
            return acc;
        }, {})
    );
}
