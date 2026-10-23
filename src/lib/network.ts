/** Fractal Bitcoin. Same scripts as Bitcoin, different ledger. */

export const FRACTAL_CHAIN_ID = 0x2024;
export const FRACTAL_COIN_TYPE = FRACTAL_CHAIN_ID;
export const BIP352_PURPOSE = 352;
export const SP_K_MAX = 2323;
export const CHANGE_LABEL = 0;

export const FRACTAL = {
  id: "fractal",
  name: "Fractal Bitcoin",
  chainId: FRACTAL_CHAIN_ID,
  coinType: FRACTAL_COIN_TYPE,
  /** BIP352 v0 HRP. UI must always say Fractal — this collides with BTC sp1. */
  spHrp: "sp",
  bech32: "bc",
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
  messageMagic: 0xd99e94b9,
  defaultUnisat: "https://open-api-fractal.unisat.io",
} as const;

/**
 * First Fractal Silent Payment send we scan for.
 * txid 0a6013191e7965a1f41d901e926cdbc2c2f80b5d58a5f8916e438eebc19168b0
 * → unique P2TR bc1p8jpgfw062s0krplk3zvz4sdqaywrmcv6pa5ar0gxntp8cwz85mxs3ly7k9
 */
export const DEFAULT_BIRTHDAY = 2_228_749;

export type ChainKind = "core" | "unisat";

export type ChainConfig = {
  kind: ChainKind;
  /** Core RPC URL, or UniSat Open API base. */
  url: string;
  rpcUser?: string;
  rpcPassword?: string;
  /** UniSat Bearer token. Empty = unauthenticated (rate-limited, often unusable). */
  unisatToken?: string;
  /** BIP77 mailbox (HPKE payloads, 7168 bytes). ntfy.sh cannot carry those. */
  payjoinDirectory?: string;
  ohttpRelay?: string;
};

/** Public BIP77 directory. Payloads are HPKE; OHTTP needs a relay. */
export const DEFAULT_PAYJOIN_DIRECTORY = "https://payjo.in";
/** Default OHTTP relay used with payjo.in (BIP77 ecosystem). */
export const DEFAULT_OHTTP_RELAY = "https://pj.bobspacebkk.com";

function envString(key: "VITE_UNISAT_API_KEY" | "VITE_UNISAT_BASE"): string {
  const v = import.meta.env[key];
  return typeof v === "string" ? v.trim() : "";
}

export function envUnisatToken(): string {
  return envString("VITE_UNISAT_API_KEY");
}

export function envUnisatBase(): string {
  return envString("VITE_UNISAT_BASE") || FRACTAL.defaultUnisat;
}

export const DEFAULT_CHAIN: ChainConfig = {
  kind: "unisat",
  url: envUnisatBase(),
  unisatToken: envUnisatToken(),
  payjoinDirectory: DEFAULT_PAYJOIN_DIRECTORY,
  ohttpRelay: DEFAULT_OHTTP_RELAY,
};

const MEMPOOL_HOST = "mempool.fractalbitcoin.io";

/** Drop Esplora / mempool hosts. Token comes from .env.local at build if unset. */
export function migrateChainConfig(cfg?: Partial<ChainConfig> & { kind?: string; url?: string }): ChainConfig {
  const token = (cfg?.unisatToken && cfg.unisatToken.length > 0 ? cfg.unisatToken : envUnisatToken()) || undefined;
  const rawDir = cfg?.payjoinDirectory?.trim() || DEFAULT_PAYJOIN_DIRECTORY;
  const payjoinDirectory = /ntfy\.sh/i.test(rawDir) ? DEFAULT_PAYJOIN_DIRECTORY : rawDir;
  const ohttpRelay = cfg?.ohttpRelay?.trim() || DEFAULT_OHTTP_RELAY;
  if (cfg?.kind === "core") {
    return {
      kind: "core",
      url: cfg.url ?? "",
      rpcUser: cfg.rpcUser,
      rpcPassword: cfg.rpcPassword,
      payjoinDirectory,
      ohttpRelay,
    };
  }
  if (cfg?.kind === "esplora" || (cfg?.url && cfg.url.includes(MEMPOOL_HOST))) {
    return {
      kind: "unisat",
      url: envUnisatBase(),
      unisatToken: token,
      payjoinDirectory,
      ohttpRelay,
    };
  }
  const url = (cfg?.url || envUnisatBase()).replace(/\/$/, "");
  return {
    kind: "unisat",
    url,
    unisatToken: token,
    payjoinDirectory,
    ohttpRelay,
  };
}

const REDACTED = "********";

export function isRedactedSecret(value?: string): boolean {
  return !value || value === REDACTED;
}

/** STATE/UI must not carry RPC or API secrets. */
export function redactChain(cfg: ChainConfig): ChainConfig {
  return {
    ...cfg,
    rpcPassword: cfg.rpcPassword ? REDACTED : undefined,
    unisatToken: cfg.unisatToken ? REDACTED : undefined,
  };
}

export function derivationPath(account = 0): { spend: string; scan: string } {
  const a = `${BIP352_PURPOSE}'/${FRACTAL_COIN_TYPE}'/${account}'`;
  return {
    spend: `m/${a}/0'/0`,
    scan: `m/${a}/1'/0`,
  };
}
