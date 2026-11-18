/**
 * A kernel response the port refuses (e.g. a lone surrogate that the native CBOR encoder rejects)
 * must still answer the request — the caller is waiting on its id. The kernel posts an integrity
 * error under the same id instead of leaving the request to the host watchdog, and keeps serving.
 */
import { describe, expect, it } from "vite-plus/test";

import type { ProtocolValue } from "@qntx/wallet/protocol";

import { createHarness } from "./harness.ts";

const isResponse = (message: ProtocolValue) =>
  typeof message === "object" &&
  message !== null &&
  !(message instanceof Uint8Array) &&
  "id" in message &&
  ("ok" in message || "err" in message);

/** A `throwOnPost` predicate that refuses the first response-shaped message only. */
const refuseFirstResponse = () => {
  let armed = true;
  return (message: ProtocolValue) => {
    if (!armed || !isResponse(message)) {
      return false;
    }
    armed = false;
    return true;
  };
};

describe("a port that refuses a response", () => {
  it("answers the same id with an integrity error and keeps serving", async () => {
    const h = createHarness({ noIdle: true, throwOnPost: refuseFirstResponse() });
    const refused = await h.call("status");
    expect(refused).toMatchObject({ err: { code: "integrity" } });

    const next = await h.call("status");
    expect(next).toMatchObject({ ok: expect.anything() as unknown });
  });
});
