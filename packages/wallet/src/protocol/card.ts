import type { ChainAccount, ChainSignRequest, ChainSignResult, ChainTemplate } from "./chains.ts";
import { caip2, chainAccount, signRequest, signResult, template } from "./chains.ts";
import type { MethodSpec, VerifyFactor } from "./core.ts";
import { cardId, groupIndex, verifier, walletId } from "./core.ts";
/**
 * The `card.*` command surface: every operation that drives a qntx card is one long-running kernel
 * operation (`card.begin` returns an op id, `card.step` polls the next step, `card.cancel` aborts).
 * A step asks the host for access-code input or a card tap; `done` carries the operation's result.
 * APDUs and access-code bytes never appear here — they stay inside the kernel/reader boundary.
 */
import type { NullValue, Validator } from "./validate.ts";
import { ValidationError, arr, int, literal, obj, opt, str, union } from "./validate.ts";

export type CardInputPurpose =
  | "access-code"
  | "new-access-code"
  | "confirm-access-code"
  | "short-id";

export type CardTapReason = "any" | "source" | "target" | "member" | "retry";

/** The next thing the host must do for the operation to advance; `done` ends the poll loop. */
export type CardStep =
  | {
      readonly kind: "input";
      readonly purpose: CardInputPurpose;
      /** Short id (`XXXX-XXXX`) of the card the input belongs to, when the op knows it. */
      readonly card?: string;
      /** Access-code tries left, when the card just reported a failure. */
      readonly remaining?: number;
    }
  | {
      readonly kind: "tap";
      readonly reason: CardTapReason;
      /** Short id (`XXXX-XXXX`) of the card to tap, when the op knows it. */
      readonly card?: string;
      /** The response takes seconds; the host must keep the card on the reader. */
      readonly hold?: true;
    }
  | { readonly kind: "done"; readonly result: CardOpResult };

export type CardOperation =
  | { readonly kind: "status" }
  | { readonly kind: "add"; readonly groups?: number }
  | {
      readonly kind: "accounts";
      readonly walletId: string;
      readonly groupIndex: number;
      readonly templates: ReadonlyArray<ChainTemplate>;
      readonly network: string;
    }
  | { readonly kind: "health"; readonly walletId: string }
  | { readonly kind: "change-access"; readonly walletId: string; readonly remember?: true }
  | {
      readonly kind: "erase";
      readonly walletId: string;
      readonly card: string;
      readonly last?: true;
    }
  | {
      readonly kind: "create";
      readonly cards: number;
      readonly source:
        | { readonly kind: "generate" }
        | { readonly kind: "wallet"; readonly walletId: string };
      readonly groups?: number;
      readonly remember?: true;
    }
  | { readonly kind: "transfer"; readonly walletId: string }
  | {
      readonly kind: "reseal";
      readonly walletId: string;
      readonly card: string;
      readonly member?: string;
    }
  | { readonly kind: "sign"; readonly request: ChainSignRequest; readonly remember?: true }
  | { readonly kind: "forget-access"; readonly walletId: string };

export type CardOpResult =
  | {
      readonly kind: "status";
      readonly life: "blank" | "loaded";
      readonly tries: number;
      readonly walletId?: string;
    }
  | { readonly kind: "sign"; readonly result: ChainSignResult }
  | { readonly kind: "accounts"; readonly accounts: ReadonlyArray<ChainAccount> }
  | { readonly kind: "add"; readonly walletId: string }
  | { readonly kind: "health"; readonly walletId: string }
  | { readonly kind: "change-access"; readonly walletId: string }
  | { readonly kind: "erase"; readonly walletId: string }
  | { readonly kind: "create"; readonly walletId: string }
  | { readonly kind: "transfer"; readonly walletId: string }
  | { readonly kind: "reseal"; readonly walletId: string }
  | { readonly kind: "forget-access"; readonly walletId: string };

