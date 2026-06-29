import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { upsertApiKey } from "./db";
import type { TransactionRow, TxStatus } from "./types";

export interface CreatedBatch {
  batchId: string;
  endpoint: string;
  accepted: number;
}

/**
 * Persist a bulk request: one `batches` row + one `transactions` row per item,
 * all starting as 'queued'. Wrapped in a transaction so a batch is all-or-
 * nothing. Returns immediately with a batchId; the worker does the rest.
 */
export async function createBatch(
  db: PGlite,
  endpoint: string,
  apiKey: string,
  transactions: unknown[]
): Promise<CreatedBatch> {
  const batchId = randomUUID();
  const keyHash = await upsertApiKey(db, apiKey);

  await db.exec("BEGIN");
  try {
    await db.query(
      `INSERT INTO batches (id, endpoint, api_key, api_key_hash, total)
       VALUES ($1, $2, $3, $4, $5)`,
      [batchId, endpoint, apiKey, keyHash, transactions.length]
    );

    // Insert items. Looping with a parameterized statement keeps it simple and
    // safe; PGlite handles a few thousand inserts in a single transaction fast.
    for (let i = 0; i < transactions.length; i++) {
      await db.query(
        `INSERT INTO transactions (id, batch_id, idx, endpoint, payload, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'queued')`,
        [randomUUID(), batchId, i, endpoint, JSON.stringify(transactions[i] ?? {})]
      );
    }

    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK").catch(() => {});
    throw e;
  }

  return { batchId, endpoint, accepted: transactions.length };
}

export interface BatchStatus {
  batchId: string;
  endpoint: string;
  status: "processing" | "completed";
  createdAt: string;
  counts: Record<TxStatus | "total", number>;
  transactions: Array<{
    id: string;
    index: number;
    status: TxStatus;
    attempts: number;
    httpStatus: number | null;
    hash: string | null;
    error: string | null;
    request: unknown;
    response: unknown;
    submittedAt: string | null;
    finishedAt: string | null;
  }>;
}

/** Full status of a batch: per-transaction current state + the TOKOPAY response. */
export async function getBatchStatus(
  db: PGlite,
  batchId: string
): Promise<BatchStatus | null> {
  const b = await db.query<{ id: string; endpoint: string; created_at: string }>(
    `SELECT id, endpoint, created_at FROM batches WHERE id = $1`,
    [batchId]
  );
  const batch = b.rows[0];
  if (!batch) return null;

  const t = await db.query<TransactionRow>(
    `SELECT * FROM transactions WHERE batch_id = $1 ORDER BY idx ASC`,
    [batchId]
  );

  const counts: Record<TxStatus | "total", number> = {
    total: t.rows.length,
    queued: 0,
    processing: 0,
    success: 0,
    failed: 0,
  };
  for (const row of t.rows) counts[row.status]++;

  const settled = counts.queued === 0 && counts.processing === 0;

  return {
    batchId: batch.id,
    endpoint: batch.endpoint,
    status: settled ? "completed" : "processing",
    createdAt: batch.created_at,
    counts,
    transactions: t.rows.map((r) => ({
      id: r.id,
      index: r.idx,
      status: r.status,
      attempts: r.attempts,
      httpStatus: r.http_status,
      hash: r.hash,
      error: r.error,
      request: r.payload,
      response: r.response,
      submittedAt: r.claimed_at,
      finishedAt: r.finished_at,
    })),
  };
}
