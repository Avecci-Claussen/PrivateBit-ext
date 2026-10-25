# Changelog

## 1.0.0

First public release.

### Wallet
- Bitcoin and Fractal Bitcoin mainnet, switched with the chain chip. Each chain keeps its own coins, history and settings.
- One reusable receive code (Silent Payments, BIP352). Coins are found by matching whole blocks on this computer.
- Several wallets on one computer, each with its own name and password.
- Restore from recovery words, with a start block to look back from.
- Auto lock, password change, show recovery words after the password.

### Sending
- Send to receive codes, payment links and ordinary addresses, with a review before every send.
- Automatic coin choice or choose coins yourself, frozen coins, labels, and a warning before spending coins with different labels together.
- Split a coin into several, send at a random time within a delay you pick, fee choices with custom rates.

### Payment links (Payjoin)
- Payjoin between two PrivateBit users through an encrypted mailbox and a relay. Your own mailbox and relay can be set per chain.

### Moving in
- One-time addresses to move coins from wallets that cannot pay a receive code yet, then into the receive code.

### Websites
- Connect to dApps through `window.privatebit` and the usual compatibility name.
- Each site gets its own Taproot account at `m/86'/coin'/i'/0/0` with `i` from a hash of the site's origin. Sites never see the receive code, private coins, other sites or the wallet name.
- Approval window for connect, message signing (standard and BIP322), PSBT signing with a full review, payments and chain switch. Private coins are never signed for a site.
- Connected sites in Settings, with Add funds, Move back to private and Disconnect.

### Data sources
- Public block data service by default, or your own node (RPC login or cookie).
- Optional USD price, off with one switch.

### Full page
- Expanded view with a sidebar; the main column is centered on wide screens.
