// oxlint-disable eslint/no-await-in-loop, vitest/no-conditional-in-test -- the step driver is sequential and conditional by design
/**
 * Review PoC R16-01 (kernel half): importing a software wallet onto a card keeps its walletId — the
 * same master key, the same Bitcoin addresses — but stages the source's `walletDeleteOps`, which
 * drop its change-marks record. The card wallet starts at mark 0 while the engine store still
 * tracks every change output the software wallet ever placed above it: with twenty of them inside
 * (0, 20] the engine's `changeAddressOf` refuses every send (see the engine PoC
 * r16-01-window-exhaustion). Asserts today's behaviour: the mark is gone after the import.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import type { WalletInfo } from "@qntx/wallet/types";

import { shortId } from "../../src/modules/card/protocol/identity.ts";
import { CHANGE_MARKS_KIND, encodeChangeMarksHeader } from "../../src/modules/chains/marks.ts";
import { wipe } from "../../src/secret/secret.ts";
import { passkeyKek, unwrapDek } from "../../src/vault/factors.ts";
import { withManifest } from "../../src/vault/manifest.ts";
import { sealRecord } from "../../src/vault/vault.ts";
import { createFakeCard } from "../card/fake-card.ts";
import { testSecureInput } from "../card/input.ts";
import { testCardReader } from "../card/reader.ts";
import { CA1_ANCHOR } from "../card/sim.ts";
import type { KernelResponse } from "../harness.ts";
import { createHarness } from "../harness.ts";

const CREDENTIAL_ID = utf8ToBytes("credential-1");
const BTC = "bip122:000000000019d6689c085ae165831e93";
const code = (): Uint8Array => utf8ToBytes("correct horse");
const verifyPasskey = () => ({
  kind: "passkey" as const,
  credentialId: CREDENTIAL_ID,
  prf: new Uint8Array(32).fill(1),
});
const ok = (res: KernelResponse): unknown => {
  if (!("ok" in res)) {
    throw new Error(`call failed: ${JSON.stringify(res.err)}`);
  }
  return res.ok;
};
const field = (value: unknown, key: string): unknown => (value as Record<string, unknown>)[key];

describe("R16-01 card import drops the source wallet's change mark", () => {
  it("a software wallet at mark 30 becomes a card wallet at mark 0 under the same walletId", async () => {
    const reader = testCardReader();
    const input = testSecureInput();
    const h = createHarness({
      card: { reader: reader.reader, anchors: [CA1_ANCHOR] },
      secureInput: input.secureInput,
    });
    const session = String(
      field(
        ok(
          await h.call("wallet.createWithPasskey", {
            ceremony: "host",
            credentialId: CREDENTIAL_ID,
            prfWallet: new Uint8Array(32).fill(2),
            synced: true,
            factor: verifyPasskey(),
          }),
        ),
        "session",
      ),
    );
    const status = ok(await h.call("status", null, session)) as { wallets: WalletInfo[] };
    const source = status.wallets.find((w) => w.custody === "vault")?.walletId ?? "";

    // The software wallet's sealed mark after thirty internal sends.
    const image = await h.store.load();
    const factor = image.factors.find((f) => f.kind === "passkey");
    const kek = passkeyKek(new Uint8Array(32).fill(1), CREDENTIAL_ID);
    const dek = unwrapDek(kek, factor!);
    wipe(kek);
    const sealer = { random: (n: number) => new Uint8Array(n).fill(3), now: () => 0 } as never;
    const record = sealRecord(
      sealer,
      dek,
      CHANGE_MARKS_KIND,
      source,
      encodeChangeMarksHeader({
        walletId: source,
        marks: [{ groupIndex: 0, purpose: 84, network: BTC, index: 30 }],
      }),
      new Uint8Array([1]),
    );
    await h.store.commit(withManifest(sealer, image, [{ op: "put-record", record }], dek));
    dek.wipe();
    await h.settle();

    const mark = async (): Promise<unknown> =>
      field(
        ok(
          await h.call(
            "wallet.accounts",
            { walletId: source, groupIndex: 0, template: "btc.bip84", network: BTC },
            session,
          ),
        ),
        "changeMark",
      );
    await expect(mark()).resolves.toBe(30);

    // Import it onto a blank card.
    const card = createFakeCard();
    const cards = Array.from({ length: 10 }, () => card);
    const codes = [code(), code()];
    const first = ok(
      await h.call(
        "card.begin",
        {
          op: { kind: "create", cards: 1, source: { kind: "wallet", walletId: source } },
          verify: verifyPasskey(),
        },
        session,
      ),
    ) as { opId: string; step: { kind: string; [k: string]: unknown } };
    let { step } = first;
    for (let guard = 0; step.kind !== "done"; guard += 1) {
      if (guard > 60) {
        throw new Error(`operation did not finish: ${JSON.stringify(step)}`);
      }
      if (step.kind === "input" && step["purpose"] === "short-id") {
        input.push(utf8ToBytes(shortId(card.identity)));
      } else if (step.kind === "input") {
        input.push(codes.shift()!);
      } else if (step.kind === "tap") {
        reader.present(cards.shift()!);
      }
      step = ok(await h.call("card.step", { opId: first.opId }, session)) as typeof step;
    }
    const result = field(step, "result");
    // Same walletId (same master key, same addresses) — now card custody.
    expect(field(result, "walletId")).toBe(source);
    const after = ok(await h.call("status", null, session)) as { wallets: WalletInfo[] };
    expect(after.wallets.find((w) => w.walletId === source)?.custody).toBe("card");
    // The sealed mark is gone with the source's module records.
    await expect(mark()).resolves.toBe(0);
    const { records } = await h.store.load();
    expect(records.some((r) => r.kind === CHANGE_MARKS_KIND && r.id === source)).toBe(false);
  }, 120_000);
});
