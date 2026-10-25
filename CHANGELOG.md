# Changelog

## 1.0.0

First public release.

### Security audit v1 (folded into 1.0.0)
Full report: SECURITY-AUDIT-v1.md. Highlights:
- Payjoin link coins with an odd spend key sign correctly (existing Fractal receipts become
  spendable), and link outputs come from the seed so a restore finds them.
- Site signing refuses SIGHASH_SINGLE and NONE variants; ALL|ANYONECANPAY is signed with a warning.
- The page provider is added only to sites you allowed, or every site if you turn that on in Privacy.
- New passwords need at least 12 characters; vaults move to scrypt 2^17 on the next unlock.
- Explorer blocks are checked against their merkle root, hash and proof of work.
- An unfinished Payjoin link sends the payer's original payment after its deadline.
- Auto lock never waits. A Payjoin keeps going after Lock with keys for its own coins only.
- While unlocked no recovery words, seed or spend key stay in memory; the seed is sealed with a
  key the browser cannot export and opened only for each operation.
- Wrong passwords wait longer each time (3 free tries, then from 30 seconds up to 1 hour).
- Fee and price checks run on random timers, not when you open a screen.
- Mailbox encryption keys never come straight from the mailbox: through the relay on Android,
  shipped with the app for payjo.in, or directly only if you turn that on.
- Sites can only relay transactions that spend their own account and wait after repeated rejections.

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

### Fixes since the first test build
- Payjoin change. When you paid a Payjoin link, the change from your own coins was sent back to you on chain but the wallet did not see it, so the balance showed too little. The receiver adds a coin of their own, and the wallet looked for your change using every coin in the payment instead of only yours. It now also checks with only your coins, right after sending and when finding coins again. Change missed by the first test build comes back on its own at the next sync, and a restore from recovery words finds it too. Activity shows it as "Back to you".

### Layout since the first test build
- Coins table on wide screens: 48 px touch area for the select box and the freeze switch.
- Narrow screens and larger text: the header, rows, amounts and bottom tabs fit from 320 px wide and at 1.3 times the text size. Wallet names shorten with an ellipsis, the status and chain chips drop their labels to icons when space is short, amounts always stay whole, and long button labels wrap.
- The type scale can grow as one (text, line heights and boxes together). The Android app uses it for the phone font size, up to 1.3 times.
- Switch rows toggle from anywhere on the row.
- Unlock shows the password field before the note about where keys are kept.
