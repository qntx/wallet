import { CryptoAccount, CryptoHDKey, CryptoMultiAccounts } from "@keystonehq/bc-ur-registry";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
/**
 * QR vectors: `vectors/qr/requests.json` (vendor-encoder-produced payloads) drives `readQrRequest`
 * and `inspectQrRequest` against independently computed expected fields and digests, and
 * `vectors/qr/exports.json` drives `qrExport` into the vendor registry readers a watch-only wallet
 * ships. The inspect digests are also cross-checked against `planEvm`'s task digests for every EVM
 * case in `vectors/chains/signing-classes.json`.
 */
import { describe, expect, it } from "vite-plus/test";

import type { EvmTransaction, TaskKey } from "@qntx/wallet-chains";
import { evmSigningPreimage, planEvm } from "@qntx/wallet-chains/evm";
import { qrParts } from "@qntx/wallet/hardware";
import type { QrPayload } from "@qntx/wallet/hardware";
import type { ChainExportResult } from "@qntx/wallet/protocol";

import classes from "../../../vectors/chains/signing-classes.json" with { type: "json" };
import exportVectors from "../../../vectors/qr/exports.json" with { type: "json" };
import hostileVectors from "../../../vectors/qr/hostile.json" with { type: "json" };
import requestVectors from "../../../vectors/qr/requests.json" with { type: "json" };
import {
  QrError,
  createQrScanner,
  inspectQrRequest,
  qrExport,
  readQrRequest,
} from "../src/qr/index.ts";
import type { QrRequest } from "../src/qr/index.ts";

const payload = (row: { type: string; cbor: string }): QrPayload => ({
  type: row.type,
  cbor: hexToBytes(row.cbor),
});

type TxExpect = {
  type?: string;
  chainId?: number;
  nonce?: string;
  gas?: string;
  value?: string;
  data?: string;
  to?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  accessList?: unknown;
};

type Expect = {
  family?: string;
  kind?: string;
  steps?: number[];
  xfp?: string;
  requestId?: string;
  chainId?: number;
  address?: string;
  data?: string;
  message?: string;
  typedData?: string;
  urType?: string;
  psbt?: string;
  tx?: TxExpect;
};

type ExportExpect = {
  discloses?: string;
  note?: string;
  name?: string;
  depth?: number;
  children?: string;
  descriptor?: string;
  device?: string;
  keyCount?: number;
};

const checkRequest = (request: QrRequest, want: Expect): void => {
  if (want.family !== undefined) {
    expect(request.family).toBe(want.family);
  }
  if ("kind" in request && want.kind !== undefined) {
    expect(request.kind).toBe(want.kind);
  }
  if (request.family !== "bitcoin") {
    if (want.steps !== undefined) {
      expect([...request.path]).toStrictEqual(want.steps);
    }
    expect(request.xfp).toBe(Number.parseInt(want.xfp ?? "0", 16));
    if (want.requestId !== undefined) {
      expect(request.requestId === undefined ? "" : bytesToHex(request.requestId)).toBe(
        want.requestId,
      );
    }
    if ("chainId" in request && want.chainId !== undefined) {
      expect(request.chainId).toBe(want.chainId);
    }
    if ("address" in request && want.address !== undefined) {
      expect(request.address).toBe(want.address);
    }
  }
  if ("data" in request && want.data !== undefined) {
    expect(bytesToHex(request.data)).toBe(want.data);
  }
  if (request.family === "evm" && request.kind === "personal-message" && want.message) {
    expect(bytesToHex(request.message)).toBe(want.message);
  }
  if (request.family === "evm" && request.kind === "typed-data" && want.typedData) {
    expect(request.typedData).toBe(want.typedData);
  }
  if (request.family === "evm" && request.kind === "transaction" && want.tx !== undefined) {
    const { tx } = request;
    const expected = want.tx;
    expect(tx.type).toBe(expected.type);
    expect(tx.chainId).toBe(expected.chainId);
    expect(tx.nonce).toBe(expected.nonce);
    expect(tx.gas).toBe(expected.gas);
    expect(tx.value).toBe(expected.value);
    expect(tx.data).toBe(expected.data);
    expect(tx.to).toBe(expected.to);
    if (tx.type === "legacy" || tx.type === "eip2930") {
      expect(tx.gasPrice).toBe(expected.gasPrice);
    }
    if (tx.type === "eip1559") {
      expect(tx.maxFeePerGas).toBe(expected.maxFeePerGas);
      expect(tx.maxPriorityFeePerGas).toBe(expected.maxPriorityFeePerGas);
    }
    if (tx.type === "eip2930" || tx.type === "eip1559") {
      expect(tx.accessList).toStrictEqual(expected.accessList);
    }
    // The decoded transaction re-serialises to the scanned bytes.
    expect(bytesToHex(evmSigningPreimage(tx))).toBe(want.data);
  }
  if (request.family === "bitcoin") {
    expect(request.urType).toBe(want.urType);
    if (want.psbt !== undefined) {
      expect(bytesToHex(request.psbt)).toBe(want.psbt);
    }
  }
};

