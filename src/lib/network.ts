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
  /** BIP352 v0 HRP. UI must always say Fractal: this collides with BTC sp1. */
  spHrp: "sp",
  bech32: "bc",
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
  messageMagic: 0xd99e94b9,
  defaultUnisat: "https://open-api-fractal.unisat.io",
} as const;

/** Bitcoin mainnet. Same address formats; the wallet keys come from the standard BIP352 path. */
export const BITCOIN = {
  id: "bitcoin",
  name: "Bitcoin",
  coinType: 0,
  spHrp: "sp",
  bech32: "bc",
  pubKeyHash: 0x00,
  scriptHash: 0x05,
  wif: 0x80,
  /** UniSat Open API for Bitcoin. A Fractal key is refused here. */
  defaultUnisat: "https://open-api.unisat.io",
} as const;

export type NetworkId = "fractal" | "bitcoin";
export const NETWORK_IDS: NetworkId[] = ["fractal", "bitcoin"];

export type NetworkInfo = {
  id: NetworkId;
  /** Shown everywhere the chain is named. */
  name: string;
  /** Short name on the network chip. */
  short: string;
  unit: string;
  coinType: number;
  /** Explorer that serves blocks, fees and broadcasts in public mode. */
  explorer: string;
  /** Link for a transaction, for people. */
  txUrl: (txid: string) => string;
  /** Plan id domain (audit M10): a plan for one chain never confirms on the other. */
  planChain: string;
  /** A block hash only this chain has, to tell which chain a node follows. Both share the genesis block. */
  checkpoint: { height: number; hash: string };
  /** A wallet first opened on this network starts reading here at the earliest. */
  defaultBirthday: number;
  /** Price lookups for this coin. */
  price: { coingecko: string; mexc: string };
};

export const NETWORKS: Record<NetworkId, NetworkInfo> = {
  fractal: {
    id: "fractal",
    name: "Fractal Bitcoin",
    short: "Fractal",
    unit: "FB",
    coinType: FRACTAL_COIN_TYPE,
    explorer: "https://mempool.fractalbitcoin.io",
    txUrl: (txid) => `https://mempool.fractalbitcoin.io/tx/${txid}`,
    planChain: `fractal:${FRACTAL_CHAIN_ID}`,
    checkpoint: { height: 2_200_000, hash: "00000000000000010eee723c7e38b605003765c9b3a26bd5c0a3b44c39803653" },
    defaultBirthday: 2_231_692,
    price: { coingecko: "fractal-bitcoin", mexc: "FBUSDT" },
  },
  bitcoin: {
    id: "bitcoin",
    name: "Bitcoin",
    short: "Bitcoin",
    unit: "BTC",
    coinType: BITCOIN.coinType,
    explorer: "https://mempool.space",
    txUrl: (txid) => `https://mempool.space/tx/${txid}`,
    planChain: "bitcoin:main",
    checkpoint: { height: 900_000, hash: "000000000000000000010538edbfd2d5b809a33dd83f284aeea41c6d0d96968a" },
    defaultBirthday: 972_900,
    price: { coingecko: "bitcoin", mexc: "BTCUSDT" },
  },
};

export function isNetworkId(v: unknown): v is NetworkId {
  return v === "fractal" || v === "bitcoin";
}

export function netInfo(id: NetworkId | undefined): NetworkInfo {
  return NETWORKS[id && isNetworkId(id) ? id : "fractal"];
}

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
export type ChainSecrets = { unisatToken?: string; rpcPassword?: string; sendNodePassword?: string };

export function splitChainSecrets(cfg: ChainConfig): { plain: ChainConfig; secrets: ChainSecrets } {
  const { unisatToken, rpcPassword, sendNodePassword, ...plain } = cfg;
  const secrets: ChainSecrets = {};
  if (unisatToken) secrets.unisatToken = unisatToken;
  if (rpcPassword) secrets.rpcPassword = rpcPassword;
  if (sendNodePassword) secrets.sendNodePassword = sendNodePassword;
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
  /**
   * Allow fetching a mailbox's encryption keys straight from the mailbox, which shows it this IP.
   * Off by default: the keys come through the relay (Android) or ship with the app (default mailbox).
   */
  directMailboxKeys?: boolean;
  /**
   * The user's ord server (or ordinals.com on Bitcoin) for checking whether a protected small
   * coin holds an inscription or rune. Asked only when the user taps Check; it learns that outpoint.
   */
  ordUrl?: string;
  /**
   * Public mode only: "node" sends payments through the user's own node at sendNodeUrl, so the
   * public service never sees them. A node in "core" mode always sends through itself.
   */
  sendVia?: "public" | "node";
  sendNodeUrl?: string;
  sendNodeUser?: string;
  sendNodePassword?: string;
};

