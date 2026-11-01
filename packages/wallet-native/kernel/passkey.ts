/**
 * Binds the native `__qntx.passkey` object to the kernel's `PasskeyAuthenticator`. The platform
 * only runs the system ceremony; this module builds the WebAuthn options JSON (discoverable,
 * user-verified, PRF eval) and parses the response JSON strictly — credential id, PRF results, the
 * user handle, and the UV/BE/BS flags from the authenticator data. A registration response without
 * authenticator data or PRF results reports no `first`, so the kernel asserts once. Failure codes
 * from the native side are already kernel error codes.
 */
import { base64urlnopad } from "@scure/base";

import { KernelError } from "../../wallet-kernel/src/errors.ts";
import type {
  PasskeyAuthenticator,
  PasskeyResult,
  PrfSalts,
  Random,
} from "../../wallet-kernel/src/platform.ts";

type Completion = (responseJson: string | undefined, code: string | undefined) => void;

/** The `__qntx.passkey` surface the native host injects. */
export type KernelPasskeyNative = {
  readonly create: (requestJson: string, done: Completion) => void;
  readonly get: (requestJson: string, done: Completion) => void;
};

const TIMEOUT_MS = 120_000;
// Authenticator data: rpIdHash(32) ‖ flags(1) ‖ signCount(4) ‖ …
const FLAGS_OFFSET = 32;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;

/** Whether bit `flag` (a power of two) is set in the authenticator-data flags byte. */
const hasFlag = (flags: number, flag: number): boolean => Math.floor(flags / flag) % 2 === 1;

function failure(code: string | undefined): KernelError {
  return code === "cancelled" || code === "factor-unavailable" || code === "unavailable"
    ? new KernelError(code, "the platform passkey ceremony did not complete")
    : new KernelError("unavailable", "the platform passkey ceremony reported no outcome");
}

const malformed = (): KernelError =>
  new KernelError("unavailable", "the platform returned a malformed passkey response");

const b64 = (bytes: Uint8Array): string => base64urlnopad.encode(bytes);

/** WebAuthn JSON is base64url; tolerate the padding some providers emit. */
function bytesOf(value: unknown): Uint8Array {
  if (typeof value !== "string") {
    throw malformed();
  }
  try {
    return base64urlnopad.decode(value.replace(/=+$/, ""));
  } catch {
    throw malformed();
  }
}

function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed();
  }
  return Object.fromEntries(Object.entries(value));
}

function prfEval(salts: PrfSalts): Record<string, string> {
  return salts.second === undefined
    ? { first: b64(salts.first) }
    : { first: b64(salts.first), second: b64(salts.second) };
}

/** PRF outputs from `clientExtensionResults.prf.results`, absent when the provider gave none. */
function prfResults(extensions: unknown): { first?: Uint8Array; second?: Uint8Array } {
  if (extensions === undefined) {
    return {};
  }
  const { prf } = objectOf(extensions);
  if (prf === undefined) {
    return {};
  }
  const { results } = objectOf(prf);
  if (results === undefined) {
    return {};
  }
  const { first, second } = objectOf(results);
  return {
    ...(first === undefined ? {} : { first: bytesOf(first) }),
    ...(second === undefined ? {} : { second: bytesOf(second) }),
  };
}

/**
 * Parses a registration (`assertion: false`) or authentication response. Without authenticator data
 * a registration carries no trustworthy flags, so its PRF results are dropped and the kernel falls
 * back to an assertion that does carry them.
 */
function parseResponse(json: string, assertion: boolean): PasskeyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw malformed();
  }
  const credential = objectOf(parsed);
  const response = objectOf(credential["response"]);
  const credentialId = bytesOf(credential["rawId"]);
  const { first, second } = prfResults(credential["clientExtensionResults"]);
  const rawAuthData = response["authenticatorData"];
  if (rawAuthData === undefined && !assertion) {
    first?.fill(0);
    second?.fill(0);
    return {
      credentialId,
      first: undefined,
      second: undefined,
      userHandle: undefined,
      synced: false,
      userVerified: false,
    };
  }
  const flags = bytesOf(rawAuthData)[FLAGS_OFFSET];
  if (flags === undefined) {
    throw malformed();
  }
  const handle = response["userHandle"];
  return {
    credentialId,
    first,
    second,
    userHandle: assertion && typeof handle === "string" ? bytesOf(handle) : undefined,
    synced: hasFlag(flags, FLAG_BE) && hasFlag(flags, FLAG_BS),
    userVerified: hasFlag(flags, FLAG_UV),
  };
}

async function run(
  start: (requestJson: string, done: Completion) => void,
  request: unknown,
  assertion: boolean,
): Promise<PasskeyResult> {
  const json = await new Promise<string>((resolve, reject) => {
    start(JSON.stringify(request), (responseJson, code) => {
      if (responseJson === undefined) {
        reject(failure(code));
        return;
      }
      resolve(responseJson);
    });
  });
  return parseResponse(json, assertion);
}

export function bindNativePasskey(raw: KernelPasskeyNative, random: Random): PasskeyAuthenticator {
  return {
    create: async (input) =>
      run(
        raw.create,
        {
          challenge: b64(random(32)),
          rp: { id: input.rpId, name: input.rpName },
          user: { id: b64(input.userId), name: input.userName, displayName: input.userName },
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
          timeout: TIMEOUT_MS,
          extensions: { prf: { eval: prfEval(input.salts) } },
        },
        false,
      ),
    get: async (input) =>
      run(
        raw.get,
        {
          challenge: b64(random(32)),
          rpId: input.rpId,
          allowCredentials: (input.allowCredentials ?? []).map((id) => ({
            type: "public-key",
            id: b64(id),
          })),
          userVerification: "required",
          timeout: TIMEOUT_MS,
          extensions: { prf: { eval: prfEval(input.salts) } },
        },
        true,
      ),
  };
}