const checkDigests = (
  inspection: ReturnType<typeof inspectQrRequest>,
  digests: ReadonlyArray<{ kind: string; value: string }>,
): void => {
  for (const wantDigest of digests) {
    const got = inspection.digests.find((digest) => digest.kind === wantDigest.kind);
    expect(got?.value).toBe(wantDigest.value);
  }
  expect(inspection.digests).toHaveLength(digests.length);
};

describe("request vectors", () => {
  it.each(requestVectors.requests)("decodes $name", (row) => {
    expect.hasAssertions();
    checkRequest(readQrRequest(payload(row)), row.expect as Expect);
  });

  it.each(requestVectors.requests)("inspects $name", (row) => {
    expect.hasAssertions();
    checkDigests(inspectQrRequest(readQrRequest(payload(row))), row.digests);
  });
});

const toResult = (result: {
  readonly fingerprint: string;
  readonly keys: ReadonlyArray<{ publicKey: string; chainCode?: string }>;
}): ChainExportResult =>
  ({
    fingerprint: result.fingerprint,
    keys: result.keys.map((key) => ({
      ...key,
      publicKey: hexToBytes(key.publicKey),
      ...(typeof key.chainCode === "string" ? { chainCode: hexToBytes(key.chainCode) } : {}),
    })),
  }) as unknown as ChainExportResult;

type ExportCase = (typeof exportVectors.cases)[number];

const checkHdkeyExport = (out: ReturnType<typeof qrExport>, expect_: ExportExpect): void => {
  const hd = CryptoHDKey.fromCBOR(Buffer.from(out.payload.cbor));
  expect(hd.getNote()).toBe(expect_.note);
  expect(hd.getName()).toBe(expect_.name);
  expect(hd.getOrigin().getDepth()).toBe(expect_.depth);
  expect(hd.getChildren().getPath()).toBe(expect_.children);
};

const checkAccountExport = (
  out: ReturnType<typeof qrExport>,
  row: ExportCase,
  expect_: ExportExpect,
): void => {
  const account = CryptoAccount.fromCBOR(Buffer.from(out.payload.cbor));
  expect(account.getMasterFingerprint().toString("hex")).toBe(row.result.fingerprint);
  const descriptors = account.getOutputDescriptors();
  expect(descriptors).toHaveLength(1);
  /* Vendor 0.8.1 (BlueWallet's pin) has no TR script expression: a taproot descriptor decodes
     but renders as the bare key. Assert the rendered form for pkh/wpkh and the key material
     for tr. */
  const rendered = descriptors[0]?.toString() ?? "";
  if (expect_.descriptor === "tr(") {
    expect(rendered).toContain("86'");
  } else {
    expect(rendered).toContain(expect_.descriptor);
  }
};