function sendRoute(cfg?: Omit<Partial<ChainConfig>, "kind">): Pick<ChainConfig, "sendVia" | "sendNodeUrl" | "sendNodeUser" | "sendNodePassword"> {
  const url = cfg?.sendNodeUrl?.trim();
  if (cfg?.sendVia !== "node" || !url) return url ? { sendVia: "public", sendNodeUrl: url, sendNodeUser: cfg?.sendNodeUser, sendNodePassword: cfg?.sendNodePassword } : {};
  return { sendVia: "node", sendNodeUrl: url, sendNodeUser: cfg.sendNodeUser, sendNodePassword: cfg.sendNodePassword };
}

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

const MEMPOOL_HOSTS = ["mempool.fractalbitcoin.io", "mempool.space"];

/**
 * Public data-service host for this chain. An empty address, or the other chain's public
 * UniSat host, is rewritten. A node URL or a proxy the user typed is left as they typed it.
 */
export function publicServiceUrl(cfg: { url?: string } | undefined, net: NetworkId): string {
  const url = (cfg?.url || "").replace(/\/$/, "");
  const fractal = FRACTAL.defaultUnisat.replace(/\/$/, "");
  const bitcoin = BITCOIN.defaultUnisat.replace(/\/$/, "");
  if (net === "bitcoin") return !url || url === fractal ? bitcoin : url;
  return !url || url === bitcoin ? fractal : url;
}

/** Drop Esplora / mempool hosts. The token is only what the user saved; nothing comes from the build. */
export function migrateChainConfig(cfg?: Omit<Partial<ChainConfig>, "kind"> & { kind?: string; url?: string }, net: NetworkId = "fractal"): ChainConfig {
  const token = cfg?.unisatToken && cfg.unisatToken.length > 0 ? cfg.unisatToken : undefined;
  const rawDir = cfg?.payjoinDirectory?.trim() || DEFAULT_PAYJOIN_DIRECTORY;
  const payjoinDirectory = /ntfy\.sh/i.test(rawDir) ? DEFAULT_PAYJOIN_DIRECTORY : rawDir;
  const ohttpRelay = cfg?.ohttpRelay?.trim() || DEFAULT_OHTTP_RELAY;
  const ordUrl = typeof cfg?.ordUrl === "string" && /^https?:\/\/[^\s]+$/i.test(cfg.ordUrl.trim()) ? cfg.ordUrl.trim().replace(/\/+$/, "") : undefined;
  const direct = { ...(cfg?.directMailboxKeys === true ? { directMailboxKeys: true as const } : {}), ...(ordUrl ? { ordUrl } : {}) };
  if (cfg?.kind === "core") {
    return {
      kind: "core",
      url: cfg.url ?? "",
      rpcUser: cfg.rpcUser,
      rpcPassword: cfg.rpcPassword,
      payjoinDirectory,
      ohttpRelay,
      ...direct,
    };
  }
  if (cfg?.kind === "esplora" || (cfg?.url && MEMPOOL_HOSTS.some((h) => cfg.url!.includes(h)))) {
    return {
      kind: "unisat",
      url: publicServiceUrl(undefined, net),
      unisatToken: token,
      payjoinDirectory,
      ohttpRelay,
      ...direct,
      ...sendRoute(cfg),
    };
  }
  const url = publicServiceUrl(cfg, net);
  return {
    kind: "unisat",
    url,
    unisatToken: token,
    payjoinDirectory,
    ohttpRelay,
    ...direct,
    ...sendRoute(cfg),
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
    sendNodePassword: cfg.sendNodePassword ? REDACTED : undefined,
  };
}

/** BIP352 key paths. Fractal keeps its own coin type (unchanged); Bitcoin uses the standard 0. */
export function derivationPath(account = 0, net: NetworkId = "fractal"): { spend: string; scan: string } {
  const a = `${BIP352_PURPOSE}'/${netInfo(net).coinType}'/${account}'`;
  return {
    spend: `m/${a}/0'/0`,
    scan: `m/${a}/1'/0`,
  };
}
