// ESLint flat config. `npm run lint` runs it locally and CI's `check` job runs it on every PR.
// Rules are eslint:recommended — bug catchers (undefined names, unused code, unreachable code),
// not style. Inline <script> blocks in public/*.html are not linted.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    { ignores: ["node_modules/", "db/", "delta/", "tmp/"] },

    js.configs.recommended,

    {
        rules: {
            // `_`-prefixed names are deliberately unused (e.g. a required-but-ignored argument);
            // `catch (err)` without using err is fine.
            "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true }],
        },
    },

    // Server code: Node, CommonJS.
    {
        files: ["**/*.js"],
        ignores: ["public/**"],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: "commonjs",
            globals: globals.node,
        },
    },

    // Static dashboard scripts served to the browser.
    {
        files: ["public/**/*.js"],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: "script",
            globals: globals.browser,
        },
    },
];