const checkMultiExport = (out: ReturnType<typeof qrExport>, expect_: ExportExpect): void => {
  const multi = CryptoMultiAccounts.fromCBOR(Buffer.from(out.payload.cbor));
  expect(multi.getDevice()).toBe(expect_.device);
  if (expect_.keyCount === undefined) {
    throw new Error("no expected keyCount");
  }
  expect(multi.getKeys()).toHaveLength(expect_.keyCount);
};

describe("export vectors", () => {
  it.each(exportVectors.cases.filter((row) => row.form === "crypto-hdkey"))(
    "encodes $name readable by the vendor registry",
    (row) => {
      const out = qrExport(toResult(row.result), row.form as "crypto-hdkey");
      expect.hasAssertions();
      const expect_ = row.expect as ExportExpect;
      expect(out.discloses).toBe(expect_.discloses);
      checkHdkeyExport(out, expect_);
    },
  );

  it.each(exportVectors.cases.filter((row) => row.form === "crypto-account"))(
    "encodes $name readable by the vendor registry",
    (row) => {
      const out = qrExport(toResult(row.result), row.form as "crypto-account");
      expect.hasAssertions();
      const expect_ = row.expect as ExportExpect;
      expect(out.discloses).toBe(expect_.discloses);
      checkAccountExport(out, row, expect_);
    },
  );

  it.each(exportVectors.cases.filter((row) => row.form === "crypto-multi-accounts"))(
    "encodes $name readable by the vendor registry",
    (row) => {
      const out = qrExport(toResult(row.result), row.form as "crypto-multi-accounts");
      expect.hasAssertions();
      const expect_ = row.expect as ExportExpect;
      expect(out.discloses).toBe(expect_.discloses);
      checkMultiExport(out, expect_);
    },
  );
});

const PARITY_KEY: TaskKey = {
  path: [0x8000002c, 0x8000003c, 0x80000000, 0, 0],
  publicKey: hexToBytes(`02${"00".repeat(32)}`),
};
const PARITY_ACCOUNT = {
  kind: "hd" as const,
  walletId: "",
  groupIndex: 0,
  template: "evm.bip44",
};

type ClassCase = (typeof classes.cases)[number];

type PlannedCase = {
  readonly qr: QrRequest;
  readonly planRequest: Parameters<typeof planEvm>[0];
  readonly digestKind: "evm-transaction-hash" | "eip712-digest" | "eip191-digest";
};

const plannedCase = (row: ClassCase): PlannedCase => {
  const request = row.request as unknown as {
    kind: string;
    tx?: EvmTransaction;
    typedData?: unknown;
    message?: { readonly $bytes: string };
  };
  if (request.kind === "evm.transaction" && request.tx !== undefined) {
    return {
      qr: {
        family: "evm",
        kind: "transaction",
        path: PARITY_KEY.path,
        xfp: 1,
        tx: request.tx,
        data: evmSigningPreimage(request.tx),
      },
      planRequest: {
        kind: "evm.transaction",
        network: "eip155:1",
        account: PARITY_ACCOUNT,
        tx: request.tx,
      },
      digestKind: "evm-transaction-hash",
    };
  }
  if (request.kind === "evm.typed-data" && request.typedData !== undefined) {
    const typedData = JSON.stringify(request.typedData);
    return {
      qr: { family: "evm", kind: "typed-data", path: PARITY_KEY.path, xfp: 1, typedData },
      planRequest: {
        kind: "evm.typed-data",
        network: "eip155:1",
        account: PARITY_ACCOUNT,
        typedData,
      },
      digestKind: "eip712-digest",
    };
  }
  if (request.kind === "evm.personal-message" && request.message !== undefined) {
    const message = hexToBytes(request.message.$bytes.replace(/^0x/, ""));
    return {
      qr: { family: "evm", kind: "personal-message", path: PARITY_KEY.path, xfp: 1, message },
      planRequest: {
        kind: "evm.personal-message",
        network: "eip155:1",
        account: PARITY_ACCOUNT,
        message,
      },
      digestKind: "eip191-digest",
    };
  }
  throw new Error(`unhandled case ${row.name}`);
};