/** `XXXX-XXXX` — the short id printed on a card and shown in prompts. */
const shortId = str(9, /^[0-9A-F]{4}-[0-9A-F]{4}$/);

const opId = str(32, /^[0-9a-f]{32}$/);

/** Rejects a list whose entries repeat — the protocol requires distinct templates. */
const distinct = <T>(validator: Validator<ReadonlyArray<T>>): Validator<ReadonlyArray<T>> => {
  return (value) => {
    const list = validator(value);
    if (new Set(list).size !== list.length) {
      throw new ValidationError();
    }
    return list;
  };
};

const cardOperation: Validator<CardOperation> = union(
  obj({ kind: literal("status") }),
  obj({ kind: literal("add"), groups: opt(int(1, 20)) }),
  obj({
    kind: literal("accounts"),
    walletId,
    groupIndex,
    templates: distinct(arr(template, 7, 1)),
    network: caip2,
  }),
  obj({ kind: literal("health"), walletId }),
  obj({ kind: literal("change-access"), walletId, remember: opt(literal(true)) }),
  obj({ kind: literal("erase"), walletId, card: cardId, last: opt(literal(true)) }),
  obj({
    kind: literal("create"),
    cards: int(1, 3),
    source: union(obj({ kind: literal("generate") }), obj({ kind: literal("wallet"), walletId })),
    groups: opt(int(1, 20)),
    remember: opt(literal(true)),
  }),
  obj({ kind: literal("transfer"), walletId }),
  obj({ kind: literal("reseal"), walletId, card: cardId, member: opt(cardId) }),
  obj({ kind: literal("sign"), request: signRequest, remember: opt(literal(true)) }),
  obj({ kind: literal("forget-access"), walletId }),
);

const cardOpResult: Validator<CardOpResult> = union(
  obj({
    kind: literal("status"),
    life: union(literal("blank"), literal("loaded")),
    tries: int(0, 10),
    walletId: opt(walletId),
  }),
  obj({ kind: literal("sign"), result: signResult }),
  obj({ kind: literal("accounts"), accounts: arr(chainAccount, 64) }),
  obj({ kind: literal("add"), walletId }),
  obj({ kind: literal("health"), walletId }),
  obj({ kind: literal("change-access"), walletId }),
  obj({ kind: literal("erase"), walletId }),
  obj({ kind: literal("create"), walletId }),
  obj({ kind: literal("transfer"), walletId }),
  obj({ kind: literal("reseal"), walletId }),
  obj({ kind: literal("forget-access"), walletId }),
);

const cardStep: Validator<CardStep> = union(
  obj({
    kind: literal("input"),
    purpose: union(
      literal("access-code"),
      literal("new-access-code"),
      literal("confirm-access-code"),
      literal("short-id"),
    ),
    card: opt(shortId),
    remaining: opt(int(0, 10)),
  }),
  obj({
    kind: literal("tap"),
    reason: union(
      literal("any"),
      literal("source"),
      literal("target"),
      literal("member"),
      literal("retry"),
    ),
    card: opt(shortId),
    hold: opt(literal(true)),
  }),
  obj({ kind: literal("done"), result: cardOpResult }),
);

export type CardBeginParams = { readonly op: CardOperation; readonly verify?: VerifyFactor };
export type CardStepParams = { readonly opId: string };

export const CARD_METHODS: {
  readonly "card.begin": MethodSpec<CardBeginParams, { opId: string; step: CardStep }>;
  readonly "card.step": MethodSpec<CardStepParams, CardStep>;
  readonly "card.cancel": MethodSpec<CardStepParams, NullValue>;
} = {
  "card.begin": {
    session: true,
    presence: true,
    params: obj({ op: cardOperation, verify: opt(verifier) }),
    result: obj({ opId, step: cardStep }),
  },
  "card.step": {
    session: true,
    presence: true,
    params: obj({ opId }),
    result: cardStep,
  },
  "card.cancel": {
    session: true,
    presence: false,
    params: obj({ opId }),
    result: literal(null),
  },
};
