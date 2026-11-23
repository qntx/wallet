/**
 * Bare-Hermes entry for the engine's Fiat24 layer: the SDK's flow-state codec for every flow kind,
 * the corroborated `createFiat24Client`, the request-pipeline `createFiat24Signer` and the
 * `fiat24()` definition — none of it needs a kernel. Prints HERMES_FIAT24_OK when every check
 * passes.
 *
 * The minimal globals are installed first and the dependent modules are imported dynamically so
 * shim ordering always precedes first use (the same reason the worker entry defers its smoke
 * module).
 */

declare function print(s: string): void;
declare function quit(code: number): void;

const has = (name: string): boolean => Reflect.get(globalThis, name) !== undefined;
const install = (name: string, value: unknown): void => {
  if (!has(name)) {
    Reflect.set(globalThis, name, value);
  }
};

/* console — Hermes' CLI ships `print`, not the console object some deps warn through. */
install("console", {
  log: print,
  info: print,
  debug: print,
  warn: print,
  error: print,
});

/* crypto.getRandomValues — xorshift, test-grade only; nothing here feeds a real key. */
install("crypto", {});
{
  const cryptoHost: unknown = Reflect.get(globalThis, "crypto");
  if (
    typeof cryptoHost === "object" &&
    cryptoHost !== null &&
    typeof Reflect.get(cryptoHost, "getRandomValues") !== "function"
  ) {
    let state = 0x9e3779b9;
    Reflect.set(cryptoHost, "getRandomValues", (arr: Uint8Array): Uint8Array => {
      for (let i = 0; i < arr.length; i++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        arr[i] = state >>> 0;
      }
      return arr;
    });
  }
}

/* queueMicrotask — viem's promise helpers schedule through it when present. */
install("queueMicrotask", (fn: () => void) => {
  // oxlint-disable-next-line promise/prefer-await-to-then -- a sync shim cannot await.
  void Promise.resolve().then(fn);
});

/* TextEncoder — viem encodes strings for hex data. */
if (!has("TextEncoder")) {
  class HermesTextEncoder {
    readonly encoding = "utf8";
    encode(input = ""): Uint8Array {
      const out: number[] = [];
      for (let i = 0; i < input.length; i++) {
        const cp = input.codePointAt(i) ?? 0;
        if (cp > 0xffff) {
          i += 1;
        }
        if (cp < 0x80) {
          out.push(cp);
        } else if (cp < 0x800) {
          out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        } else if (cp < 0x10000) {
          out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else {
          out.push(
            0xf0 | (cp >> 18),
            0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f),
            0x80 | (cp & 0x3f),
          );
        }
      }
      return Uint8Array.from(out);
    }
    encodeInto(input: string, dest: Uint8Array): { read: number; written: number } {
      const bytes = this.encode(input);
      const written = Math.min(bytes.length, dest.length);
      dest.set(bytes.subarray(0, written));
      return { read: input.length, written };
    }
  }
  install("TextEncoder", HermesTextEncoder);
}

/* TextDecoder — non-fatal UTF-8 (Hermes may already ship one; installed only when missing). */
if (!has("TextDecoder")) {
  class HermesTextDecoder {
    readonly encoding = "utf8";
    decode(input?: ArrayBuffer | Uint8Array): string {
      if (input === undefined) {
        return "";
      }
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
      let out = "";
      let i = 0;
      while (i < bytes.length) {
        const b0 = bytes[i];
        if (b0 === undefined) {
          break;
        }
        if (b0 < 0x80) {
          out += String.fromCodePoint(b0);
          i += 1;
          continue;
        }
        let len: number;
        if (b0 >= 0xc2 && b0 <= 0xdf) {
          len = 2;
        } else if (b0 >= 0xe0 && b0 <= 0xef) {
          len = 3;
        } else if (b0 >= 0xf0 && b0 <= 0xf4) {
          len = 4;
        } else {
          out += "�";
          i += 1;
          continue;
        }
        let cp = b0 & (0x7f >> len);
        let ok = true;
        for (let j = 1; j < len; j++) {
          const bj = bytes[i + j];
          if (bj === undefined || bj < 0x80 || bj > 0xbf) {
            ok = false;
            break;
          }
          cp = (cp << 6) | (bj & 0x3f);
        }
        if (!ok) {
          out += "�";
          i += 1;
          continue;
        }
        out += String.fromCodePoint(cp);
        i += len;
      }
      return out;
    }
  }
  install("TextDecoder", HermesTextDecoder);
}

