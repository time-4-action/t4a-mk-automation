// Pins the running build's version to the bottom-right corner of every page.
// The version is the commit SHA CI bakes into the image (APP_VERSION), read from /healthz;
// local runs report "dev". Included by each page with <script src="/version.js" defer>.
(function () {
    const REPO = "https://github.com/time-4-action/t4a-mk-automation";

    const badge = document.createElement("a");
    badge.id = "app-version";
    badge.textContent = "…";
    badge.target = "_blank";
    badge.rel = "noopener";
    Object.assign(badge.style, {
        position: "fixed",
        right: "0.75rem",
        bottom: "0.75rem",
        zIndex: "9999",
        padding: "0.25rem 0.6rem",
        borderRadius: "999px",
        background: "rgba(27, 27, 31, 0.9)",
        border: "1px solid #333",
        color: "#888",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: "0.75rem",
        textDecoration: "none",
        pointerEvents: "auto",
    });
    document.body.appendChild(badge);

    fetch("/healthz", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then(({ version }) => {
            const isSha = /^[0-9a-f]{40}$/.test(version || "");
            badge.textContent = isSha ? version.slice(0, 7) : version || "unknown";
            badge.title = isSha ? "Commit " + version : "Not a CI build";
            if (isSha) badge.href = REPO + "/commit/" + version;
        })
        .catch(() => {
            badge.textContent = "?";
            badge.title = "Version unavailable";
        });
})();
