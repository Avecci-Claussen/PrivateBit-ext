# PrivateBit

Fractal Bitcoin wallet for Chrome. One reusable receive code, keys that stay on your computer, and Payjoin between two PrivateBit users without running a server.

## For people using it

1. Load the `dist/` folder as an unpacked Chrome extension.
2. **Create a new wallet**, write down the recovery words, check them, then copy your receive code.
3. Moving coins from another wallet or a reused address: send them to your receive code once, then stop using the old address. If your old wallet refuses the code, PrivateBit gives you a one-time address for that move.
4. To get paid by another PrivateBit user, create a **Payment link** and send it to them. They review it and confirm the send.
5. Both of you can close the window while a payment link is open. PrivateBit will not lock itself during a Payjoin; it counts the auto-lock time from when the payment ends.

Payment links use payjo.in as a mailbox. The PSBT is HPKE encrypted so the mailbox cannot read it, and requests go through an OHTTP relay so the mailbox cannot pair your IP with the mailbox id.

A plain `sp1` send does not Payjoin. Payjoin only runs when both people use a PrivateBit payment link.

## What is stored on this computer

Everything is in `chrome.storage.local`, never synced. The vault is encrypted with your password. Activity history, coin labels, the scan state, the optional block data API key and node login are encrypted with a key derived from your seed, so they can only be read while the wallet is unlocked. Remove wallet in Settings deletes all of it.

USD prices come from a price service (`api.coingecko.com`) every 10 minutes while unlocked. Turn it off in Settings, Privacy, and no request is made.

## For operators and contributors

```bash
cd PrivateBit
npm install
npm test
npm run build
```

No API key is ever built into `dist/`. The block data service works without a key but often limits requests; a user can paste their own key in Settings, Network and data source, where it is stored encrypted. The build ignores every environment variable (`envPrefix` in `vite.config.ts`).

The live network tests read `PRIVATEBIT_LIVE_TEST_UNISAT_KEY` from the process environment only when you run them yourself; they are skipped otherwise.

`npm run directory` is only if you want to self host the mailbox on localhost instead of payjo.in. That process is an OHTTP gateway (`/.well-known/ohttp-gateway`) plus an opaque blob store.

Silent Payments (BIP352): the receive screen shows one `sp1` code. Address based APIs cannot find those coins, so PrivateBit reads transaction hex and computes tweaks locally. Coin type `8228`.

One-time migration addresses are BIP86 Taproot at `m/86'/8228'/0'/0/i`, each used once. A restore watches indexes 0 to 4.

Payjoin (BIP77): two parties, HPKE Message A/B (7168 bytes), OHTTP (8192 bytes), `pjos=0`. A failed Payjoin does not broadcast the original. See `test/payjoin-v2.test.ts` and `test/payjoin-live.test.ts`.

GreyBound, The Lonely Bits LLC.
