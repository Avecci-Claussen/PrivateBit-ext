#!/usr/bin/env python3
"""Mine real merge-mined (AuxPoW) blocks on a local fractald regtest node and save the node's own
header+auxpow serialization as test vectors. Regtest only; nothing leaves this machine."""
import hashlib, json, struct, subprocess, sys

CLI = sys.argv[1].split()
OUT = sys.argv[2]

def cli(*a):
    r = subprocess.run(CLI + list(a), capture_output=True, text=True, check=True).stdout.strip()
    try:
        return json.loads(r)
    except json.JSONDecodeError:
        return r

def dsha(b): return hashlib.sha256(hashlib.sha256(b).digest()).digest()
def varint(n): return bytes([n]) if n < 0xfd else b"\xfd" + struct.pack("<H", n)

def expected_index(nonce, chain_id, h):
    mod = 1 << h
    r = (nonce * 1103515245 + 12345) % (1 << 64)
    r %= mod; r += chain_id
    r = (r * 1103515245 + 12345) % (1 << 64)
    return r % mod

def mine(addr, height_bits):
    t = cli("createauxblock", addr)
    aux_hash_internal = bytes.fromhex(t["hash"])[::-1]
    chain_id = t["chainid"]
    h = height_bits
    nonce = 7
    idx = expected_index(nonce, chain_id, h)
    # Chain merkle tree of 2^h leaves with our block at idx; other leaves are filler hashes.
    branch = []
    node = aux_hash_internal; i = idx
    for level in range(h):
        sib = hashlib.sha256(b"sibling%d" % level).digest()
        branch.append(sib)
        node = dsha(sib + node) if i & 1 else dsha(node + sib)
        i >>= 1
    root_display = node[::-1]
    mm = (b"\xfa\xbemm" if h else b"") + root_display + struct.pack("<I", 1 << h) + struct.pack("<I", nonce)
    script = bytes([len(b"\x03\x01\x02\x03")]) + b"\x03\x01\x02\x03" + bytes([len(mm)]) + mm if h else bytes([len(mm)]) + mm
    cb = (struct.pack("<i", 1) + b"\x01" + b"\x00" * 32 + b"\xff\xff\xff\xff" + varint(len(script)) + script
          + b"\xff\xff\xff\xff" + b"\x01" + struct.pack("<q", 0) + b"\x01\x51" + b"\x00\x00\x00\x00")
    cb_id = dsha(cb)
    # Parent block: coinbase plus one more tx so the coinbase merkle branch is not empty.
    other = hashlib.sha256(b"other tx").digest()
    parent_root = dsha(cb_id + other)
    bits = int(t["bits"], 16)
    target = (bits & 0xffffff) << (8 * ((bits >> 24) - 3))
    n = 0
    while True:
        ph = struct.pack("<i", 0x20000000) + b"\x00" * 32 + parent_root + struct.pack("<III", 1700000000, bits, n)
        if int.from_bytes(dsha(ph), "little") <= target: break
        n += 1
    aux = (cb + b"\x00" * 32 + varint(1) + other + struct.pack("<i", 0)
           + varint(len(branch)) + b"".join(branch) + struct.pack("<i", idx) + ph)
    ok = cli("submitauxblock", t["hash"], aux.hex())
    if ok is not True and ok != "true":
        raise SystemExit(f"node refused the auxpow block: {ok}")
    full = cli("getblockheader", t["hash"], "false", "true")
    info = cli("getblockheader", t["hash"])
    return {"hash": t["hash"], "height": info["height"], "headerWithProof": full, "chainMerkleHeight": h}

addr = cli("getnewaddress", "", "bech32m")
vectors = [mine(addr, 0), mine(addr, 2)]
tip = cli("getbestblockhash")
legacy = cli("generatetoaddress", "1", addr)[0]
vectors.append({"hash": legacy, "height": cli("getblockheader", legacy)["height"], "headerWithProof": cli("getblockheader", legacy, "false", "true"), "legacy": True})
json.dump({"node": "fractald v0.4.0 regtest", "vectors": vectors}, open(OUT, "w"), indent=1)
print("saved", len(vectors), "vectors")
