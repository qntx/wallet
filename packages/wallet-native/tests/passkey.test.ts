/**
 * The native passkey binding: the WebAuthn options JSON the kernel sends the platform, and the
 * strict parsing of registration/authentication responses (PRF results, user handle, UV/BE/BS).
 */
import { base64urlnopad } from "@scure/base";
import { describe, expect, it } from "vite-plus/test";

import { bindNativePasskey } from "../kernel/passkey.ts";
import type { KernelPasskeyNative } from "../kernel/passkey.ts";

const b64 = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);
const random = (length: number): Uint8Array => new Uint8Array(length).fill(0xaa);
const CREDENTIAL = new Uint8Array([1, 2, 3, 4]);
const PRF = new Uint8Array(32).fill(5);
const SALT = new TextEncoder().encode("harness/wallet/v1");

/** Authenticator data with the given flags byte (rpIdHash ‖ flags ‖ signCount). */
const authData = (flags: number): Uint8Array => {
  const data = new Uint8Array(37);
  data[32] = flags;
  return data;
};

/** A native stand-in that records the request JSON and answers with `reply`. */
function native(reply: { json?: unknown; code?: string }) {
  const requests: unknown[] = [];
  const answer = (requestJson: string, done: (json?: string, code?: string) => void): void => {
    requests.push(JSON.parse(requestJson));
    setTimeout(() => {
      done(reply.json === undefined ? undefined : JSON.stringify(reply.json), reply.code);
    });
  };
  const raw: KernelPasskeyNative = { create: answer, get: answer };
  return { raw, requests };
}

const assertion = (flags: number, extras: Record<string, unknown> = {}) => ({
  rawId: b64(CREDENTIAL),
  response: { authenticatorData: b64(authData(flags)), userHandle: b64(new Uint8Array([1, 9])) },
  clientExtensionResults: { prf: { results: { first: b64(PRF) } } },
  ...extras,
});

describe("passkey binding: requests", () => {
  it("creates a discoverable, user-verified credential with PRF eval", async () => {
    const { raw, requests } = native({ json: assertion(0x1d) });
    await bindNativePasskey(raw, random).create({
      rpId: "wallet-harness.qntx.org",
      rpName: "Harness",
      userId: new Uint8Array([1, 7]),
      userName: "alice",
      salts: { first: SALT },
    });
    expect(requests).toStrictEqual([
      {
        challenge: b64(random(32)),
        rp: { id: "wallet-harness.qntx.org", name: "Harness" },
        user: { id: b64(new Uint8Array([1, 7])), name: "alice", displayName: "alice" },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "required",
          requireResidentKey: true,
          userVerification: "required",
        },
        attestation: "none",
        timeout: 120_000,
        extensions: { prf: { eval: { first: b64(SALT) } } },
      },
    ]);
  });

  it("asserts with an allow-list and both PRF salts when given", async () => {
    const { raw, requests } = native({ json: assertion(0x05) });
    await bindNativePasskey(raw, random).get({
      rpId: "wallet-harness.qntx.org",
      allowCredentials: [CREDENTIAL],
      salts: { first: SALT, second: new Uint8Array([9]) },
    });
    expect(requests).toStrictEqual([
      {
        challenge: b64(random(32)),
        rpId: "wallet-harness.qntx.org",
        allowCredentials: [{ type: "public-key", id: b64(CREDENTIAL) }],
        userVerification: "required",
        timeout: 120_000,
        extensions: { prf: { eval: { first: b64(SALT), second: b64(new Uint8Array([9])) } } },
      },
    ]);
  });
});

describe("passkey binding: responses", () => {
  const get = async (reply: { json?: unknown; code?: string }) =>
    bindNativePasskey(native(reply).raw, random).get({
      rpId: "wallet-harness.qntx.org",
      allowCredentials: undefined,
      salts: { first: SALT },
    });

  it("reads PRF, user handle and the UV/BE/BS flags of an assertion", async () => {
    const result = await get({ json: assertion(0x1d) });
    expect(result.credentialId).toStrictEqual(CREDENTIAL);
    expect(result.first).toStrictEqual(PRF);
    expect(result.userHandle).toStrictEqual(new Uint8Array([1, 9]));
    expect(result.userVerified).toBe(true);
    expect(result.synced).toBe(true);
  });

  it("a device-bound, unverified assertion reports both flags false", async () => {
    const result = await get({ json: assertion(0x01) });
    expect(result.userVerified).toBe(false);
    expect(result.synced).toBe(false);
  });

  it("a registration without authenticator data defers PRF to an assertion", async () => {
    const { raw } = native({
      json: {
        rawId: b64(CREDENTIAL),
        response: { attestationObject: "o2NmbXRkbm9uZQ" },
        clientExtensionResults: { prf: { enabled: true, results: { first: b64(PRF) } } },
      },
    });
    const result = await bindNativePasskey(raw, random).create({
      rpId: "wallet-harness.qntx.org",
      rpName: "Harness",
      userId: new Uint8Array([1]),
      userName: "alice",
      salts: { first: SALT },
    });
    expect(result.first).toBeUndefined();
    expect(result.credentialId).toStrictEqual(CREDENTIAL);
  });

  it("a response that is not JSON is unavailable", async () => {
    const broken: KernelPasskeyNative = {
      create: (_request, done) => {
        done("{", undefined);
      },
      get: (_request, done) => {
        done("{", undefined);
      },
    };
    await expect(
      bindNativePasskey(broken, random).get({
        rpId: "wallet-harness.qntx.org",
        allowCredentials: undefined,
        salts: { first: SALT },
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "unavailable" }));
  });

  it.each([
    ["no response", { rawId: b64(CREDENTIAL) }],
    ["bad rawId", { ...assertion(0x05), rawId: 7 }],
    ["short authenticator data", { ...assertion(0x05), response: { authenticatorData: "AA" } }],
  ])("a malformed response (%s) is unavailable", async (_name, json) => {
    await expect(get({ json })).rejects.toThrow(expect.objectContaining({ code: "unavailable" }));
  });

  it.each([
    ["cancelled", "cancelled"],
    ["factor-unavailable", "factor-unavailable"],
    ["unavailable", "unavailable"],
    ["bogus", "unavailable"],
  ])("native code %s surfaces as %s", async (code, expected) => {
    await expect(get({ code })).rejects.toThrow(expect.objectContaining({ code: expected }));
  });
});
