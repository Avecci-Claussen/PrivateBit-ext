#!/usr/bin/env node
/**
 * Release gate, run by `npm run build` after vite. Fails when the built extension carries
 * anything that looks like a secret. Matches are reported by file and kind only; the value
 * itself is never printed, so a CI log cannot leak it either.
 *
 * Usage: node scripts/check-dist.mjs [distDir]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const dist = process.argv[2] ?? "dist";

/** Long hex strings that are public protocol constants and appear in the libraries we bundle. */
const PUBLIC_HEX = new Set([
  // secp256k1 field prime, order, generator, BIP340/341 NUMS point and friends.
  "fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f",
  "fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
  "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
  "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
  // Public block hashes that tell Fractal and Bitcoin nodes apart (src/lib/network.ts checkpoints).
  "00000000000000010eee723c7e38b605003765c9b3a26bd5c0a3b44c39803653",
  "000000000000000000010538edbfd2d5b809a33dd83f284aeea41c6d0d96968a",
  // Fractal indexer cold keys. Public, published in src/lib/headerproof.ts. Not a service token.
  "da8d7239fdb567d62b38f371a77d2d3fe40d0d1a84dc21d7ab0fb0188c506b83",
  "5cd26f06fb752947bd414bafeedbaefe5461c543e6f7b404a7900d0ad4f0247d",
]);

const RULES = [
  {
    kind: "non-empty default unisatToken",
    re: /unisatToken\s*:\s*(?:[\w$.]+\(\)\s*\|\|\s*)?(["'`])([^"'`]+)\1/g,
    hit: (m) => m[2].trim().length > 0,
  },
  { kind: "bearer token literal", re: /Bearer\s+[0-9a-zA-Z._-]{20,}/g },
  {
    // A data service key compiled in as a bare constant (what a private test build does on purpose).
    kind: "long hex string constant",
    re: /(["'`])([0-9a-fA-F]{40,128})\1/g,
    hit: (m) => !PUBLIC_HEX.has(m[2].toLowerCase()),
  },
  { kind: "env variable name for the live test key", re: /PRIVATEBIT_LIVE_TEST_UNISAT_KEY/g },
  { kind: "process.env read", re: /process\.env\.[A-Z_]{3,}/g },
  { kind: "end-to-end test hook in a release build", re: /__pbE2E/g },
  // Audit L7: the CSP has no unsafe-inline for styles, so a style attribute would be dropped.
  { kind: "inline style attribute (blocked by the CSP)", re: /\bstyle=\\?"[^"\\]/g },
  { kind: "unsafe-inline or unsafe-eval in a policy", re: /'unsafe-(?:inline|eval)'/g },
  { kind: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: "extended private key", re: /\b[xtyz]prv[1-9A-HJ-NP-Za-km-z]{100,}/g },
  { kind: "WIF private key", re: /(["'`])[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\1/g },
  { kind: "cloud key", re: /\b(?:AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{20,}|ghp_[0-9A-Za-z]{30,}|xox[abp]-[0-9A-Za-z-]{20,})\b/g },
  {
    kind: "hex secret next to a key or token name",
    re: /(?:token|apikey|api_key|secret|authorization|password)["'`]?\s*[:=]\s*(?:[\w$.]+\(\)\s*\|\|\s*)?["'`]([0-9a-fA-F]{32,})["'`]/gi,
    hit: (m) => !PUBLIC_HEX.has(m[1].toLowerCase()),
  },
];

const FORBIDDEN_FILES = [/^\.env/, /\.map$/, /secrets\.local/];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

let files;
try {
  files = walk(dist);
} catch {
  console.error(`check-dist: ${dist} does not exist. Run vite build first.`);
  process.exit(1);
}

const problems = [];
for (const file of files) {
  const rel = relative(dist, file);
  const base = rel.split(/[\\/]/).pop();
  if (FORBIDDEN_FILES.some((re) => re.test(base))) problems.push(`${rel}: file must not ship`);
  if (!/\.(js|mjs|cjs|html|json|css|txt)$/i.test(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      if (rule.hit && !rule.hit(m)) continue;
      problems.push(`${rel}: ${rule.kind} at offset ${m.index}`);
    }
  }
}

if (problems.length) {
  console.error("check-dist: refusing this build. Values are not printed.");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-dist: ${files.length} files clean`);
