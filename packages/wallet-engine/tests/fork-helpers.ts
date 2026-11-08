/**
 * Mainnet-fork helpers — outside `*.test.ts` so the test linter's no-conditional rule doesn't
 * apply.
 */
export const sleep = async (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export const rpc = async (url: string, method: string, params: unknown[]): Promise<unknown> => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body: unknown = JSON.parse(await res.text());
  if (typeof body !== "object" || body === null) {
    throw new Error(`bad ${method} response`);
  }
  if ("error" in body && body.error !== undefined) {
    const message =
      typeof body.error === "object" && body.error !== null && "message" in body.error
        ? String(body.error.message)
        : method;
    throw new Error(message);
  }
  return "result" in body ? body.result : undefined;
};

export const waitReceipt = async (url: string, hash: string, deadline: number): Promise<string> => {
  const receipt = await rpc(url, "eth_getTransactionReceipt", [hash]);
  if (
    typeof receipt === "object" &&
    receipt !== null &&
    "status" in receipt &&
    receipt.status === "0x1"
  ) {
    return "confirmed";
  }
  if (Date.now() > deadline) {
    throw new Error(`${hash} never confirmed`);
  }
  await sleep(1500);
  return waitReceipt(url, hash, deadline);
};
