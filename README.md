# TOKOPAY Bulk Withdrawal Gateway

A small **Node + TypeScript backend** that sits in front of the TOKOPAY API and
turns its single-transaction endpoints into **bulk, asynchronous** ones.

You send an **array** of transaction payloads + your API key. The service
persists them to a local **embedded PGlite** database, returns a **`batchId`
immediately**, and a built-in **parallel worker** submits each transaction to
TOKOPAY. You then poll the `batchId` to get every transaction's current status,
its hash, and the **full TOKOPAY response**.

No `.env` is required — it talks to the standard `https://www.tokopay.io`
endpoint out of the box.

---

## How it works

```
                 ┌────────────────────── one Node process ──────────────────────┐
 client ──array──▶  Express API  ──writes──▶  PGlite (embedded Postgres on disk) │
        ◀─batchId─                                  ▲            │                │
                                                    │ claim      │ status read    │
 client ──batchId──▶  GET /v1/batches/:id ──────────┘            │                │
        ◀─per-tx status + hash + full response ◀─────────────────┘                │
                                                                                  │
                    in-process Worker ──parallel HTTP──▶  https://www.tokopay.io  │
                 └────────────────────────────────────────────────────────────────┘
```

**Why one process?** PGlite is Postgres compiled to WASM — an *embedded*,
single-writer database. Only one OS process can open its data directory. So the
HTTP API and the worker run in the **same process**; the worker is a separate
module (`src/worker.ts`) that still runs work **in parallel** by keeping up to
`WORKER_CONCURRENCY` TOKOPAY requests in flight at once. The database is the
single source of truth, so status survives restarts.

### Transaction lifecycle

```
queued → processing → success | failed
                    ↘ (network / 5xx, attempts < MAX) → queued (retry)
```

---

## Run locally

Requires Node 20+.

```bash
npm install
npm start          # listens on :8080, creates ./pgdata
# or: npm run dev  # watch mode
```

---

## API

Auth on every request: send your TOKOPAY key as either
`Authorization: Bearer <key>` **or** `X-API-Key: <key>`. The gateway forwards it
to TOKOPAY unchanged.

### Submit a bulk request

Two equivalent ways:

**A. Mirror the TOKOPAY path** (same path, but the body is an array):

```bash
curl -X POST http://localhost:8080/api/v1/wallets/transfer-token \
  -H "Authorization: Bearer ws_live_yourkey" \
  -H "Content-Type: application/json" \
  -d '[
        { "walletId":"ckaaa", "to":"0xA…", "amount":"10", "tokenId":"cktok", "tags":["payroll"] },
        { "walletId":"ckbbb", "to":"0xB…", "amount":"25", "tokenId":"cktok" },
        { "walletId":"ckccc", "to":"0xC…", "amount":"5",  "tokenId":"cktok" }
      ]'
```

**B. Generic endpoint** with `{ endpoint, transactions }`:

```bash
curl -X POST http://localhost:8080/v1/bulk \
  -H "X-API-Key: ws_live_yourkey" \
  -H "Content-Type: application/json" \
  -d '{
        "endpoint": "/api/v1/wallets/send",
        "transactions": [
          { "walletId":"ckaaa", "to":"0xA…", "amount":"0.1" },
          { "walletId":"ckbbb", "to":"0xB…", "amount":"0.2" }
        ]
      }'
```

Response (HTTP 202):

```json
{
  "batchId": "0b3f…-uuid",
  "endpoint": "/api/v1/wallets/transfer-token",
  "accepted": 3,
  "status": "processing",
  "statusUrl": "/v1/batches/0b3f…-uuid"
}
```

The per-transaction payloads are exactly what TOKOPAY expects for that endpoint
(including optional `notes` / `tags`). The gateway doesn't reshape them.

### Check batch status

```bash
curl http://localhost:8080/v1/batches/0b3f…-uuid
```