const parityDigest = (
  row: ClassCase,
): { readonly plan: string; readonly inspect: string | undefined } => {
  const { qr, planRequest, digestKind } = plannedCase(row);
  const planDigest = planEvm(planRequest, PARITY_KEY).tasks[0]?.digest;
  if (planDigest === undefined) {
    throw new Error("plan produced no task");
  }
  const got = inspectQrRequest(qr).digests.find((digest) => digest.kind === digestKind);
  return { plan: `0x${bytesToHex(planDigest)}`, inspect: got?.value };
};

describe("inspect digests track planEvm across signing-classes", () => {
  const evmCases = classes.cases.filter((row) =>
    ["evm.transaction", "evm.typed-data", "evm.personal-message"].includes(row.request.kind),
  );

  it("has cases to check", () => {
    expect(evmCases.length).toBeGreaterThan(0);
  });

  it.each(evmCases)("digest matches plan for $name", (row) => {
    const { plan, inspect } = parityDigest(row);
    expect(inspect).toBe(plan);
  });
});

const qrErrorCode = (run: () => unknown): string => {
  try {
    run();
    return "no-error";
  } catch (error) {
    return error instanceof QrError ? error.code : "foreign-error";
  }
};

type HostileCase = {
  readonly name: string;
  readonly subject: string;
  readonly payload?: { readonly type: string; readonly cbor: string };
  readonly foreign?: { readonly type: string; readonly cbor: string };
  readonly frames?: ReadonlyArray<string>;
  readonly limits?: Record<string, number>;
  readonly fragmentLength?: number;
  readonly now?: ReadonlyArray<number>;
  readonly expect: string;
};

const scanFrames = (row: HostileCase): string[] => {
  if (row.frames !== undefined) {
    return [...row.frames];
  }
  if (row.payload === undefined) {
    throw new Error(`${row.name}: no frames or payload`);
  }
  const frames: string[] = [];
  const next = qrParts(payload(row.payload), {
    maxFragmentLength: row.fragmentLength ?? 200,
  });
  frames.push(next());
  if (row.foreign !== undefined) {
    const foreign = qrParts(payload(row.foreign));
    frames.push(foreign());
  }
  for (let i = 0; i < 4096; i += 1) {
    frames.push(next());
  }
  return frames;
};

const feedAll = (
  scanner: ReturnType<typeof createQrScanner>,
  frames: ReadonlyArray<string>,
): void => {
  for (const frame of frames) {
    if (scanner.receive(frame).status === "complete") {
      return;
    }
  }
};

const runHostile = (row: HostileCase): string => {
  if (row.subject === "payload") {
    const subject = row.payload;
    if (subject === undefined) {
      throw new Error(`${row.name}: missing payload`);
    }
    return qrErrorCode(() => readQrRequest(payload(subject)));
  }
  /* Scan cases: explicit frame lists, sequenced `now`, or a payload split into fountain parts
     (optionally mixed with a foreign-type frame). */
  const times = row.now ?? [0];
  let tick = 0;
  const scanner = createQrScanner({
    kind: "request",
    now: () => times[Math.min(tick++, times.length - 1)] ?? 0,
    ...(row.limits === undefined ? {} : { limits: row.limits }),
  });
  return qrErrorCode(() => feedAll(scanner, scanFrames(row)));
};

describe("hostile corpus", () => {
  const hostileCases: ReadonlyArray<HostileCase> = hostileVectors.cases;

  it.each(hostileCases)("$name ends in $expect", { timeout: 30_000 }, (row) => {
    expect(runHostile(row)).toBe(row.expect);
  });
});
