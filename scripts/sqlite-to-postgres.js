// Copies an old SQLite file (patrik.db) into Postgres (DATABASE_URL) by hand. The app does
// the same by itself at boot (src/sqliteImport.js), so production doesn't need this; it is
// for checking a copy elsewhere first.
//
//   node scripts/sqlite-to-postgres.js <path to patrik.db>
//
// Exits 1 without copying when Postgres already has rows.
require("../src/config/env");
require("../cron"); // loads ENV_FILE_PATH (/data/.env in the image), like index.js

const { sql, migrate } = require("../src/db");
const { importSqlite } = require("../src/sqliteImport");

async function main() {
    const file = process.argv[2];
    if (!file) throw new Error("usage: node scripts/sqlite-to-postgres.js <path to patrik.db>");
    await migrate();
    const r = await importSqlite(file);
    if (!r.copied) throw new Error(`not copied: ${r.reason}`);
    console.table(r.counts);
    console.log("✅ copy done");
}

main()
    .catch((err) => {
        console.error("⛔", err.message || err);
        process.exitCode = 1;
    })
    .finally(() => sql.end());
