import express, { type Request, type Response, type NextFunction } from "express";
import type { PGlite } from "@electric-sql/pglite";
import { ALLOWED_ENDPOINTS, isAllowedEndpoint, MAX_BATCH_SIZE } from "./config";
import { createBatch, getBatchStatus } from "./batches";
import { getTokopay } from "./tokopay";

/** Extract the TOKOPAY API key from the incoming request (X-API-Key or Bearer). */
function extractApiKey(req: Request): string | null {
  const x = (req.header("x-api-key") || req.header("x-apikey") || "").trim();
  if (x) return x;
  const auth = (req.header("authorization") || "").trim();
  if (!auth) return null;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = (m?.[1] ?? auth).trim();
  return token || null;
}

/** Normalize a request body into an array of transaction payloads. */
function asTxArray(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (Array.isArray(b.transactions)) return b.transactions;
  }
  return null;
}

export function buildServer(db: PGlite) {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, service: "tokopay-bulk-withdrawal" }));

  // Shared handler: validate, persist, return batchId.
  async function handleBulk(endpoint: string, req: Request, res: Response) {
    const apiKey = extractApiKey(req);
    if (!apiKey)
      return res.status(401).json({ error: "Missing API key (X-API-Key or Authorization: Bearer)." });

    if (!isAllowedEndpoint(endpoint))
      return res.status(400).json({ error: `Endpoint not allowed: ${endpoint}`, allowed: ALLOWED_ENDPOINTS });

    const txs = asTxArray(req.body);
    if (!txs)
      return res.status(400).json({
        error: "Body must be a JSON array of transactions, or { transactions: [...] }.",
      });
    if (txs.length === 0)
      return res.status(400).json({ error: "No transactions provided." });
    if (txs.length > MAX_BATCH_SIZE)
      return res.status(413).json({ error: `Too many transactions (max ${MAX_BATCH_SIZE}).` });
    for (let i = 0; i < txs.length; i++) {
      if (txs[i] === null || typeof txs[i] !== "object" || Array.isArray(txs[i]))
        return res.status(400).json({ error: `Transaction at index ${i} must be a JSON object.` });
    }

    const created = await createBatch(db, endpoint, apiKey, txs);
    return res.status(202).json({
      batchId: created.batchId,
      endpoint: created.endpoint,
      accepted: created.accepted,
      status: "processing",
      statusUrl: `/v1/batches/${created.batchId}`,
    });
  }

  // 1) Mirror every TOKOPAY transaction path. Same path on THIS service, but it
  //    accepts an ARRAY of payloads and returns a batchId.
  for (const endpoint of ALLOWED_ENDPOINTS) {
    app.post(endpoint, (req, res, next) => handleBulk(endpoint, req, res).catch(next));
  }

  // 2) Generic bulk endpoint: { endpoint, transactions: [...] }.
  app.post("/v1/bulk", (req, res, next) => {
    const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
    handleBulk(endpoint, req, res).catch(next);
  });

  // 3) Batch status — all entries with current status, hash, and full response.
  app.get("/v1/batches/:batchId", (req, res, next) => {
    getBatchStatus(db, req.params.batchId)
      .then((status) => {
        if (!status) return res.status(404).json({ error: "Batch not found." });
        res.json(status);
      })
      .catch(next);
  });

  // 4) Convenience read passthrough for the documented GET endpoint.
  app.get("/api/v1/transactions", (req, res, next) => {
    const apiKey = extractApiKey(req);
    if (!apiKey) return res.status(401).json({ error: "Missing API key." });
    const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
    getTokopay(`/api/v1/transactions${qs}`, apiKey)
      .then((r) => res.status(r.httpStatus || 502).json(r.body ?? { error: r.error }))
      .catch(next);
  });

  // error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error("[server] error:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "internal error" });
  });

  return app;
}