```json
{
  "batchId": "0b3f…-uuid",
  "endpoint": "/api/v1/wallets/transfer-token",
  "status": "processing",
  "createdAt": "2026-06-15T09:00:00.000Z",
  "counts": { "total": 3, "queued": 1, "processing": 1, "success": 1, "failed": 0 },
  "transactions": [
    {
      "id": "…", "index": 0, "status": "success", "attempts": 1,
      "httpStatus": 200,
      "hash": "0xabc…",
      "error": null,
      "request":  { "walletId": "ckaaa", "to": "0xA…", "amount": "10", "tokenId": "cktok" },
      "response": { "hash": "0xabc…", "...": "full TOKOPAY response" },
      "submittedAt": "…", "finishedAt": "…"
    },
    { "id": "…", "index": 1, "status": "processing", "attempts": 1, "...": "…" },
    { "id": "…", "index": 2, "status": "queued",     "attempts": 0, "...": "…" }
  ]
}
```

`status` becomes `"completed"` once nothing is `queued`/`processing`. Each entry
carries the **intended hash** (when TOKOPAY returned one), the **full TOKOPAY
response body**, the HTTP status, and any error — success or failure.

### Endpoints supported for bulk

All the documented write/contract transaction endpoints:

```
/api/v1/wallets/send                 /api/v1/paymaster/transfer-token
/api/v1/wallets/transfer-token       /api/v1/paymaster/transfer-nft
/api/v1/wallets/transfer-nft         /api/v1/paymaster/contract-call
/api/v1/wallets/contract-call        /api/v1/meta/transfer-token
/api/v1/asset-recovery/send-native   /api/v1/meta/transfer-nft
/api/v1/asset-recovery/transfer-token/api/v1/meta/contract-call
/api/v1/asset-recovery/transfer-nft
```

`GET /api/v1/transactions` is also proxied straight through (single, not
batched) for convenience.

---

## Configuration (all optional)

No environment variables are needed. Override only if you want to:

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `8080` | HTTP port |
| `TOKOPAY_BASE` | `https://www.tokopay.io` | TOKOPAY API base |
| `PGDATA_DIR` | `./pgdata` | Embedded DB directory (mount a volume here) |
| `WORKER_CONCURRENCY` | `8` | Parallel TOKOPAY requests in flight |
| `MAX_ATTEMPTS` | `3` | Retries (network / 5xx only) |
| `REQUEST_TIMEOUT_MS` | `30000` | Per-call timeout |
| `MAX_BATCH_SIZE` | `1000` | Max transactions per bulk request |

---

## Docker

```bash
# build
docker build -t tokopay-bulk-withdrawal:latest .

# run, persisting the embedded DB to a named volume
docker run -d --name bulk \
  -p 8080:8080 \
  -v bulk_pgdata:/app/pgdata \
  tokopay-bulk-withdrawal:latest

# verify
curl http://localhost:8080/health
```

The `-v bulk_pgdata:/app/pgdata` is important: it keeps your batches/keys across
restarts. Without it the DB is ephemeral.

---

## Deploy to a Kubernetes pod

Manifests are in `k8s/` (a PVC, a single-replica Deployment, and a Service).

```bash
# 1. Build and push to a registry your cluster can pull from.
docker build -t YOUR_REGISTRY/tokopay-bulk-withdrawal:1.0.0 .
docker push  YOUR_REGISTRY/tokopay-bulk-withdrawal:1.0.0

# 2. Point the Deployment at your image.
#    Edit k8s/deployment.yaml -> spec.template.spec.containers[0].image

# 3. Apply.
kubectl apply -f k8s/pvc.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml

# 4. Watch it come up.
kubectl get pods -l app=tokopay-bulk-withdrawal -w
kubectl logs -l app=tokopay-bulk-withdrawal -f

# 5. Reach it from your laptop.
kubectl port-forward svc/tokopay-bulk-withdrawal 8080:80
curl http://localhost:8080/health
```

To expose it outside the cluster, change the Service `type` to `LoadBalancer`
(cloud) or `NodePort`, or put an Ingress in front of it.

**Local cluster shortcut (kind/minikube):** load the image without a registry:

```bash
kind load docker-image tokopay-bulk-withdrawal:latest        # kind
# or
minikube image load tokopay-bulk-withdrawal:latest           # minikube
```
# Tokopay-Bulk-Withdrawal-Gateway
