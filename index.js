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
const config = require("./config/config.json");
const { error } = require("console");
const { productsSync, PRODUCTS_SYNC_PARAMS } = require("./src/services/productSyncService");

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

// Unified run history for the admin "Automation" page: one row per warehouse/product
// sync (scheduled or manual) with its outcome, duration and item count. node-cron exposes
// no last-run/next-run info, so we track it ourselves here.
db.prepare(`
  CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT,                   -- 'warehouse' | 'products'
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
// Back-fill the details column on databases created before it existed.
try { db.prepare(`ALTER TABLE sync_runs ADD COLUMN details TEXT`).run(); } catch (e) { /* column already exists */ }

// Holds the warehouse sync cron job instance for later control
var WAREHOUSE_SYNC_CRON_JOB;
var PRODUCT_SYNC_CRON_JOB;

// Load initial cron expression (e.g., "*/5 * * * *" → every 5 minutes)
const initialCronExpression = loadCronExpression();

// Start or update the warehouse sync job with the loaded schedule
startOrUpdateWarehousesCron(initialCronExpression);

// API key from environment for route authentication
const API_KEY = process.env.API_KEY;

// Middleware to verify API key
function authenticate(req, res, next) {
    const apiKey = req.header("x-api-key");
    if (!apiKey || apiKey !== API_KEY) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

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
        if (!isValidCron(warehouseSync, { seconds: false })) {
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
        if (!isValidCron(productSync, { seconds: false })) return res.status(400).json({ error: "Invalid cron expression" });

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

// Unified status for the admin "Automation" page: both schedules, their next fire time,
// whether a sync is currently running, and the last recorded run for each.
app.get("/api/v1/status", authenticate, (req, res) => {
    try {
        const cfg = readCronConfig();
        const warehouseCron = cfg.warehouseSync || loadCronExpression("warehouseSync");
        const productCron = cfg.productSync || "0 * * * *";
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
    db.prepare(
        `UPDATE sync_runs SET status = ?, item_count = ?, error = ?, details = ?, finished_at = CURRENT_TIMESTAMP, duration_ms = ? WHERE id = ?`
    ).run(status, itemCount, error, details, startedAtMs ? Date.now() - startedAtMs : null, id);
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
    if (WAREHOUSE_RUNNING) return { started: false, reason: "already_running" };
    WAREHOUSE_RUNNING = true;
    const startedAtMs = Date.now();
    const runId = recordRunStart("warehouse", trigger);
    (async () => {
        try {
            const result = await warehousesSync();
            const b = result?.breakdown || {};
            // Each source warehouse is written into its OWN matching virtual warehouse in the
            // CREAGLOBE company — the stock is kept separate per warehouse, never merged.
            const details = JSON.stringify({
                type: "warehouse",
                warehouses: [
                    { source: "T4A", target: "CREAGLOBE / T4A warehouse", count: b.t4a ?? null },
                    { source: "ProMode (Germany)", target: "CREAGLOBE / Germany warehouse", count: b.germany ?? null }
                ]
            });
            recordRunFinish(runId, { status: "ok", itemCount: b.total ?? result?.data?.length ?? null, details, startedAtMs });
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
    if (PRODUCT_RUNNING) return { started: false, reason: "already_running" };
    PRODUCT_RUNNING = true;
    const startedAtMs = Date.now();
    const runId = recordRunStart("products", trigger);
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

        let syncSloStockPreparedArray = sloWhStockArray.map(item => ({
            // `count_code` is always present; `code` is optional. Prefer `code` (the sync
            // match key) but fall back to `count_code` so items aren't silently dropped.
            product_code: item.code || item.count_code,
            // Free (available-to-sell) stock: Metakocka returns `free_amount` (= amount - reserved)
            // only when reservations are in use; otherwise fall back to amount - reserved_amount
            // (reserved defaults to 0, reducing to `amount`). Avoids syncing reserved units as available.
            // Negative values are kept intentionally — we support negative stock and must sync it through.
            amount: item.free_amount != null && item.free_amount !== ''
                ? Number(item.free_amount)
                : Number(item.amount || 0) - Number(item.reserved_amount || 0),
            warehouse_id: process.env.MK_CREAGLOBE_WAREHOUSE_ID_T4A
        }));

        syncSloStockPreparedArray = sumByProductCode(syncSloStockPreparedArray);

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

        // Step 3: Join Germany Man & Slo Warehouse
        const combinedStockArray = [
            ...syncSloStockPreparedArray,
            ...syncGerStockPreparedArray
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

        // Step 5: Successful heartbeat for BetterStack
        warehousesSyncHeartBeat();
        console.log("Step 5")

        var fileTimestamp = getTimestamp();

        // Step 7: Save JSON file
        (async () => {
            try {
                // Save SLO stock
                await saveSyncFile(syncSloStockPreparedArray, fileTimestamp, "T4A");

                // Save GER stock
                await saveSyncFile(syncGerStockPreparedArray, fileTimestamp, "Germany");
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
            // Counts per source warehouse — each is written into its own CREAGLOBE virtual warehouse.
            breakdown: {
                t4a: syncSloStockPreparedArray.length,
                germany: syncGerStockPreparedArray.length,
                total: combinedStockArray.length
            }
        };

    } catch (err) {
        console.error("Warehouse Sync failed:", err.message || err);
        throw err;
    }
}

function startOrUpdateWarehousesCron(cronExpression) {
    // Stop existing job if running
    if (WAREHOUSE_SYNC_CRON_JOB) {
        WAREHOUSE_SYNC_CRON_JOB.stop();
        console.log("Stopped existing warehouse sync cron job");
    }

    // Start new cron job (records the run + outcome via the wrapper).
    WAREHOUSE_SYNC_CRON_JOB = cron.schedule(cronExpression, () => {
        runWarehouseSync("schedule");
    });

    console.log("Warehouse sync cron job scheduled:", cronExpression);
}

function startOrUpdateProductsCron(cronExpression) {
    // Stop existing job if running
    if (PRODUCT_SYNC_CRON_JOB) {
        PRODUCT_SYNC_CRON_JOB.stop();
        console.log("Stopped existing product sync cron job");
    }

    // Start new cron job (records the run + outcome via the wrapper).
    PRODUCT_SYNC_CRON_JOB = cron.schedule(cronExpression, () => {
        runProductSync("schedule");
    });

    console.log("Product sync cron job scheduled:", cronExpression);
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


function sumByProductCode(data) {
    return Object.values(
        data.reduce((acc, item) => {
            const code = item.product_code;
            if (!code) return acc; // skip if no code

            if (!acc[code]) {
                acc[code] = { ...item, amount: Number(item.amount) };
            } else {
                acc[code].amount += Number(item.amount);
            }
            return acc;
        }, {})
    );
}
