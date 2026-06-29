import { TOKOPAY_BASE, REQUEST_TIMEOUT_MS } from "./config";

export interface TokopayCallResult {
  ok: boolean;
  httpStatus: number; // 0 on a network/timeout error
  body: unknown; // full parsed response (or { raw } if not JSON)
  hash: string | null; // best-effort tx hash extracted from the response
  error: string | null;
  networkError: boolean; // true => transient, eligible for retry
}

/** Pull a transaction hash out of whatever shape TOKOPAY returned. */
function extractHash(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const candidates = [
    b.hash,
    b.txHash,
    b.transactionHash,
    b.executionHash,
    b.executeHash,
    b.forwardHash,
  ];
  for (const c of candidates) if (typeof c === "string" && c) return c;
  // common nested holders
  for (const key of ["result", "data", "transaction", "tx"]) {
    const nested = b[key];
    if (nested && typeof nested === "object") {
      const h = extractHash(nested);
      if (h) return h;
    }
  }
  return null;
}

function extractError(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const msg = b.error ?? b.message ?? b.detail;
    if (typeof msg === "string" && msg) return msg;
  }
  return `TOKOPAY responded ${status}`;
}

/**
 * POST a single transaction payload to a TOKOPAY endpoint, forwarding the
 * caller's API key. Never throws — network/timeout errors are returned as a
 * result with `networkError: true` so the worker can decide whether to retry.
 */
export async function callTokopay(
  endpoint: string,
  apiKey: string,
  payload: unknown
): Promise<TokopayCallResult> {
  const url = `${TOKOPAY_BASE}${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // TOKOPAY accepts either header; send both for maximum compatibility.
        authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
      },
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    return {
      ok: res.ok,
      httpStatus: res.status,
      body,
      hash: res.ok ? extractHash(body) : null,
      error: res.ok ? null : extractError(body, res.status),
      networkError: false,
    };
  } catch (e: unknown) {
    const aborted = e instanceof Error && e.name === "AbortError";
    return {
      ok: false,
      httpStatus: 0,
      body: null,
      hash: null,
      error: aborted ? `timeout after ${REQUEST_TIMEOUT_MS}ms` : e instanceof Error ? e.message : String(e),
      networkError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Simple pass-through GET (used for the read endpoint, e.g. /api/v1/transactions). */
export async function getTokopay(
  pathWithQuery: string,
  apiKey: string
): Promise<TokopayCallResult> {
  const url = `${TOKOPAY_BASE}${pathWithQuery}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, "x-api-key": apiKey },
      signal: controller.signal,
    });
    const text = await res.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    return {
      ok: res.ok,
      httpStatus: res.status,
      body,
      hash: null,
      error: res.ok ? null : extractError(body, res.status),
      networkError: false,
    };
  } catch (e: unknown) {
    return {
      ok: false,
      httpStatus: 0,
      body: null,
      hash: null,
      error: e instanceof Error ? e.message : String(e),
      networkError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}
