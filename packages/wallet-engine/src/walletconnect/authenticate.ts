import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { AuthTypes, SessionTypes, SignClientTypes } from "@walletconnect/types";
import {
  buildAuthObject,
  getChainsFromRecap,
  getMethodsFromRecap,
  getRecapFromResources,
  getSdkError,
  populateAuthPayload,
} from "@walletconnect/utils";
import { getAddress } from "viem";

import { internalError } from "../connect/errors.ts";
import { walletConnectKey } from "../requests/types.ts";
import type { WalletConnectOrigin } from "../requests/types.ts";
import { eip155Row } from "./eip155.ts";
import type { WalletConnectEngine } from "./namespaces.ts";
import { metadataOrigin, sanitizePeer, verifyOf } from "./proposals.ts";

export type SessionAuthenticate = SignClientTypes.EventArguments["session_authenticate"];

/** The WalletKit surface an authenticate request needs — a real `WalletKit` satisfies it. */
export type AuthKit = {
  readonly formatAuthMessage: (params: {
    request: AuthTypes.BaseAuthRequestParams;
    iss: string;
  }) => string;
  readonly approveSessionAuthenticate: (params: {
    id: number;
    auths: AuthTypes.Cacao[];
  }) => Promise<{ session: SessionTypes.Struct | undefined }>;
  readonly rejectSessionAuthenticate: (params: {
    id: number;
    reason: { readonly code: number; readonly message: string };
  }) => Promise<void>;
};

export type AuthDeps = {
  readonly kit: AuthKit;
  readonly engine: WalletConnectEngine;
  readonly now: () => number;
  readonly warn: (message: string, error: unknown) => void;
  /** Runs the session-settling work under the controller's `establishing` guard. */
  readonly establish: <T>(work: () => Promise<T>) => Promise<T>;
};

/**
 * One `session_authenticate` end to end: validate the CAIP-222 request against the peer it claims
 * to be, sign the populated SIWE message through the ordinary `evm-sign` pipeline, build the Cacao
 * and settle — a session when the recap carries methods, an auth-only answer otherwise. Every
 * failure answers `rejectSessionAuthenticate`; nothing is held or requeued.
 */
export const handleAuthenticate = async (
  event: SessionAuthenticate,
  deps: AuthDeps,
): Promise<void> => {
  const { kit, engine } = deps;
  const reject = async (message: string): Promise<void> => {
    try {
      await kit.rejectSessionAuthenticate({
        id: event.id,
        reason: getSdkError("USER_REJECTED", message),
      });
    } catch (error) {
      deps.warn("walletconnect auth rejection failed", error);
    }
  };
  const { authPayload, requester, expiryTimestamp } = event.params;
  if (expiryTimestamp * 1000 <= deps.now()) {
    return reject("the authenticate request expired");
  }
  const url = metadataOrigin(requester.metadata.url);
  if (url === undefined) {
    return reject("the peer metadata url is not an http(s) origin");
  }
  if (engine.phishing.check(url) === "blocked") {
    return reject("the peer is on the phishing list");
  }
  // CAIP-222 binds the signature to the peer: the SIWE domain is the peer's host and its URI the
  // peer's origin — anything else would let a relayed request sign for a different site.
  if (authPayload.domain !== new URL(url).host) {
    return reject("the auth domain is not the peer's host");
  }
  const aud = authPayload.aud ?? ("uri" in authPayload ? authPayload.uri : undefined);
  let audOrigin: string | undefined;
  try {
    audOrigin = typeof aud === "string" ? new URL(aud).origin : undefined;
  } catch {
    audOrigin = undefined;
  }
  if (audOrigin !== url) {
    return reject("the auth URI is not the peer's origin");
  }
  const network = authPayload.chains.find(
    (chain) => eip155Row.serves(chain) && engine.connections.isEnabled(chain),
  );
  if (network === undefined) {
    return reject("no requested chain is served and enabled");
  }
  let populated: AuthTypes.PayloadParams;
  try {
    populated = populateAuthPayload({
      authPayload,
      chains: [network],
      methods: Object.keys(eip155Row.methods),
    });
  } catch {
    return reject("the requested methods are not supported");
  }
  let recap: string | undefined;
  try {
    recap = getRecapFromResources(populated.resources);
    // Every recap resource's chains land in the settled session's namespaces — a resource
    // naming a foreign chain would smuggle it into the session.
    if (recap !== undefined && !getChainsFromRecap(recap).every((chain) => chain === network)) {
      await reject("the recap authorizes other chains");
      return;
    }
  } catch {
    return reject("the recap resource is malformed");
  }
  const preview = await engine.connections.previewAccounts(network);
  const address = preview?.addresses[0];
  if (preview === undefined || address === undefined) {
    return reject("no account is available for the network");
  }
  const iss = `${network}:${getAddress(address)}`;
  const account = {
    kind: "hd" as const,
    walletId: preview.group.walletId,
    groupIndex: preview.group.groupIndex,
    template: "evm.bip44" as const,
  };
  const origin: WalletConnectOrigin = {
    kind: "walletconnect",
    origin: walletConnectKey(event.topic),
    topic: event.topic,
    url,
    name: sanitizePeer(requester.metadata, url).name,
    verify: verifyOf(event.verifyContext.verified),
  };
  let signature: string;
  try {
    const pending = await engine.requests.prepare({
      method: "evm-sign",
      origin,
      account,
      network,
      request: {
        kind: "evm.personal-message",
        network,
        account,
        message: utf8ToBytes(kit.formatAuthMessage({ request: populated, iss })),
      },
    });
    const outcome = await engine.requests.outcome(pending.id);
    if (!("signature" in outcome) || !(outcome.signature instanceof Uint8Array)) {
      throw internalError("the sign request has no signature");
    }
    signature = `0x${bytesToHex(outcome.signature)}`;
  } catch {
    // Auth requests are short-lived — a rejection, expiry or mid-approval lock ends the request
    // outright; it is refused on the wire rather than requeued like a session request.
    return reject("the signature request did not complete");
  }
  const auth = buildAuthObject(populated, { t: "eip191", s: signature }, iss);
  const recapMethods =
    recap === undefined
      ? []
      : getMethodsFromRecap(recap).flatMap(
          (method: unknown) => eip155Row.methods[typeof method === "string" ? method : ""] ?? [],
        );
  if (recapMethods.length === 0) {
    // Auth without session methods stays an auth — no ConnectionSession is created.
    await kit.approveSessionAuthenticate({ id: event.id, auths: [auth] });
    return;
  }
  try {
    await deps.establish(async () => {
      await engine.connections.establishWalletConnect(
        {
          [network]: {
            methods: [...new Set(recapMethods)],
            notifications: ["accountsChanged", "chainChanged"],
          },
        },
        async (bound) => {
          const [caip10] = bound[network]?.accounts ?? [];
          const boundAddress = caip10?.slice(caip10.lastIndexOf(":") + 1);
          if (boundAddress?.toLowerCase() !== address.toLowerCase()) {
            throw internalError("the bound account changed between signing and settling");
          }
          const { session } = await kit.approveSessionAuthenticate({
            id: event.id,
            auths: [auth],
          });
          if (session === undefined) {
            throw internalError("the authenticated session did not settle");
          }
          return {
            kind: "walletconnect",
            origin: walletConnectKey(session.topic),
            topic: session.topic,
            url,
            name: origin.name,
            verify: origin.verify,
          };
        },
      );
    });
  } catch {
    return reject("the session did not settle");
  }
};
