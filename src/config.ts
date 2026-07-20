/**
 * Configuration. Every value has a sensible built-in default, so the app runs
 * with NO environment variables at all (as required). Each can still be
 * overridden by an env var if you want to, but none are necessary.
 */

function num(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function str(name: string, def: string): string {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : def;
}

/** Where the bulk service listens. */
export const PORT = num("PORT", 8080);

/** TOKOPAY API base. Standard public endpoint — no env needed. */
export const TOKOPAY_BASE = str("TOKOPAY_BASE", "https://www.tokopay.io").replace(/\/$/, "");

/** Embedded PGlite data directory (persisted to disk; mount a volume here). */
export const PGDATA_DIR = str("PGDATA_DIR", "./pgdata");

/**
 * How many TOKOPAY requests the worker keeps in flight at once. This is now a
 * limit on how many DISTINCT wallets are processed concurrently — a single
 * wallet is always processed strictly one transaction at a time (see worker.ts),
 * because concurrent sends for the same wallet collide on the on-chain nonce and
 * TOKOPAY rejects them with "Replacement transaction underpriced".
 */
export const WORKER_CONCURRENCY = num("WORKER_CONCURRENCY", 8);

/**
 * Optional pause after a wallet's transaction settles before its next one is
 * sent. Sequential-per-wallet already prevents nonce collisions; this is only a
 * safety margin for RPC nodes whose "pending" nonce lags a moment behind a fresh
 * broadcast. Default 0 (no extra wait).
 */
export const WALLET_SEND_SPACING_MS = num("WALLET_SEND_SPACING_MS", 0);

/** Idle poll interval when there's no queued work. */
export const POLL_INTERVAL_MS = num("POLL_INTERVAL_MS", 750);

/** Short delay between claim cycles while actively draining the queue. */
export const BUSY_INTERVAL_MS = num("BUSY_INTERVAL_MS", 50);

/** Max attempts per transaction (retries only on network / 5xx errors). */
export const MAX_ATTEMPTS = num("MAX_ATTEMPTS", 3);

/** Per-request timeout when calling TOKOPAY. */
export const REQUEST_TIMEOUT_MS = num("REQUEST_TIMEOUT_MS", 30_000);

/** Largest number of transactions accepted in a single bulk request. */
export const MAX_BATCH_SIZE = num("MAX_BATCH_SIZE", 1000);

/**
 * TOKOPAY endpoints this gateway will bulk-submit to. Whitelisted to prevent
 * the gateway being used as an open proxy. Exactly the documented write/
 * contract transaction endpoints.
 */
export const ALLOWED_ENDPOINTS: readonly string[] = [
  "/api/v1/wallets/send",
  "/api/v1/wallets/transfer-token",
  "/api/v1/wallets/transfer-nft",
  "/api/v1/wallets/contract-call",
  "/api/v1/paymaster/transfer-token",
  "/api/v1/paymaster/transfer-nft",
  "/api/v1/paymaster/contract-call",
  "/api/v1/meta/transfer-token",
  "/api/v1/meta/transfer-nft",
  "/api/v1/meta/contract-call",
  "/api/v1/asset-recovery/transfer-token",
  "/api/v1/asset-recovery/transfer-nft",
  "/api/v1/asset-recovery/send-native",
] as const;

export function isAllowedEndpoint(ep: string): boolean {
  return ALLOWED_ENDPOINTS.includes(ep);
}
