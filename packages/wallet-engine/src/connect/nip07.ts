/**
 * The NIP-07 (`window.nostr`) handler — the bridge routes `provider: "nostr"` messages here.
 * `getPublicKey` asks for the active identity (a `nostr` connection approval when the origin is not
 * yet authorized); `signEvent` is policy-gated — an allowed kind signs directly through the
 * identity's signer, anything else (or one of the forced-confirm kinds) goes through the request
 * pipeline's `nostr-sign` for an explicit approval; `nip04`/`nip44` `encrypt` needs authorization
 * and `decrypt` additionally needs the session's `nostrPolicy.decrypt`.
 */
import type { Event } from "@qntx/nostr";
import type { NostrKeyRef } from "@qntx/wallet";
import type { WalletSigner } from "@qntx/wallet/nostr";

import type { RequestController } from "../requests/controller.ts";
import type { ConnectionController } from "./controller.ts";
import { invalidParams, unauthorized } from "./errors.ts";

/** A NIP-07 method call from the page. */
export type Nip07Request = {
  readonly method: string;
  readonly params?: unknown;
};

export type Nip07HandlerOptions = {
  readonly connections: Pick<
    ConnectionController,
    | "checkOrigin"
    | "authorize"
    | "session"
    | "nostrAccount"
    | "nostrPolicy"
    | "activeIdentity"
    | "request"
    | "touch"
  >;
  readonly requests: Pick<RequestController, "prepare" | "outcome">;
  /** `nostr(wallet).signer(ref)` — the active identity's signer. */
  readonly signerFor: (ref: NostrKeyRef) => WalletSigner;
};

/** `signEvent` of these kinds always asks for explicit confirmation, whatever the policy allows. */
const FORCED_CONFIRM_KINDS: ReadonlySet<number> = new Set([0, 3, 5, 10002]);

const MAX_TAGS = 64;
const MAX_TAG_ITEMS = 32;
const MAX_TAG_ITEM_LENGTH = 1024;
const MAX_CONTENT_LENGTH = 128 * 1024;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Strict event validation: `kind` is an integer 0–65535, `created_at` a safe integer, `tags` a
 * bounded `string[][]`, `content` a bounded string and `pubkey` — when present — a string.
 */
function checkEvent(value: unknown): {
  readonly kind: number;
  readonly content: string;
  readonly created_at: number;
  readonly tags: ReadonlyArray<ReadonlyArray<string>>;
  readonly pubkey?: string;
} {
  if (!isObject(value)) {
    throw invalidParams("event is not an object");
  }
  const { kind, content, pubkey, tags, created_at: createdAt } = value;
  if (typeof kind !== "number" || !Number.isSafeInteger(kind) || kind < 0 || kind > 65_535) {
    throw invalidParams("event.kind must be an integer 0–65535");
  }
  if (typeof content !== "string" || content.length > MAX_CONTENT_LENGTH) {
    throw invalidParams("event.content must be a string");
  }
  if (pubkey !== undefined && typeof pubkey !== "string") {
    throw invalidParams("event.pubkey must be a string");
  }
  if (typeof createdAt !== "number" || !Number.isSafeInteger(createdAt)) {
    throw invalidParams("event.created_at must be a safe integer");
  }
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    throw invalidParams("event.tags must be a bounded array of string arrays");
  }
  const checkedTags: string[][] = [];
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length > MAX_TAG_ITEMS) {
      throw invalidParams("event.tags items must be bounded string arrays");
    }
    const checkedTag: string[] = [];
    for (const item of tag) {
      if (typeof item !== "string" || item.length > MAX_TAG_ITEM_LENGTH) {
        throw invalidParams("event.tags items must contain bounded strings");
      }
      checkedTag.push(item);
    }
    checkedTags.push(checkedTag);
  }
  return {
    kind,
    content,
    created_at: createdAt,
    tags: checkedTags,
    ...(pubkey === undefined ? {} : { pubkey }),
  };
}

