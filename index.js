require("./src/config/env");

// Node.js built-in modules
const fs = require("fs").promises;
const path = require("path");

// Third-party modules
const axios = require("axios");
const cron = require("node-cron");
const express = require("express");
const { isValidCron } = require("cron-validator");
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

// POST endpoint to trigger warehouse data sync
app.post("/api/v1/warehouse/sync", authenticate, async (req, res) => {
    try {
        // Perform the warehouse sync
        const result = await warehousesSync();

        // Return sync result as JSON
        res.json(result);
    } catch (err) {
        // Handle errors and respond with status 500
        res.status(500).json({ error: err.message || "Internal Server Error!" });
    }
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


app.post("/api/v1/products/sync", authenticate, async (req, res) => {
    try {
        const syncResult = await productsSync(...PRODUCTS_SYNC_PARAMS);

        // Save the result to a file and log it in the database
        const fileTimestamp = getTimestamp();
        const sourceWarehouse = "T4A"; // System A
        const targetWarehouse = "CREAGLOBE"; // System B
        await saveProductSyncFile(syncResult, fileTimestamp, sourceWarehouse, targetWarehouse);

        res.json(syncResult);
    } catch (err) {
        res.status(500).json({ error: err.message || "Internal Server Error!" });
    }
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






app.use("/data", express.static(process.env.PUBLIC_DATA_FILE_PATH || "tmp"));
app.use(express.static("public"));

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});


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

async function warehousesSync() {
    try {
        // Step 1: Get stock from T4A
        const warehouseStockResponse = await axios.post(
            `${config.metakocka.baseUrl}${config.metakocka.warehouseStockPath}`,
            {
                "secret_key": process.env.MK_SECRET_KEY_T4A,
                "company_id": process.env.MK_COMPANY_ID_T4A,
                "wh_id_list": process.env.MK_T4A_WAREHOUSE_ID
            },
            {
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );
        console.log("Step 1")

        if (!warehouseStockResponse.data || !warehouseStockResponse.data.stock_list) {
            // Fail heartbeat to BetterStack
            warehousesSyncHeartBeat(false, warehouseStockResponse.data);
            throw new Error("Stock response missing or invalid");
        }

        let sloWhStockArray = warehouseStockResponse.data.stock_list;
        let syncSloStockPreparedArray = sloWhStockArray.map(item => ({
            product_code: item.code,
            // Free (available-to-sell) stock: Metakocka returns `free_amount` (= amount - reserved)
            // only when reservations are in use; otherwise fall back to amount - reserved_amount
            // (reserved defaults to 0, reducing to `amount`). Avoids syncing reserved units as available.
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
            amount: item.quantity,
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

        if (stockSyncResponse.data.opr_desc != "Sync successful") {
            // Fail heartbeat to BetterStack
            warehousesSyncHeartBeat(false, stockSyncResponse.data);
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
        return { response: stockSyncResponse.data, data: combinedStockArray };

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

    // Start new cron job
    WAREHOUSE_SYNC_CRON_JOB = cron.schedule(cronExpression, async () => {
        try {
            await warehousesSync();
        } catch (err) {
            console.error("Scheduled sync failed:", err.message || err);
        }
    });

    console.log("Warehouse sync cron job scheduled:", cronExpression);
}

function startOrUpdateProductsCron(cronExpression) {
    // Stop existing job if running
    if (PRODUCT_SYNC_CRON_JOB) {
        PRODUCT_SYNC_CRON_JOB.stop();
        console.log("Stopped existing product sync cron job");
    }

    // Start new cron job
    PRODUCT_SYNC_CRON_JOB = cron.schedule(cronExpression, async () => {
        try {
            const syncResult = await productsSync(...PRODUCTS_SYNC_PARAMS);

            // Save the result to a file and log it in the database
            const fileTimestamp = getTimestamp();
            const sourceWarehouse = "T4A"; // System A
            const targetWarehouse = "CREAGLOBE"; // System B
            await saveProductSyncFile(syncResult, fileTimestamp, sourceWarehouse, targetWarehouse);

        } catch (err) {
            console.error("Scheduled product sync failed:", err.message || err);
        }
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
