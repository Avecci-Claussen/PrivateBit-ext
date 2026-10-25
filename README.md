# PrivateBit

A private wallet for Bitcoin and Fractal Bitcoin, as a Chrome extension. You get one reusable receive code (Silent Payments, BIP352), payment links that Payjoin with other PrivateBit users, and keys that never leave your computer. Websites can connect to it, and each one gets its own separate account.

Version 1.0.0. Chrome 111 or newer (or any Chromium browser of that version).

## Install from a release zip

1. Download `PrivateBit-v1.0.0.zip` from the release page and check its SHA-256 against the one in the release notes.
2. Unzip it into a folder you will keep.
3. Open `chrome://extensions`, turn on **Developer mode**, select **Load unpacked** and pick the folder.
4. Pin PrivateBit, open it and choose **Create a new wallet** (or **Restore** with your recovery words).
5. Write the recovery words on paper and check them when asked. They are the only backup.

## Privacy model, in plain words

- **Your keys stay here.** The wallet is encrypted with your password and kept in this browser's local storage. It is never synced and never sent anywhere.
- **One receive code, new address every time.** People pay your `sp1` code; each payment lands on a fresh address that only you can link to you. Nobody looking at the chain can see that two payments went to the same person.
- **Finding your coins does not tell anyone which coins are yours.** PrivateBit downloads whole blocks and matches them on this computer. It never asks a server "what does this address own".
- **What a block data service sees.** If you use the public block data service (the default), it sees your IP address, which blocks and fee rates you ask for, and the payments you broadcast. It is not given your receive code or your addresses. With your own node, nobody else sees anything.
- **Payment links (Payjoin).** The other person adds one of their coins to your payment, so the usual "all inputs belong to the payer" guess is wrong. Messages go through a mailbox, encrypted so the mailbox cannot read them, and through a relay so the mailbox cannot see your IP address. You can set your own mailbox and relay in Settings.
- **USD price.** Only the price of the coin is asked for, every 10 minutes while unlocked. Turn it off in Settings, Privacy.
- **Websites.** A site you approve gets its own Taproot account made from your recovery words. It never sees your receive code, your private coins, your balance, other sites' accounts or the wallet name. Every signature and payment opens a review window. Moving coins between a site account and your private coins is a normal payment you approve, and it is visible on chain as a link between the two.

What PrivateBit cannot hide: your IP address from the data source you pick (use your own node, or a VPN), the amounts and timing of payments you make to ordinary addresses, and any link you create yourself by paying a site account from your private coins.

## Use your own node

Bitcoin Core 25 or newer for Bitcoin, or a Fractal Bitcoin node of the matching version for Fractal.

In `bitcoin.conf`:

```
server=1
txindex=1            # recommended: lets PrivateBit look up transaction parents for some payments
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
```

Then in PrivateBit, Settings, Network and data source, choose **My own node** and enter:

- **URL**, for example `http://127.0.0.1:8332`.
- **Login**: either `rpcuser` and `rpcpassword` from `bitcoin.conf`, or paste the contents of the node's `.cookie` file (it looks like `__cookie__:` followed by a long hex string). The cookie changes every time the node restarts.

The **Test** button checks that the node answers, which chain it is on, how far it has synced and whether `txindex` is on. Scanning uses `getblock` with verbosity 3, so it works without `txindex`. Nodes on `127.0.0.1` and `localhost` work out of the box; for a node on another machine Chrome asks you to allow that address once. The login is stored encrypted and only readable while the wallet is unlocked.

## Connect to websites

Pages see a provider at `window.privatebit`, and under the name most Fractal and Bitcoin dApps already look for. Methods: `requestAccounts`, `getAccounts`, `getNetwork`, `switchNetwork`, `getChain`, `switchChain`, `getPublicKey`, `getBalance`, `getInscriptions` (always empty), `signMessage` (`ecdsa`, `bip322-simple`), `signPsbt`, `signPsbts`, `pushPsbt`, `pushTx`, `sendBitcoin`, `disconnect`, plus `on` and `removeListener` for `accountsChanged`, `networkChanged` and `chainChanged`.

Each site's account is at `m/86'/coin'/i'/0/0`, where `coin` is `8228` on Fractal and `0` on Bitcoin, and `i` is a hardened index from 2^30 up, taken from a hash of the site's origin. The same site gets the same account after a restore. Connected sites are listed in Settings, Connected sites, with the address, balance, Add funds, Move back to private and Disconnect.

The extension runs a small content script on http and https pages so pages can find the provider. That is why Chrome says it can "read and change data on all websites". The script does not read the page; it only passes the page's requests to PrivateBit.

## Build from source

Requirements: Node 20.19 or newer (`.nvmrc`), npm 10 or newer.

```bash
npm ci
npm test              # unit tests
npm run build         # type check, build to dist/, then the release gate (scripts/check-dist.mjs)
npm run release       # build, then a deterministic zip in release/
```

Load `dist/` as an unpacked extension. Nothing from the environment is compiled in (`envPrefix` in `vite.config.ts`), and the release gate fails the build if `dist/` holds anything that looks like a key, a token or the test hook.

### Reproducible build

`npm run release` packs `dist/` with sorted files, fixed timestamps and fixed permissions, and prints the SHA-256 of the zip. With the same commit, the same `package-lock.json` and the same Node major version you get the same zip, byte for byte:

```bash
git checkout v1.0.0
npm ci
npm run release       # compare the printed sha256 with the release notes
```

Building twice from a clean `dist/` on the same machine gives identical zips. Differences between machines can come from a different Node or npm version; use the versions above.

## For contributors

- `src/lib/` wallet logic (BIP352, scanning, sending, Payjoin, site accounts). `src/ui/` screens. `src/dapp/` provider, content script and background handlers.
- `test/` unit tests (`npm test`). Live network tests are skipped unless you set their key in your own shell.
- `e2e/` browser runs in a real Chromium with the unpacked extension, offline with a mock chain, throwaway wallets only (see `e2e/README.md`).
- `npm run directory` runs a mailbox on localhost if you want to host your own instead of the default one.

Paths: Silent Payments keys follow BIP352: spend `m/352'/coin'/0'/0'/0`, scan `m/352'/coin'/0'/1'/0`. Migration one-time addresses are BIP86 at `m/86'/8228'/0'/0/i` (Fractal) and `m/86'/0'/352'/0/i` (Bitcoin).

## Security

See [SECURITY.md](SECURITY.md) for how to report a problem.

## License

No license has been chosen yet. Until one is added, all rights are reserved by the authors. Third party licenses for bundled fonts and icons are in `public/licenses/`.
