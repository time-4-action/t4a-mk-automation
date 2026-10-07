// Safety lock: nothing outside production may touch production.
//
// Only the production server sets APP_ENV=production (NODE_ENV can't be used — the Docker image
// sets it everywhere). Anywhere else — the dev server, a laptop — this module:
//   1. at startup refuses to start if a setting points at a production target, and says which;
//   2. before every outbound axios call refuses production hosts again, as a backup.
//
// It also applies MK_BASE_URL over config.metakocka.baseUrl, so dev can point at devmainsi.
// Must be required after the .env file is loaded (cron.js loads it) and before any sync runs.
const axios = require("axios");
const config = require("../../config/config.json");

const IS_PRODUCTION = process.env.APP_ENV === "production";

// Hosts only production may call. Subdomain matches count (e.g. uptime.betterstack.com).
const PRODUCTION_HOSTS = ["main.metakocka.si", "betterstack.com"];

function isProductionHost(url) {
    let host;
    try {
        host = new URL(url).hostname;
    } catch {
        return false;
    }
    return PRODUCTION_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

if (process.env.MK_BASE_URL) {
    config.metakocka.baseUrl = process.env.MK_BASE_URL;
}

if (!IS_PRODUCTION) {
    const problems = [];
    if (isProductionHost(config.metakocka.baseUrl)) {
        problems.push(`Metakocka base URL is ${config.metakocka.baseUrl} — set MK_BASE_URL to devmainsi`);
    }
    if (process.env.BETTER_STACK_WH_SYNC_HEARTBEAT) {
        problems.push("BETTER_STACK_WH_SYNC_HEARTBEAT is set — leave it empty outside production");
    }
    if (problems.length) {
        console.error("⛔ Refusing to start: APP_ENV is not 'production' but settings point at production:");
        for (const p of problems) console.error(`   - ${p}`);
        console.error("   On the production server only, add APP_ENV=production to the .env file.");
        process.exit(1);
    }

    axios.interceptors.request.use((req) => {
        const url = new URL(req.url, req.baseURL).toString();
        if (isProductionHost(url)) {
            throw new Error(`Blocked call to production host outside production: ${url}`);
        }
        return req;
    });
}

console.log(`Environment: ${IS_PRODUCTION ? "production" : "non-production"} — Metakocka at ${config.metakocka.baseUrl}`);

module.exports = { IS_PRODUCTION };
