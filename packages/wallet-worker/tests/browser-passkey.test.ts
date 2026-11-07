/**
 * Unit tests for the WebAuthn ceremony in src/browser/passkey.ts: the DOM surface
 * (navigator.credentials, the credential/response classes) is stubbed with plain classes so the
 * mapping branches run under Node.
 */
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createWebAuthnPasskey } from "../src/browser/passkey.ts";

const RP = { id: "qntx.test", name: "qntx" };
const SALT = new Uint8Array(32).fill(7);
const PRF = new Uint8Array(32).fill(9);
const CREDENTIAL_ID = new Uint8Array(16).fill(3);
const UV_AUTH_DATA = new Uint8Array(37);
UV_AUTH_DATA[32] = 0x1c; // UV + BE + BS flags

class PublicKeyCredential {
  readonly rawId = CREDENTIAL_ID;
  response: object = {};
  extensions: object = {};
  getClientExtensionResults() {
    return this.extensions;
  }
}

class AuthenticatorAssertionResponse {
  authenticatorData: ArrayBuffer = new ArrayBuffer(0);
}

class AuthenticatorAttestationResponse {
  authenticatorData: ArrayBuffer = UV_AUTH_DATA.buffer;
  getAuthenticatorData(): ArrayBuffer {
    return this.authenticatorData;
  }
}

function publicKeyCredential(response: object, extensions: object = {}): PublicKeyCredential {
  const credential = new PublicKeyCredential();
  credential.response = response;
  credential.extensions = extensions;
  return credential;
}

function assertionResponse(
  authData: ArrayBuffer = UV_AUTH_DATA.buffer,
): AuthenticatorAssertionResponse {
  const response = new AuthenticatorAssertionResponse();
  response.authenticatorData = authData;
  return response;
}

const globals = {
  navigator: {} as { credentials: object },
  PublicKeyCredential,
  AuthenticatorAssertionResponse,
  AuthenticatorAttestationResponse,
};

const originals = new Map<string, unknown>();

function install(): void {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(globals)) {
    if (!originals.has(key)) {
      originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    }
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  }
}

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const [key, descriptor] of originals.entries()) {
    if (descriptor === undefined) {
      // oxlint-disable-next-line typescript/no-dynamic-delete -- restoring an absent global
      delete g[key];
    } else {
      Object.defineProperty(globalThis, key, descriptor as PropertyDescriptor);
    }
  }
  originals.clear();
});

/** Scripts the next navigator.credentials.get/create answer. */
function stubCredentials(answers: { get?: unknown; create?: unknown }): void {
  install();
  const call = async (answer: unknown) =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  globals.navigator.credentials = {
    get: async () => call(answers.get),
    create: async () => call(answers.create),
  };
}

function assertionCredential(extensions: object): PublicKeyCredential {
  return publicKeyCredential(assertionResponse(), extensions);
}

describe("browser passkey ceremony", () => {
  it("create returns the PRF outputs from a supporting authenticator", async () => {
    stubCredentials({
      create: publicKeyCredential(new AuthenticatorAttestationResponse(), {
        prf: { enabled: true, results: { first: PRF } },
      }),
    });
    const result = await createWebAuthnPasskey(RP).create({
      purpose: "wallet",
      name: "me",
      salts: { first: SALT },
    });
    expect(result.first).toStrictEqual(PRF);
    expect(result.credentialId).toStrictEqual(CREDENTIAL_ID);
    expect(result.synced).toBe(true);
  });

  it("create with prf.enabled false is passkey-prf-unsupported", async () => {
    stubCredentials({
      create: publicKeyCredential(new AuthenticatorAttestationResponse(), {
        prf: { enabled: false },
      }),
    });
    await expect(
      createWebAuthnPasskey(RP).create({ purpose: "wallet", name: "me", salts: { first: SALT } }),
    ).rejects.toThrow(expect.objectContaining({ code: "passkey-prf-unsupported" }));
  });

  it("create without PRF results asserts the new credential", async () => {
    stubCredentials({
      create: publicKeyCredential(new AuthenticatorAttestationResponse(), {
        prf: { enabled: true },
      }),
      get: assertionCredential({ prf: { results: { first: PRF } } }),
    });
    const result = await createWebAuthnPasskey(RP).create({
      purpose: "wallet",
      name: "me",
      salts: { first: SALT },
    });
    expect(result.first).toStrictEqual(PRF);
  });

  it("assert returns the PRF output and the user handle", async () => {
    const userHandle = new Uint8Array(16).fill(1);
    stubCredentials({
      get: publicKeyCredential(Object.assign(assertionResponse(), { userHandle }), {
        prf: { results: { first: PRF, second: PRF } },
      }),
    });
    const result = await createWebAuthnPasskey(RP).assert({
      credentialIds: [CREDENTIAL_ID],
      salts: { first: SALT, second: SALT },
    });
    expect(result.first).toStrictEqual(PRF);
    expect(result.second).toStrictEqual(PRF);
    expect(result.userHandle).toStrictEqual(userHandle);
  });

  it("a missing PRF output is passkey-prf-unsupported", async () => {
    stubCredentials({ get: assertionCredential({ prf: { results: {} } }) });
    await expect(createWebAuthnPasskey(RP).assert({ salts: { first: SALT } })).rejects.toThrow(
      expect.objectContaining({ code: "passkey-prf-unsupported" }),
    );
  });

  it("a cancelled ceremony is cancelled", async () => {
    stubCredentials({ get: new DOMException("user abort", "NotAllowedError") });
    await expect(createWebAuthnPasskey(RP).assert({ salts: { first: SALT } })).rejects.toThrow(
      expect.objectContaining({ code: "cancelled" }),
    );
  });

  it("a non-credential answer is unavailable", async () => {
    stubCredentials({ get: { not: "a credential" } });
    await expect(createWebAuthnPasskey(RP).assert({ salts: { first: SALT } })).rejects.toThrow(
      expect.objectContaining({ code: "unavailable" }),
    );
  });

  it("an unverified assertion is unavailable", async () => {
    stubCredentials({
      get: publicKeyCredential(assertionResponse(new Uint8Array(37).buffer), {
        prf: { results: { first: PRF } },
      }),
    });
    await expect(createWebAuthnPasskey(RP).assert({ salts: { first: SALT } })).rejects.toThrow(
      expect.objectContaining({ code: "unavailable" }),
    );
  });

  it("a non-DOMException failure is unavailable", async () => {
    stubCredentials({ get: new TypeError("network") });
    await expect(createWebAuthnPasskey(RP).assert({ salts: { first: SALT } })).rejects.toThrow(
      expect.objectContaining({ code: "unavailable" }),
    );
  });
});