/** NIP-04/NIP-44 encrypt/decrypt take `[peerPubkey, text]`. */
function peerText(params: unknown): { peer: string; text: string } {
  if (!Array.isArray(params) || typeof params[0] !== "string" || typeof params[1] !== "string") {
    throw invalidParams("expected [peerPubkey, text]");
  }
  return { peer: params[0], text: params[1] };
}

export class Nip07Handler {
  private readonly options: Nip07HandlerOptions;

  constructor(options: Nip07HandlerOptions) {
    this.options = options;
  }

  async handle(origin: string, request: Nip07Request): Promise<unknown> {
    const { connections } = this.options;
    connections.checkOrigin(origin);
    const identity = connections.activeIdentity();
    if (identity === undefined) {
      throw unauthorized();
    }
    const pubkey = connections.nostrAccount(origin);
    switch (request.method) {
      case "getPublicKey":
        return this.publicKey(origin, pubkey);
      case "signEvent":
        return this.signEvent(origin, pubkey, identity, request.params);
      case "nip04.encrypt":
      case "nip04.decrypt":
      case "nip44.encrypt":
      case "nip44.decrypt": {
        connections.authorize(origin, "nostr", request.method);
        const { peer, text } = peerText(request.params);
        return this.crypt(origin, identity, request.method, peer, text);
      }
      default:
        throw unauthorized();
    }
  }

  private async publicKey(origin: string, pubkey: string | undefined): Promise<string> {
    const { connections } = this.options;
    if (pubkey === undefined) {
      await connections.request(origin, { kind: "connect", namespace: "nostr" });
    }
    await connections.touch(origin);
    const granted = connections.nostrAccount(origin);
    if (granted === undefined) {
      throw unauthorized();
    }
    return granted;
  }

  private async signEvent(
    origin: string,
    pubkey: string | undefined,
    identity: NostrKeyRef,
    params: unknown,
  ): Promise<Event> {
    const { connections, requests, signerFor } = this.options;
    const session = connections.authorize(origin, "nostr", "signEvent");
    const event = checkEvent(Array.isArray(params) ? params[0] : params);
    // A page-supplied pubkey must equal the active identity's or be absent.
    if (event.pubkey !== undefined && event.pubkey !== pubkey) {
      throw invalidParams("event.pubkey does not match the active identity");
    }
    if (pubkey === undefined) {
      throw unauthorized();
    }
    const policy = session.nostrPolicy ?? { signing: "ask", decrypt: false };
    const direct =
      policy.signing === "always" ||
      (typeof policy.signing === "object" && policy.signing.kinds.includes(event.kind));
    const signing = { ...event, pubkey };
    if (direct && !FORCED_CONFIRM_KINDS.has(event.kind)) {
      await connections.touch(origin);
      return signerFor(identity).signEvent(signing);
    }
    const pending = await requests.prepare({
      method: "nostr-sign",
      origin: { kind: "browser", origin },
      ref: identity,
      event: signing,
    });
    const outcome = await requests.outcome(pending.id);
    if (outcome === undefined || !("event" in outcome)) {
      throw unauthorized();
    }
    return outcome.event;
  }

  private async crypt(
    origin: string,
    identity: NostrKeyRef,
    method: string,
    peer: string,
    text: string,
  ): Promise<string> {
    const { connections, signerFor } = this.options;
    if (method.endsWith(".decrypt") && connections.nostrPolicy(origin)?.decrypt !== true) {
      throw unauthorized();
    }
    await connections.touch(origin);
    const signer = signerFor(identity);
    const fn =
      method === "nip04.encrypt"
        ? signer.nip04Encrypt
        : method === "nip04.decrypt"
          ? signer.nip04Decrypt
          : method === "nip44.encrypt"
            ? signer.nip44Encrypt
            : signer.nip44Decrypt;
    if (fn === undefined) {
      throw unauthorized();
    }
    return fn(peer, text);
  }
}
