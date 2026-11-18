/** Recognition of Sign-In with Ethereum (ERC-4361) and Sign-In with Solana text in signed messages. */
import type { Message, MessageFields } from "@qntx/siwx";
import { evm } from "@qntx/siwx/evm";
import { siws, validateAddress as validateSolanaAddress } from "@qntx/siwx/svm";

/** A domain a sign-in line claims: `[scheme://]domain wants you to sign in with your Ethereum|Solana account:` at the start of a line. */
export type SignInClaim = { readonly scheme?: string; readonly domain: string };

/** A Sign-In with X message found in signed text (ERC-4361 / SIWS). */
export type SignInParse =
  | { readonly status: "valid"; readonly fields: MessageFields }
  /**
   * Not a conforming message for the family; `claims` are the domains its preamble lines claim —
   * lenient verifiers (viem `parseSiweMessage`, `@solana/wallet-standard-util`
   * `parseSignInMessageText`) accept such text, so the wallet binds it to the page like a
   * conforming one.
   */
  | { readonly status: "malformed"; readonly claims: ReadonlyArray<SignInClaim> };

const PREAMBLE = " wants you to sign in with your ";

const CLAIM =
  /^(?:(?<scheme>[A-Za-z][A-Za-z0-9+.-]*):\/\/)?(?<domain>.*?) wants you to sign in with your (?:Ethereum|Solana) account:$/;

const claims = (text: string): SignInClaim[] =>
  text.split("\n").flatMap((line) => {
    const groups = CLAIM.exec(line.endsWith("\r") ? line.slice(0, -1) : line)?.groups;
    if (groups === undefined) {
      return [];
    }
    const claim: { scheme?: string; domain: string } = { domain: groups["domain"] ?? "" };
    if (groups["scheme"] !== undefined) {
      claim.scheme = groups["scheme"];
    }
    return [claim];
  });

const OPTIONAL_KEYS = ["scheme", "statement", "expirationTime", "notBefore", "requestId"] as const;

const plainFields = (message: Message): MessageFields => {
  const { domain, address, uri, version, chainId, nonce, issuedAt, resources } = message;
  const fields: { -readonly [K in keyof MessageFields]: MessageFields[K] } = {
    domain,
    address,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
  };
  for (const key of OPTIONAL_KEYS) {
    const value = message[key];
    if (value !== undefined) {
      fields[key] = value;
    }
  }
  if (resources !== undefined) {
    fields.resources = [...resources];
  }
  return fields;
};

const parseValid = (text: string, family: "evm" | "solana"): MessageFields => {
  if (family === "evm") {
    const ns = evm();
    const message = ns.parse(new TextEncoder().encode(text));
    ns.account(message);
    return plainFields(message);
  }
  const message = siws.parse(text);
  validateSolanaAddress(message.address);
  return plainFields(message);
};

/**
 * Finds a Sign-In with X message in `text` for the chain `family`. `undefined` when the text has no
 * sign-in preamble; `malformed` when it has one but is not a conforming message for the family
 * (ERC-4361: wallets should warn about that shape).
 */
export function parseSignIn(text: string, family: "evm" | "solana"): SignInParse | undefined {
  try {
    return { status: "valid", fields: parseValid(text, family) };
  } catch {
    return text.includes(PREAMBLE) ? { status: "malformed", claims: claims(text) } : undefined;
  }
}
