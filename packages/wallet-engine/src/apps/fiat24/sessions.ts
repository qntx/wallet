/**
 * Per-group Fiat24 API sessions and the request bookkeeping every signer of the group shares. A
 * session is a lazy in-memory `Fiat24Session` — the SDK grants on the first secured call and a
 * grant is a bearer credential, so sessions live only here and `end`/`endAll` are the lock, disable
 * and wallet-removal paths' whole cleanup. The `opened` sets record every request id the group's
 * signers opened so `disable` can reject whatever is still awaiting approval. No grant, label or
 * signature is ever stored, logged or put in an error.
 */
import type {
  Card,
  Fiat24Api,
  Fiat24Session,
  Profile,
  TransactionPage,
  TransactionQuery,
} from "@qntx/fiat24/api";

import type { AppGroup, AppRequests } from "../spi.ts";
import { Fiat24AppError } from "./errors.ts";
import type { Fiat24Owner } from "./owner.ts";
import { createFiat24Signer } from "./signer.ts";
import type { Fiat24Refusal } from "./signer.ts";

/** The read-only slice of `Fiat24Session` the app surfaces — writes stay inside flows. */
export type Fiat24SecuredReads = {
  readonly profile: () => Promise<Profile>;
  readonly cards: () => Promise<ReadonlyArray<Card>>;
  /** The 5-minute Marqeta display token for the host's card widget. */
  readonly cardDisplayToken: (externalId: string) => Promise<string>;
  readonly transactions: (query: TransactionQuery) => Promise<TransactionPage>;
  /** Ends the grant — the next secured call of this group opens a fresh session. */
  readonly end: () => void;
};

const groupKey = (group: AppGroup): string => `${group.walletId}/${group.groupIndex}`;

export function createFiat24Sessions(options: {
  readonly requests: Pick<AppRequests, "prepare" | "outcome">;
  readonly owner: Fiat24Owner;
  readonly api: Fiat24Api | undefined;
}): {
  /** The group's session for `tokenId`, opened lazily — `undefined` without an api client. */
  readonly sdk: (group: AppGroup, tokenId: bigint) => Promise<Fiat24Session | undefined>;
  /** The read-only secured surface — `undefined` without an api client. */
  readonly reads: (group: AppGroup, tokenId: bigint) => Fiat24SecuredReads | undefined;
  /** A fresh signer for `group` — its opened ids land in the group's bookkeeping. */
  readonly signer: (args: {
    group: AppGroup;
    owner: `0x${string}`;
    tokenId?: bigint;
    opened?: (id: string) => void;
    refused?: (reason: Fiat24Refusal) => void;
  }) => ReturnType<typeof createFiat24Signer>;
  /** Every request id the group's signers reported open — for the disable reject pass. */
  readonly openedIds: (group: AppGroup) => ReadonlySet<string>;
  /** Every group the sessions module has seen — the wallet-removal sweep's candidates. */
  readonly tracked: () => ReadonlyArray<AppGroup>;
  /** Ends the group's session. */
  readonly end: (group: AppGroup) => void;
  /** Ends every session — the vault lock path. */
  readonly endAll: () => void;
} {
  const sessions = new Map<string, Fiat24Session>();
  const opened = new Map<string, Set<string>>();
  const known = new Map<string, AppGroup>();

  const openedIdsOf = (group: AppGroup): Set<string> => {
    const key = groupKey(group);
    known.set(key, group);
    let ids = opened.get(key);
    if (ids === undefined) {
      ids = new Set();
      opened.set(key, ids);
    }
    return ids;
  };

  const sdk = async (group: AppGroup, tokenId: bigint): Promise<Fiat24Session | undefined> => {
    if (options.api === undefined) {
      return undefined;
    }
    const key = groupKey(group);
    known.set(key, group);
    let session = sessions.get(key);
    if (session === undefined) {
      const owner = await options.owner(group);
      session = options.api.openSession({
        tokenId,
        signer: {
          address: owner,
          signSessionGrant: signer({ group, owner, tokenId }).signSessionGrant,
        },
      });
      sessions.set(key, session);
    }
    return session;
  };

  const signer = ({
    group,
    owner,
    tokenId,
    opened: onOpened,
    refused,
  }: {
    group: AppGroup;
    owner: `0x${string}`;
    tokenId?: bigint;
    opened?: (id: string) => void;
    refused?: (reason: Fiat24Refusal) => void;
  }) => {
    known.set(groupKey(group), group);
    const ids = openedIdsOf(group);
    return createFiat24Signer({
      requests: {
        prepare: options.requests.prepare,
        outcome: async (id) => {
          try {
            return await options.requests.outcome(id);
          } finally {
            /* A settled request is no longer open — disable/removal must not reject it. */
            ids.delete(id);
          }
        },
      },
      group,
      owner,
      ...(tokenId === undefined ? {} : { tokenId }),
      opened: (id) => {
        ids.add(id);
        onOpened?.(id);
      },
      refused: (reason) => refused?.(reason),
    });
  };

  return {
    sdk,
    reads: (group, tokenId) => {
      if (options.api === undefined) {
        return undefined;
      }
      const read = async <T>(body: (session: Fiat24Session) => Promise<T>): Promise<T> => {
        const session = await sdk(group, tokenId);
        if (session === undefined) {
          throw new Fiat24AppError("api-unavailable", "the fiat24 api is not configured");
        }
        return body(session);
      };
      return {
        profile: async () => read(async (session) => session.profile()),
        cards: async () => read(async (session) => session.cards()),
        cardDisplayToken: async (externalId) =>
          read(async (session) => session.cardDisplayToken(externalId)),
        transactions: async (query) => read(async (session) => session.transactions(query)),
        end: () => {
          sessions.get(groupKey(group))?.end();
          sessions.delete(groupKey(group));
        },
      };
    },
    signer,
    openedIds: (group) => openedIdsOf(group),
    tracked: () => [...known.values()],
    end: (group) => {
      const key = groupKey(group);
      sessions.get(key)?.end();
      sessions.delete(key);
    },
    endAll: () => {
      for (const session of sessions.values()) {
        session.end();
      }
      sessions.clear();
    },
  };
}