const OWNER = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as const;
const TOKEN_ID = 469709n;
const HASH = `0x${"ab".repeat(32)}` as const;

const assert = (ok: boolean, what: string): void => {
  if (!ok) {
    throw new Error(`fiat24 hermes check failed: ${what}`);
  }
};

type RpcCall = { readonly method: string; readonly params?: unknown };
type Transport = {
  readonly transport: { readonly request: (call: RpcCall) => Promise<unknown> };
};

const endpoint = (answer: (call: RpcCall) => unknown): Transport => ({
  transport: {
    // oxlint-disable-next-line typescript/require-await -- the transport seam's signature is a promise.
    request: async (call) => answer(call),
  },
});

const agreeing = (result: unknown) => ({
  client: () => endpoint(() => result),
  independentClient: () => ({ kind: "available" as const, client: endpoint(() => result) }),
});

type PrepareInput = {
  readonly method: string;
  readonly request: { readonly kind: string };
  readonly nonce?: number;
};

export async function main(): Promise<void> {
  const {
    decodeFlowState,
    encodeFlowState,
    startCardOperation,
    startExchange,
    startOnboarding,
    startTopUp,
    startTransfer,
  } = await import("@qntx/fiat24/flows");
  const { sessionLabel, sessionMessage } = await import("@qntx/fiat24/api");
  const { arbitrum } = await import("@qntx/fiat24/deployments");
  const { transferCall } = await import("@qntx/fiat24/calls");
  const { fiat24 } = await import("../../src/apps/fiat24/index.ts");
  const { createFiat24Client } = await import("../../src/apps/fiat24/rpc.ts");
  const { createFiat24Signer } = await import("../../src/apps/fiat24/signer.ts");

  /* Flow-state codec: a start state of every flow kind round-trips through the persisted text. */
  const transfer = startTransfer({
    owner: OWNER,
    currency: "EUR24",
    amount: 100n,
    to: { tokenId: 469710n },
  });
  assert(transfer.flow === "transfer" && transfer.step === "draft", "startTransfer");
  const exchange = startExchange({
    owner: OWNER,
    side: "exact-in",
    from: "EUR24",
    to: "CHF24",
    amount: 100n,
  });
  assert(exchange.flow === "exchange", "startExchange");
  const states = [
    transfer,
    exchange,
    {
      flow: "payout",
      version: 1,
      owner: OWNER,
      txs: [],
      step: "verified",
      tokenId: TOKEN_ID,
      currency: "EUR24",
      amount: 100n,
      contactId: "EA-123456",
    },
    startCardOperation({
      owner: OWNER,
      tokenId: TOKEN_ID,
      operation: { kind: "block", externalId: "123456" },
    }),
    startOnboarding({ owner: OWNER, tokenId: TOKEN_ID, payment: "eth" }),
    startTopUp({ owner: OWNER, output: "EUR24", usdcAmount: 1_000_000n }),
  ] as const;
  const kinds = new Set<string>();
  for (const state of states) {
    const text = encodeFlowState(state);
    const decoded = decodeFlowState(text);
    kinds.add(decoded.flow);
    /* The canonical text is stable: decoding and re-encoding loses nothing. */
    assert(encodeFlowState(decoded) === text, `round trip ${decoded.flow}`);
  }
  assert(
    ["transfer", "exchange", "payout", "card", "onboarding", "top-up"].every((k) => kinds.has(k)),
    `every flow kind round-trips (${[...kinds].join(",")})`,
  );

  /* The corroborated client: one pinned eth_call answered identically on both endpoints. */
  const callTo = arbitrum.tokens.EUR24.proxy;
  const callParams: [{ to: `0x${string}`; data: `0x${string}` }, `0x${string}`] = [
    { to: callTo, data: "0x70a08231" },
    "0x1234",
  ];
  const networks = agreeing("0x0000000000000000000000000000000000000000000000000000000000000001");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake networks answer the two transports the client reads.
  const client = createFiat24Client(networks as never);
  const answered = await client.request({
    method: "eth_call",
    params: callParams,
  });
  assert(
    answered === "0x0000000000000000000000000000000000000000000000000000000000000001",
    "corroborated eth_call",
  );

  /* A disagreeing corroborator fails the call closed. */
  let refused = false;
  try {
    const mismatched = createFiat24Client(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same fake-networks seam as above.
      {
        client: () => endpoint(() => "0x01"),
        independentClient: () => ({
          kind: "available" as const,
          client: endpoint(() => "0x02"),
        }),
      } as never,
    );
    await mismatched.request({ method: "eth_call", params: callParams });
  } catch (error) {
    /* viem's transport wraps the plain mismatch error in an RpcError; the text is in details. */
    refused = String(error).includes("the rpc endpoints disagree");
  }
  assert(refused, "mismatch fails closed");

  /* The signer: one evm.transaction at the pinned nonce, one evm.fiat24-session grant. */
  const prepared: Array<{ method: string; kind: string; nonce?: number }> = [];
  const requests = {
    // oxlint-disable-next-line typescript/require-await -- the requests seam's signature is a promise.
    prepare: async (input: PrepareInput): Promise<{ id: string }> => {
      prepared.push({
        method: input.method,
        kind: input.request.kind,
        ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
      });
      return { id: `req-${prepared.length}` };
    },
    // oxlint-disable-next-line typescript/require-await -- the requests seam's signature is a promise.
    outcome: async (id: string): Promise<unknown> =>
      id === "req-1"
        ? { hash: HASH }
        : { kind: "evm.fiat24-session", signature: new Uint8Array(65) },
  };
  const opened: string[] = [];
  const refusals: string[] = [];
  const signer = createFiat24Signer({
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the fake requests answer the prepare/outcome seam the signer reads.
    requests: requests as never,
    group: { walletId: "w1", groupIndex: 0 },
    owner: OWNER,
    tokenId: TOKEN_ID,
    opened: (id) => {
      opened.push(id);
    },
    refused: (reason) => {
      refusals.push(reason);
    },
  });
  const call = transferCall({
    currency: "EUR24",
    to: "0x00000000000000000000000000000000000bb0aa",
    amount: 100n,
    deployment: arbitrum,
  });
  const hash = await signer.sendTransaction({
    chainId: 42161,
    from: OWNER,
    to: call.to,
    data: call.data,
    value: call.value,
    nonce: 5,
    intent: call.intent,
  });
  assert(hash === HASH, "sendTransaction returns the request hash");
  assert(
    prepared[0]?.kind === "evm.transaction" && prepared[0]?.nonce === 5,
    "the transaction request pins the SDK nonce",
  );

  const grantArgs = { chainId: 42161 as const, tokenId: TOKEN_ID, deadline: 2_000_000_000n };
  const signature = await signer.signSessionGrant({
    ...grantArgs,
    hash: sessionLabel(grantArgs),
    message: sessionMessage(grantArgs),
  });
  assert(signature === `0x${"00".repeat(65)}`, "signSessionGrant returns the 65-byte signature");
  assert(prepared[1]?.kind === "evm.fiat24-session", "the grant is a fiat24-session request");
  assert(opened.length === 2 && refusals.length === 0, "opened both requests, refused none");

  /* The definition `createApps` lists. */
  const definition = fiat24({
    // oxlint-disable-next-line typescript/require-await -- the fetch seam's signature is a promise.
    fetch: async () => {
      throw new Error("smoke: no fetch");
    },
  });
  assert(definition.id === "fiat24", "fiat24() id");
  const bare = fiat24();
  assert(
    bare.enableWhen.includes("available") && bare.enableWhen.includes("close-only"),
    "enableWhen available + close-only",
  );

  print("HERMES_FIAT24_OK");
}

// oxlint-disable-next-line unicorn/prefer-top-level-await -- top-level await cannot appear in the iife classic-script bundle Hermes runs
void (async (): Promise<void> => {
  try {
    await main();
  } catch (error) {
    print(
      `HERMES_FIAT24_FAIL: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    quit(1);
  }
})();
