# Browser runs (Playwright, headless Chromium, unpacked extension)

Offline: the e2e build swaps the chain for a mock and blocks all DNS. Throwaway wallets only; nothing is broadcast.

    npm run build:e2e && npm run build
    node e2e/run.mjs         # flows + screenshot matrix + axe + overflow -> /workspace/wallet/v2/screens
    node e2e/contact.mjs     # contact sheets
    node e2e/targets.mjs     # targets under 24 px
    node e2e/prod-smoke.mjs  # release dist loads, no test hook

Needs `playwright` and `@axe-core/playwright` (installed outside the repo at /workspace/wallet/v2/e2e).
