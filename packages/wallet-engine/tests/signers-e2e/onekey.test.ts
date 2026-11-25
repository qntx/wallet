/**
 * Engine e2e sends through a OneKey, replayed from the emulator recordings in
 * vectors/onekey/engine-<model>.json (ONEKEY_TRANSCRIPTS overrides the directory, like the kernel
 * suites). The replay DeviceIo consumes the recorded exchanges session by session and throws on the
 * first request byte that differs from the transcript — the engine-built requests are deterministic
 * under the harness's fixed clock, fill-7 platform random and stub upstreams, so any drift is a
 * real regression. Every caught broadcast is verified with the independent libraries, and
 * engine.signers activity runs starting -> device -> cleared.
 */
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vite-plus/test";

import { WalletError } from "@qntx/wallet";
import { chains } from "@qntx/wallet/chains";
import { hardware } from "@qntx/wallet/hardware";
import type { DeviceIo } from "@qntx/wallet/hardware";

import {
  loadTranscript,
  transcriptSession,
} from "../../../wallet-kernel/tests/onekey-emulator/index.ts";
import type { Transcript } from "../../../wallet-kernel/tests/onekey-emulator/index.ts";
import { freshNodeWallet, VERIFY } from "../apps-helpers.ts";
import {
  BTC_NETWORK,
  BTC_TO,
  btcAddressFromXpub,
  caughtOne,
  dappRefusal,
  e2eWorld,
  EVM_NETWORK,
  EVM_TO,
  matrix,
  matrixAccount,
  qrRefusal,
  sendOnce,
  SITE,
  SOL_NETWORK,
  SOL_TO,
  TRON_NETWORK,
  TRON_TO,
  verifyBtc,
  verifyEvm,
  verifySol,
  verifyTron,
  watchSignerActivity,
} from "./harness.ts";
import type { E2eWorld, MatrixFamily, MatrixHooks } from "./harness.ts";

type SessionName =
  | "engine-pair"
  | `engine-send-${MatrixFamily}`
  | `engine-dapp-${MatrixFamily}`
  | `engine-qr-${MatrixFamily}`;

/**
 * A DeviceIo that replays one named session at a time: `phase` switches the active session, every
 * exchange must match the next recorded request byte-for-byte or the call throws — never loosened.
 */
const replayIo = (
  transcript: Transcript,
): {
  readonly io: DeviceIo;
  readonly phase: (name: SessionName) => void;
  readonly done: () => void;
} => {
  let session = transcriptSession(transcript, "engine-pair");
  let at = 0;
  const consumed = (): void => {
    if (at !== session.exchanges.length) {
      throw new Error(
        `session ${session.name} has ${session.exchanges.length - at} unconsumed exchanges`,
      );
    }
  };
  return {
    phase: (name) => {
      consumed();
      session = transcriptSession(transcript, name);
      at = 0;
    },
    done: consumed,
    io: {
      exchange: async (request) => {
        if (request.kind !== "message") {
          throw new Error(`the onekey driver sent a non-message request (${request.kind})`);
        }
        const step = session.exchanges[at];
        at += 1;
        if (step === undefined) {
          throw new Error(`replay ran past session ${session.name}`);
        }
        const sent = bytesToHex(request.data);
        if (sent !== step.request) {
          throw new Error(
            `replay request ${at} in ${session.name} diverged:\nsent     ${sent}\nrecorded ${step.request}`,
          );
        }
        await Promise.resolve();
        return { kind: "message", data: hexToBytes(step.response) };
      },
    },
  };
};

const pairOneKey = async (w: E2eWorld["w"], io: DeviceIo): Promise<string> => {
  const result = await hardware(w.wallet).start(
    { kind: "pair", device: "onekey" },
    { io, verify: VERIFY },
  ).result;
  if (result.kind !== "pair" || result.wallet.custody !== "hardware") {
    throw new WalletError("integrity", "pair did not return a hardware wallet");
  }
  return result.wallet.walletId;
};

