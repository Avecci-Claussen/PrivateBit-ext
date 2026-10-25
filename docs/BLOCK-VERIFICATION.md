# What PrivateBit checks about the blocks it reads

PrivateBit finds payments by reading whole blocks. This page says exactly what is checked before
a block is used, for each source and block type.

## Every block, every source

- The 80-byte header hashes to the block hash asked for.
- The transactions hash to the header's merkle root.
- Each block's previous-block hash must match the block matched before it. A mismatch is treated
  as a reorg: what was learned from the replaced blocks is undone and they are read again.
- Parent transactions fetched for input scripts must hash to the txid asked for.

## Public explorer (mempool.space, mempool.fractalbitcoin.io)

| Block type | How it is told apart | Proof of work check |
|---|---|---|
| Bitcoin, any version | always one type (version bit 8 is only BIP9 signalling and never skips the check) | header hash is under its own target, and the target needs at least 2^70 hashes |
| Fractal normal block | version bit 8 clear | header hash is under its own target, and the target needs at least 2^58 hashes (about 2^62 today) |
| Fractal merge-mined | bit 8 set, chain ID 0x2024 | the Bitcoin parent header that holds the work is stripped by explorers. The header's target must claim at least 2^66 hashes (about 2^75 today). The work itself is **not** verified |
| Fractal indexer (FIP-101) | bit 8 set, chain ID 0x2026 | the signed indexer proof is stripped by explorers. The target must be exactly the powLimit (0x1d00ffff). The signatures are **not** verified |
| Any other chain ID | | refused |

Run limit: a linked run of more than 40 merge-mined or indexer blocks in a row is refused. In 1050
recent mainnet blocks the longest such run was 12. A forged chain from a dishonest explorer must
therefore still contain a normally mined block with real work every 41 blocks.

What this does not protect against: an explorer willing to mine normal Fractal blocks at the
2^58 floor can show payments that are not on the real chain. Public mode trusts the explorer for
that; it never trusts it with keys, and no coin can be stolen this way. For full verification use
your own node.

## Your own node (Bitcoin Core or fractald)

The node has validated the chain itself. PrivateBit additionally checks the hash and merkle root of
every block it is given, and on Fractal reads each merge-mined or indexer block's proof with
`getblockheader <hash> false true` and verifies it in full:

Merge-mined (AuxPoW), as in fractald `CAuxPow::check`:
- the parent header's chain ID is not Fractal's (0x2024)
- the chain merkle branch is at most 30 long, and folds the Fractal block hash into a root
- that root appears in the parent coinbase's first input script, right after the single
  `fa be 6d 6d` merged-mining marker (or in its first 20 bytes when there is no marker)
- the tree size after the root equals 2^branch length, and the chain index equals the
  expected index for the nonce and chain ID
- the coinbase is transaction 0 and its merkle branch leads to the parent header's merkle root
- the parent header's hash is under the Fractal header's target

Indexer blocks (FIP-101, fractald `src/primitives/indexer.cpp`):
- bits are the powLimit
- block time is not after the authorization expiry
- the cursor (first two bytes of the previous block hash) is inside the authorized range
- SHA256d(hot key || header) is under the target
- the cold signature (BIP340, by the mainnet cold key in fractald's chain parameters) over
  SHA256d(hot key || expiry || range start || range end)
- the hot signature over the block hash

Not checked by PrivateBit (the node does it): difficulty retargeting (ASERT per block type) and
FIP-101's count rules (no two indexer blocks in a row, indexer count limits).

## How this was tested

- `test/headerproof.test.ts`: two merge-mined blocks mined on a local fractald v0.4.0 regtest node
  and accepted by it (`scripts/fractal-mine-aux.py`), one with a 2-level chain merkle tree; each
  part of the proof tampered with; fractald's own cold-signature test vector; full indexer proofs
  with test keys; the run limit.
- `test/fractald-node.test.ts` (set `FRACTALD_LIVE_RPC`): every block of a live fractald regtest
  node through the own-node source, merge-mined blocks with their proof.
- `test/fractal-explorer-live.test.ts` (set `PB_LIVE_EXPLORER=1`): the latest mainnet blocks of all
  three Fractal types and a Bitcoin block pass the explorer checks.
