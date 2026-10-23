# PrivateBit

Fractal Bitcoin wallet. One receive code. Local keys. Payjoin between two PrivateBit users without running a server.

## For people using it

1. Load the `dist/` folder as a Chrome extension (unpacked).
2. **Create wallet**, write down the words, copy **Your code**.
3. Coming from UniSat or any reused address: send those coins to that code, then stop using the old address.
4. To get paid by another PrivateBit user: **Create payment link**, send them the link. They **Review**, then **Confirm send**.
5. Both of you can close the window. Do not tap **Lock** until the payment finishes — Lock wipes the Payjoin keys.

You never run `npm`. Payment links use payjo.in as a mailbox. The PSBT is HPKE-encrypted so the mailbox cannot read it. OHTTP through a relay so the mailbox cannot pair your IP with the mailbox id.

A plain `sp1…` send does not Payjoin. Payjoin only runs when both people use a PrivateBit payment link.

This code is **Fractal**, not Bitcoin. A Bitcoin wallet sending here will not reach these keys.

## For operators / contributors

```bash
cd PrivateBit
npm install
npm test
npm run build
```

Put the UniSat key in gitignored `.env.local` as `VITE_UNISAT_API_KEY`. `npm run build` embeds `VITE_*` into `dist/`. Do not publish the unpacked extension.

`npm run directory` is only if you want to self-host the mailbox on localhost instead of payjo.in. That process is an OHTTP gateway (`/.well-known/ohttp-gateway`) plus an opaque blob store.

Silent Payments (BIP352): the receive screen is one `sp1…`. UniSat’s address-UTXO API cannot find those coins; PrivateBit scans transaction hex and computes tweaks locally. Coin type `8228` so a Bitcoin BIP352 path cannot spend these keys.

Payjoin (BIP77): two parties, HPKE Message A/B (7168 bytes), OHTTP (8192 bytes), `pjos=0`. Failed Payjoin does not broadcast the original. See `test/payjoin-v2.test.ts` and `test/payjoin-live.test.ts`.

GreyBound / The Lonely Bits LLC. Not SHORD. Not Ord Dropz.
