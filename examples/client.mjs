// Minimal end-to-end example: submit a bulk batch, then poll until complete.
// Usage:  node examples/client.mjs ws_live_yourkey
// (run the gateway first: `npm start`)

const BASE = process.env.GATEWAY ?? "http://localhost:8080";
const API_KEY = process.argv[2] ?? "ws_live_REPLACE_ME";
const ENDPOINT = "/api/v1/wallets/transfer-token";

// Replace with real payloads for your endpoint.
const transactions = [
  { walletId: "ckaaa", to: "0xAAAA000000000000000000000000000000000000", amount: "10", tokenId: "cktok", tags: ["payroll"] },
  { walletId: "ckbbb", to: "0xBBBB000000000000000000000000000000000000", amount: "25", tokenId: "cktok" },
  { walletId: "ckccc", to: "0xCCCC000000000000000000000000000000000000", amount: "5", tokenId: "cktok" },
];

async function main() {
  // 1. Submit — same path as TOKOPAY, but an ARRAY body.
  const submit = await fetch(`${BASE}${ENDPOINT}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(transactions),
  });
  const { batchId, statusUrl } = await submit.json();
  console.log("submitted batch:", batchId);

  // 2. Poll until completed.
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const s = await fetch(`${BASE}${statusUrl}`).then((r) => r.json());
    console.log(`status=${s.status}`, s.counts);
    if (s.status === "completed") {
      for (const tx of s.transactions) {
        console.log(`  #${tx.index} ${tx.status} hash=${tx.hash ?? "—"} ${tx.error ?? ""}`);
      }
      break;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
