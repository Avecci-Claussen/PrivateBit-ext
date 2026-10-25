#!/usr/bin/env node
/**
 * Deterministic release zip of dist/: files sorted, fixed timestamps, fixed permissions, no
 * extra fields. Same source + same lockfile + same Node gives the same zip, byte for byte.
 *
 * Usage: node scripts/pack-release.mjs [distDir] [out.zip]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { deflateRawSync, crc32 } from "node:zlib";

const dist = process.argv[2] ?? "dist";
const out = process.argv[3] ?? "PrivateBit-v1.0.0.zip";
const walk = (d) => readdirSync(d).sort().flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(dist).map((f) => relative(dist, f).split("\\").join("/")).sort();
// 1980-01-01 00:00 in DOS time.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const locals = [];
const centrals = [];
let offset = 0;
for (const name of files) {
  const data = readFileSync(join(dist, name));
  const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data) >>> 0;
  const nameB = Buffer.from(name, "utf8");
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(DOS_TIME, 10); lh.writeUInt16LE(DOS_DATE, 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
  locals.push(lh, nameB, comp);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(DOS_TIME, 12); ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
  ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
  centrals.push(ch, nameB);
  offset += 30 + nameB.length + comp.length;
}
const cd = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, cd, end]);
writeFileSync(out, zip);
console.log(`${out}: ${files.length} files, sha256 ${createHash("sha256").update(zip).digest("hex")}`);
