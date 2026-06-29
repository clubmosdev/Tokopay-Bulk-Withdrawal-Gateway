export type TxStatus = "queued" | "processing" | "success" | "failed";

export interface BatchRow {
  id: string;
  endpoint: string;
  api_key: string;
  api_key_hash: string;
  total: number;
  created_at: string;
}

export interface TransactionRow {
  id: string;
  batch_id: string;
  idx: number;
  endpoint: string;
  payload: unknown;
  status: TxStatus;
  attempts: number;
  http_status: number | null;
  hash: string | null;
  response: unknown;
  error: string | null;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
}
