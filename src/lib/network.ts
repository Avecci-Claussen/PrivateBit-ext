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
/** Previous shipped scan start. Existing wallets on this height are moved to DEFAULT_BIRTHDAY. */
export const LEGACY_DEFAULT_BIRTHDAY = 2_228_749;
/** Default first-scan height (Fractal tip at ship). New wallets use max(tip, this). */
export const DEFAULT_BIRTHDAY = 2_231_692;

export type ChainKind = "core" | "unisat";

/** Secrets that are stored encrypted (privatebit.chain.secrets), never in privatebit.chain. */
export type ChainSecrets = { unisatToken?: string; rpcPassword?: string };

export function splitChainSecrets(cfg: ChainConfig): { plain: ChainConfig; secrets: ChainSecrets } {
  const { unisatToken, rpcPassword, ...plain } = cfg;
  const secrets: ChainSecrets = {};
  if (unisatToken) secrets.unisatToken = unisatToken;
  if (rpcPassword) secrets.rpcPassword = rpcPassword;
  return { plain: plain as ChainConfig, secrets };
}

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

export function envUnisatBase(): string {
  return FRACTAL.defaultUnisat;
}

export const DEFAULT_CHAIN: ChainConfig = {
  kind: "unisat",
  url: FRACTAL.defaultUnisat,
  // Never set here. The key is optional, typed by the user in Settings and stored encrypted.
  // scripts/check-dist.mjs fails the build if a value ever shows up in this object.
  unisatToken: undefined,
  payjoinDirectory: DEFAULT_PAYJOIN_DIRECTORY,
  ohttpRelay: DEFAULT_OHTTP_RELAY,
};

const MEMPOOL_HOST = "mempool.fractalbitcoin.io";

/** Drop Esplora / mempool hosts. The token is only what the user saved; nothing comes from the build. */
export function migrateChainConfig(cfg?: Omit<Partial<ChainConfig>, "kind"> & { kind?: string; url?: string }): ChainConfig {
  const token = cfg?.unisatToken && cfg.unisatToken.length > 0 ? cfg.unisatToken : undefined;
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
      url: FRACTAL.defaultUnisat,
      unisatToken: token,
      payjoinDirectory,
      ohttpRelay,
    };
  }
  const url = (cfg?.url || FRACTAL.defaultUnisat).replace(/\/$/, "");
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
