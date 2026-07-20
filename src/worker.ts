import type { PGlite } from "@electric-sql/pglite";
import {
  WORKER_CONCURRENCY,
  POLL_INTERVAL_MS,
  BUSY_INTERVAL_MS,
  MAX_ATTEMPTS,
  WALLET_SEND_SPACING_MS,
} from "./config";
import { callTokopay } from "./tokopay";
import type { TransactionRow } from "./types";

/**
 * The bulk worker. Runs in the same process as the HTTP server (PGlite is
 * single-process).
 *
 * IMPORTANT — nonce safety. TOKOPAY signs and broadcasts each transaction, and
 * it derives the on-chain nonce from the wallet's *pending* transaction count at
 * request time. If we fire several requests for the SAME wallet at once, every
 * one of them reads the same pending nonce, so they all try to broadcast with an
 * identical nonce and the RPC rejects the losers with
 * "Replacement transaction underpriced" (code=REPLACEMENT_UNDERPRICED).
 *
 * To avoid this the worker never sends more than one transaction per wallet at a
 * time. Transactions for a given wallet go out strictly sequentially, in order
 * (created_at, then idx), so TOKOPAY assigns them consecutive nonces. Different
 * wallets are still processed concurrently, up to WORKER_CONCURRENCY of them.
 *
 * Lifecycle of one transaction row:
 *   queued → (claimed) processing → success | failed
 *                                   ↘ (transient error, attempts<MAX) → queued
 *
 * The database is the single source of truth, so status survives restarts and
 * is what the status API reads back.
 */
export interface Worker {
  start(): void;
  stop(): Promise<void>;
}

/** A claimed row carries its wallet identity (batches.api_key_hash). */
type ClaimedTx = TransactionRow & { wallet: string };

export function createWorker(db: PGlite): Worker {
  let running = false;
  let inflight = 0;
  let loopPromise: Promise<void> | null = null;
  const apiKeyCache = new Map<string, string>();
  // Wallets with a transaction currently in flight. A wallet in this set is
  // never claimed again until its in-flight transaction settles, which is what
  // keeps same-wallet sends strictly sequential.
  const busyWallets = new Set<string>();

  async function apiKeyForBatch(batchId: string): Promise<string | null> {
    const cached = apiKeyCache.get(batchId);
    if (cached) return cached;
    const r = await db.query<{ api_key: string }>(
      `SELECT api_key FROM batches WHERE id = $1`,
      [batchId]
    );
    const key = r.rows[0]?.api_key ?? null;
    if (key) apiKeyCache.set(batchId, key);
    return key;
  }

  /**
   * Atomically claim the next queued transaction for up to `n` DISTINCT wallets,
   * skipping any wallet that already has one in flight (`exclude`). At most one
   * row per wallet is returned, so same-wallet transactions can never be picked
   * up concurrently. Within a wallet the earliest (created_at, idx) row wins, so
   * they are sent in the order the caller submitted them.
   */
  async function claim(n: number, exclude: string[]): Promise<ClaimedTx[]> {
    if (n <= 0) return [];
    const r = await db.query<ClaimedTx>(
      `WITH next AS (
         SELECT DISTINCT ON (b.api_key_hash) t.id
         FROM transactions t
         JOIN batches b ON b.id = t.batch_id
         WHERE t.status = 'queued'
           AND NOT (b.api_key_hash = ANY($2::text[]))
         ORDER BY b.api_key_hash, t.created_at ASC, t.idx ASC
         LIMIT $1
       )
       UPDATE transactions t
          SET status = 'processing', attempts = t.attempts + 1, claimed_at = now()
         FROM batches b
        WHERE t.id IN (SELECT id FROM next)
          AND b.id = t.batch_id
       RETURNING t.*, b.api_key_hash AS wallet`,
      [n, exclude]
    );
    return r.rows;
  }

  async function finalize(
    id: string,
    fields: {
      status: "success" | "failed" | "queued";
      httpStatus: number | null;
      hash: string | null;
      response: unknown;
      error: string | null;
    }
  ): Promise<void> {
    const finished = fields.status === "queued" ? null : new Date().toISOString();
    await db.query(
      `UPDATE transactions
         SET status = $2, http_status = $3, hash = $4,
             response = $5::jsonb, error = $6, finished_at = $7
       WHERE id = $1`,
      [
        id,
        fields.status,
        fields.httpStatus,
        fields.hash,
        fields.response == null ? null : JSON.stringify(fields.response),
        fields.error,
        finished,
      ]
    );
  }

  async function processItem(tx: TransactionRow): Promise<void> {
    try {
      const apiKey = await apiKeyForBatch(tx.batch_id);
      if (!apiKey) {
        await finalize(tx.id, {
          status: "failed",
          httpStatus: null,
          hash: null,
          response: null,
          error: "API key for batch not found",
        });
        return;
      }

      const result = await callTokopay(tx.endpoint, apiKey, tx.payload);

      if (result.ok) {
        await finalize(tx.id, {
          status: "success",
          httpStatus: result.httpStatus,
          hash: result.hash,
          response: result.body,
          error: null,
        });
        return;
      }

      // Retry only transient failures (network/timeout or 5xx) within budget.
      const transient = result.networkError || result.httpStatus >= 500;
      if (transient && tx.attempts < MAX_ATTEMPTS) {
        await finalize(tx.id, {
          status: "queued", // back to the queue for another attempt
          httpStatus: result.httpStatus || null,
          hash: null,
          response: result.body,
          error: `retry ${tx.attempts}/${MAX_ATTEMPTS}: ${result.error}`,
        });
        return;
      }

      await finalize(tx.id, {
        status: "failed",
        httpStatus: result.httpStatus || null,
        hash: null,
        response: result.body,
        error: result.error,
      });
    } catch (e: unknown) {
      await finalize(tx.id, {
        status: "failed",
        httpStatus: null,
        hash: null,
        response: null,
        error: e instanceof Error ? e.message : String(e),
      }).catch(() => {});
    }
  }

  async function loop(): Promise<void> {
    while (running) {
      const free = WORKER_CONCURRENCY - inflight;
      let claimedCount = 0;
      if (free > 0) {
        const claimed = await claim(free, Array.from(busyWallets));
        claimedCount = claimed.length;
        for (const tx of claimed) {
          inflight++;
          busyWallets.add(tx.wallet);
          void processItem(tx)
            .then(async () => {
              // Optional safety margin so the next send for this wallet sees the
              // freshly-broadcast nonce reflected in the RPC's pending count.
              if (WALLET_SEND_SPACING_MS > 0) await sleep(WALLET_SEND_SPACING_MS);
            })
            .finally(() => {
              inflight--;
              busyWallets.delete(tx.wallet);
            });
        }
      }
      // Sleep briefly while draining; longer when idle.
      const idle = claimedCount === 0 && inflight === 0;
      await sleep(idle ? POLL_INTERVAL_MS : BUSY_INTERVAL_MS);
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      loopPromise = loop();
      // eslint-disable-next-line no-console
      console.log(
        `[worker] started — up to ${WORKER_CONCURRENCY} wallets in parallel, ` +
          `1 tx/wallet at a time (nonce-safe), poll=${POLL_INTERVAL_MS}ms`
      );
    },
    async stop() {
      running = false;
      if (loopPromise) await loopPromise;
      // wait for in-flight requests to settle (best effort)
      const deadline = Date.now() + 10_000;
      while (inflight > 0 && Date.now() < deadline) await sleep(50);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