type FamilyTemplate = "evm.bip44" | "btc.bip84" | "solana.bip44-change" | "tron.bip44";

const address = async (
  w: E2eWorld["w"],
  hwId: string,
  template: FamilyTemplate,
  network: string,
): Promise<string> => {
  const account = await chains(w.wallet).account({
    walletId: hwId,
    groupIndex: 0,
    template,
    network,
  });
  if ("address" in account) {
    return account.address;
  }
  /* BTC answers the account-level xpub; the funded address is receive index 0. */
  return btcAddressFromXpub(account.xpub);
};

const accountRef = (hwId: string, template: FamilyTemplate) =>
  ({ kind: "hd", walletId: hwId, groupIndex: 0, template }) as const;

describe("onekey engine sends (emulator replay)", () => {
  it.each(["classic1s", "pro"] as const)(
    "%s: signs and broadcasts a native transfer per family, verified byte-exact",
    async (model) => {
      const transcript = loadTranscript(model, "engine");
      const replay = replayIo(transcript);
      /* A fresh wallet per model: pair asserts already-exists on a shared vault and would leave
         the recorded pair exchanges unconsumed. */
      const wallet = await freshNodeWallet();
      const { w, caught, fund } = await e2eWorld({ deviceIo: () => replay.io, wallet });
      const hwId = await pairOneKey(w, replay.io);

      const evmFrom = await address(w, hwId, "evm.bip44", EVM_NETWORK);
      const btcFrom = await address(w, hwId, "btc.bip84", BTC_NETWORK);
      const solFrom = await address(w, hwId, "solana.bip44-change", SOL_NETWORK);
      const tronFrom = await address(w, hwId, "tron.bip44", TRON_NETWORK);
      const funded = fund(btcFrom, 100_000);

      const activity = watchSignerActivity(w);

      replay.phase("engine-send-evm");
      const evmTx = await sendOnce(w, {
        account: accountRef(hwId, "evm.bip44"),
        network: EVM_NETWORK,
        to: EVM_TO,
        amount: 1_000_000_000_000_000n,
        fee: "normal",
      });
      expect(evmTx.state).not.toBe("failed");
      await verifyEvm(caughtOne(caught, "evm"), {
        from: evmFrom,
        to: EVM_TO,
        amount: 1_000_000_000_000_000n,
      });

      replay.phase("engine-send-bitcoin");
      const btcTx = await sendOnce(w, {
        account: accountRef(hwId, "btc.bip84"),
        network: BTC_NETWORK,
        to: BTC_TO,
        amount: 20_000n,
        fee: "normal",
      });
      expect(btcTx.state).not.toBe("failed");
      verifyBtc(caughtOne(caught, "bitcoin"), {
        fromAddress: btcFrom,
        to: BTC_TO,
        amount: 20_000n,
        inputSats: BigInt(funded.value),
      });

      replay.phase("engine-send-solana");
      const solTx = await sendOnce(w, {
        account: accountRef(hwId, "solana.bip44-change"),
        network: SOL_NETWORK,
        to: SOL_TO,
        amount: 1_000_000n,
        fee: "normal",
      });
      expect(solTx.state).not.toBe("failed");
      verifySol(caughtOne(caught, "solana"), { from: solFrom, to: SOL_TO, amount: 1_000_000n });

      replay.phase("engine-send-tron");
      const tronTx = await sendOnce(w, {
        account: accountRef(hwId, "tron.bip44"),
        network: TRON_NETWORK,
        to: TRON_TO,
        amount: 5_000_000n,
        fee: "normal",
      });
      expect(tronTx.state).not.toBe("failed");
      verifyTron(caughtOne(caught, "tron"), {
        from: tronFrom,
        to: TRON_TO,
        amount: 5_000_000n,
      });

      replay.done();
      activity.stop();
      expect(activity.steps).toContain("starting");
      expect(activity.steps).toContain("device");
      expect(activity.steps.at(-1)).toBe("cleared");

      await w.destroy();
    },
  );
});

