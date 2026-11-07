// One-time copy of the old SQLite file (patrik.db) into Postgres. Remove this file, the
// better-sqlite3 dependency and scripts/sqlite-to-postgres.js once production has moved.
//
// Runs at boot (index.js) when DB_FILE_PATH points at an existing file, and by hand through
// scripts/sqlite-to-postgres.js. Guard: it only copies when every table is empty in Postgres,
// so it can never copy twice or overwrite newer rows. One transaction: all or nothing. Ids
// are kept, and the id sequences are moved past them.
const fs = require("fs");
const { sql } = require("./db");

const TABLES = [
    "warehouse_sync_log",
    "product_sync_log",
    "customer_sync_log",
    "pricelist_sync_log",
    "pricelist_map",
    "sync_runs"
];

/**
 * Copies `file` into Postgres. Returns `{ copied: true, counts }`, or
 * `{ copied: false, reason }` when there is no file or Postgres already has rows.
 * Throws (and rolls back) on any other problem, including a count mismatch.
 */
async function importSqlite(file) {
    if (!file || !fs.existsSync(file)) return { copied: false, reason: `no SQLite file at ${file}` };

    // Loaded only when there is something to copy.
    const Database = require("better-sqlite3");
    const lite = new Database(file, { readonly: true, fileMustExist: true });
    try {
        return await sql.begin(async (tx) => {
            // Same lock as migrate(): one copier at a time.
            await tx`SELECT pg_advisory_xact_lock(hashtext('t4a-mk-automation:migrate'))`;
            for (const t of TABLES) {
                const [{ n }] = await tx`SELECT COUNT(*)::int AS n FROM ${tx(t)}`;
                if (n > 0) return { copied: false, reason: `${t} already has ${n} row(s) in Postgres` };
            }

            const counts = [];
            for (const t of TABLES) {
                const exists = lite.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t);
                const rows = exists ? lite.prepare(`SELECT * FROM "${t}" ORDER BY id`).all() : [];

                // Only the columns both sides have (old files can lack ones added later).
                const pgCols = (await tx`
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = ${t}`).map((r) => r.column_name);
                const cols = rows.length ? Object.keys(rows[0]).filter((c) => pgCols.includes(c)) : [];

                for (let i = 0; i < rows.length; i += 500) {
                    const chunk = rows.slice(i, i + 500).map((r) => {
                        const o = {};
                        for (const c of cols) o[c] = r[c] === undefined ? null : r[c];
                        return o;
                    });
                    await tx`INSERT INTO ${tx(t)} ${tx(chunk, cols)}`;
                }
                if (rows.length) {
                    await tx`SELECT setval(pg_get_serial_sequence(${t}, 'id'), (SELECT MAX(id) FROM ${tx(t)}))`;
                }

                const [{ n }] = await tx`SELECT COUNT(*)::int AS n FROM ${tx(t)}`;
                if (n !== rows.length) throw new Error(`${t}: copied ${n} of ${rows.length} rows, rolled back`);
                counts.push({ table: t, sqlite: rows.length, postgres: n });
            }
            return { copied: true, counts };
        });
    } finally {
        lite.close();
    }
}

module.exports = { importSqlite };
