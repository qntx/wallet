import { utf8ToBytes } from "@noble/hashes/utils.js";

import type { CardOperation, CardOpResult } from "@qntx/wallet/protocol";

import { CARD_WALLET_KIND } from "../../../vault/store.ts";
import { sealRecord } from "../../../vault/vault.ts";
import type { CardWalletBody } from "../record.ts";
import { encodeCardWalletBody, encodeCardWalletHeader } from "../record.ts";
import type { CardOp } from "../tap.ts";
import type { OpEnv } from "./shared.ts";
import { walletOf } from "./shared.ts";

/** `forget-access` — no tap: reseal the record without `access`; it completes in `card.begin`. */
// oxlint-disable-next-line eslint/require-yield -- the generator shape is the uniform op contract
export async function* forgetAccessOp(
  env: OpEnv,
  op: Extract<CardOperation, { kind: "forget-access" }>,
): CardOp {
  const { header, body } = walletOf(env, op.walletId);
  const stripped: CardWalletBody = {
    master: body.master,
    nodes: body.nodes,
    ed25519: body.ed25519,
    ephemerals: body.ephemerals,
  };
  const { dek } = env.ctx.session.current();
  const record = sealRecord(
    env.ctx.platform,
    dek,
    CARD_WALLET_KIND,
    op.walletId,
    encodeCardWalletHeader(header),
    utf8ToBytes(encodeCardWalletBody(stripped)),
  );
  await env.ctx.commit([{ op: "put-record", record }]);
  return { kind: "forget-access", walletId: op.walletId } satisfies CardOpResult;
}
