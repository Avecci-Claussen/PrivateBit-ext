# Audit findings and the tests that cover them

Unit tests run with `npm test` (network blocked). The browser run is
`e2e/run.mjs` against `npm run build:e2e` (offline mock chain).

| Finding | Covered by |
| --- | --- |
| C1 remove wipes every wallet | audit-emergency "removing one of two wallets keeps the other", "removing the last wallet reports a full wipe"; audit-wallets (remove by id, wrong password, open of three); browser run "no keys of the removed wallet remain", "the survivor's keys remain" (goes through the real background handler) |
| C2 lock keeps the words | audit-emergency "lock leaves no recovery words...", "an older build's grant ... is deleted"; browser run "after lock" checks on chrome.storage.session |
| C3 token in the build | check-dist (token, test hook, env file, source maps refused; values never printed); `npm run build` runs the gate |
| H1 writes overwrite each other | coinstore "rejects a write prepared from an older rev", "a send during a scan step is never overwritten", "a wallet rejects saveScan from a stale read" |
| H2 old key seals new wallet data | scanner "switching wallets cancels the scan ... nothing lands in the new wallet"; wallets "does not keep another wallet's coins or activity" |
| H3 repeated seed derivation | coinstore "derives the seed once per unlock", "coalesces scan steps into one write" |
| H4 retry storm | scanner "backs off exponentially with jitter", "cools down a host after a rate-limit answer" |
| H5 side work blocks scan, watch list grows | Payjoin on its own timer (background); scanner run tests; watch pruning in sideWork (not unit tested on its own, see report) |
| H6 payments missed silently | scanner "refuses a block whose inputs cannot all be resolved, and caches nothing", "does not skip a block when its transaction list cannot be fetched" |
| H7 proposal never ends | payjoin-state "a proposal that is never broadcast ends at its deadline", "offers Cancel in every open state"; browser run "proposal deadline ends the session" |
| H8 receiver does not check original | payjoin-state "refuses an original that does not pay the link, spends our coin, or is short"; browser run "receiver checked the original and proposed" |
| H9 session secrets written on switch | payjoin-state "switching wallets ends open Payjoins and leaves no session secrets behind" |
| H10 old password survives | audit-emergency "a password change retires the old password", "restoring the previous wallet needs its password", "a birthday edit does not create a previous wallet banner" |
| H11 addresses sent to the indexer | sot "rejects address-UTXO methods on a scan source", "prevouts come from parent transaction outputs" |
| H12 hung request | scanner "times out a call that never answers", "locking cancels the scan in progress" |
| M1 unbounded cache | blockshare tests; script cache LRU bound (SCRIPT_CACHE_MAX) |
| M2 no reorg handling | scanner "rolls back and rescans after a reorg" |
| M3 destructive switch cleanup | migration (all four); wallets "keeps each wallet's coins, birthday and passphrase when you switch" |
| M4 switch during Payjoin | payjoin-state switch test; browser run "switch asks first while a payment link is open", "staying keeps the link open" |
| M6 fixed 200 sat share | payjoin-state "pays a fee share that follows the original fee rate" |
| M8 two sources of truth | UI reads one cancellable + deadline rule; browser run screenshots of each state |
| M11 reserve until final | payjoin-state deadline test (coin reserved through proposed, freed at the end) |
| M12 scattered multi-wallet UI | browser run (sidebar switcher, sheet, Wallets screen, rename, remove); axe on wallets screens |
| L1 dashes | grep in the release checklist (0 in src and test) |
| worker restart | scanner "resumes mid-block from the saved checkpoint after a worker restart" |
| auto lock after Payjoin | v1-fees-autolock "waits while a Payjoin is in progress and counts from its end"; browser run "auto lock no longer held after cancel" |
