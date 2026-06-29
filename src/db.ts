import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import { PGDATA_DIR } from "./config";

/**
 * Embedded PGlite database. PGlite is a single-process Postgres compiled to
 * WASM — only ONE process may open `PGDATA_DIR`. That is why the HTTP server
 * and the worker run inside the SAME process (see README → Architecture).
 */
let _db: PGlite | null = null;

export async function getDb(): Promise<PGlite> {
  if (_db) return _db;
  const db = new PGlite(PGDATA_DIR);
  await db.waitReady;
  await migrate(db);
  _db = db;
  return db;
}

async function migrate(db: PGlite): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      key_hash    TEXT PRIMARY KEY,
      masked      TEXT NOT NULL,
      api_key     TEXT NOT NULL,
      first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
      batch_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS batches (
      id           TEXT PRIMARY KEY,
      endpoint     TEXT NOT NULL,
      api_key      TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      total        INTEGER NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id          TEXT PRIMARY KEY,
      batch_id    TEXT NOT NULL REFERENCES batches(id),
      idx         INTEGER NOT NULL,
      endpoint    TEXT NOT NULL,
      payload     JSONB NOT NULL,
      status      TEXT NOT NULL DEFAULT 'queued',
      attempts    INTEGER NOT NULL DEFAULT 0,
      http_status INTEGER,
      hash        TEXT,
      response    JSONB,
      error       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at  TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_tx_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_tx_batch  ON transactions(batch_id);

    -- Safety net: if the process died mid-flight, un-stick anything left in
    -- 'processing' on boot so the worker can pick it up again.
    UPDATE transactions SET status = 'queued', claimed_at = NULL
    WHERE status = 'processing';
  `);
}

/** sha256 of the API key — used as a stable identity without comparing raw keys. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Mask a key for logs / responses: keep a short prefix + suffix only. */
export function maskKey(key: string): string {
  if (key.length <= 12) return "****";
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/**
 * Record / refresh the API key in local storage (requirement: "save the apikey
 * in the local db too"). The raw key is stored because it must be replayed to
 * TOKOPAY by the worker; see README → Security for the trade-off.
 */
export async function upsertApiKey(db: PGlite, apiKey: string): Promise<string> {
  const keyHash = hashKey(apiKey);
  await db.query(
    `INSERT INTO api_keys (key_hash, masked, api_key, batch_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (key_hash)
     DO UPDATE SET last_seen = now(), batch_count = api_keys.batch_count + 1,
                   api_key = EXCLUDED.api_key, masked = EXCLUDED.masked`,
    [keyHash, maskKey(apiKey), apiKey]
  );
  return keyHash;
}