/* The recorded session a matrix cell replays — the send cells keep their original names. */
const cellSession = (origin: "internal" | "dapp" | "qr", family: MatrixFamily): SessionName =>
  `engine-${origin === "internal" ? "send" : origin}-${family}`;

describe("onekey origins (emulator replay)", () => {
  let replay: ReturnType<typeof replayIo>;

  const replayModel = (model: "classic1s" | "pro"): void => {
    matrix(
      `onekey-${model}`,
      VERIFY,
      async () => {
        const transcript = loadTranscript(model, "engine");
        replay = replayIo(transcript);
        const wallet = await freshNodeWallet();
        const e2e = await e2eWorld({ deviceIo: () => replay.io, wallet });
        const hwId = await pairOneKey(e2e.w, replay.io);
        const account = await matrixAccount(e2e.w, hwId);
        return { e2e, account };
      },
      {
        beforeCell: (origin, family) => {
          replay.phase(cellSession(origin, family));
        },
      } satisfies MatrixHooks,
    );
  };
  for (const model of ["classic1s", "pro"] as const) {
    replayModel(model);
  }

  /* `phase` verifies a session was fully consumed only when the next one starts — the last
     matrix cell's session is checked here. */
  it("the last recorded session was consumed", () => {
    expect(() => replay.done()).not.toThrow();
  });

  describe("onekey typed refusals", () => {
    /* The family display refuses tron.typed-data outright and eip2930 has no OneKey message —
       the refusal must reach the caller before any exchange touches the device, whichever
       origin asked. No recording needed: zero exchanges means there is nothing to replay. */
    it.each(["classic1s", "pro"] as const)(
      "%s: an unsignable request kind is refused on the dApp and QR origins with zero exchanges",
      async (model) => {
        const transcript = loadTranscript(model, "engine");
        const replay = replayIo(transcript);
        let exchanges = 0;
        const wallet = await freshNodeWallet();
        const e2e = await e2eWorld({
          deviceIo: () => ({
            exchange: async (request, context) => {
              exchanges += 1;
              return replay.io.exchange(request, context);
            },
          }),
          wallet,
        });
        const hwId = await pairOneKey(e2e.w, replay.io);
        const account = await matrixAccount(e2e.w, hwId);

        const dapp = await dappRefusal(e2e, account, "tron", VERIFY, async () =>
          e2e.dapp.tronWallet.handle(SITE, {
            method: "tron_signTypedData",
            params: {
              domain: { name: "D" },
              types: { Mail: [{ name: "text", type: "string" }] },
              message: { text: "hello" },
            },
          }),
        );
        expect(dapp.approve).toBeInstanceOf(WalletError);
        expect((dapp.approve as WalletError).code).toBe("unsupported");
        expect(dapp.call).toBeInstanceOf(Error);
        expect((dapp.call as Error).message).toContain("unsupported");

        /* The QR request keeps the wire's transaction type — eip2930 has no OneKey message. */
        const qr = await qrRefusal(
          e2e,
          account,
          "evm",
          {
            family: "evm",
            kind: "transaction",
            tx: {
              type: "eip2930",
              chainId: 42161,
              nonce: 0,
              gas: "0x5208",
              to: EVM_TO,
              value: "0x1",
              data: "0x",
              accessList: [],
              gasPrice: "0x64",
            },
          },
          VERIFY,
        );
        expect(qr.approve).toBeInstanceOf(WalletError);
        expect((qr.approve as WalletError).code).toBe("unsupported");
        expect(qr.call).toBeInstanceOf(Error);
        expect((qr.call as Error).message).toContain("unsupported");

        expect(exchanges).toBe(0);
        await e2e.w.destroy();
      },
    );
  });
});
