import type { PGlite } from "@electric-sql/pglite";
import {
  WORKER_CONCURRENCY,
  POLL_INTERVAL_MS,
  BUSY_INTERVAL_MS,
  MAX_ATTEMPTS,
} from "./config";
import { callTokopay } from "./tokopay";
import type { TransactionRow } from "./types";

/**
 * The bulk worker. Runs in the same process as the HTTP server (PGlite is
 * single-process), but executes TOKOPAY calls in PARALLEL: it keeps up to
 * WORKER_CONCURRENCY requests in flight at any moment.
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

export function createWorker(db: PGlite): Worker {
  let running = false;
  let inflight = 0;
  let loopPromise: Promise<void> | null = null;
  const apiKeyCache = new Map<string, string>();

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

  /** Atomically move up to `n` queued rows into 'processing' and return them. */
  async function claim(n: number): Promise<TransactionRow[]> {
    if (n <= 0) return [];
    const r = await db.query<TransactionRow>(
      `UPDATE transactions
         SET status = 'processing', attempts = attempts + 1, claimed_at = now()
       WHERE id IN (
         SELECT id FROM transactions
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT $1
       )
       RETURNING *`,
      [n]
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
        const claimed = await claim(free);
        claimedCount = claimed.length;
        for (const tx of claimed) {
          inflight++;
          void processItem(tx).finally(() => {
            inflight--;
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
        `[worker] started — concurrency=${WORKER_CONCURRENCY}, poll=${POLL_INTERVAL_MS}ms`
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
