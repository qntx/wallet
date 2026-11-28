/* oxlint-disable vitest/no-conditional-in-test -- the helpers narrow results for assertions */
/**
 * Gated e2e (ENGINE_E2E_WALLETCONNECT=1 and WALLETCONNECT_PROJECT_ID set): no relay stub — real
 * fetch and WebSocket against the Reown relay. The wallet side is a real Node-kernel engine with
 * the `createWalletConnectClient` handles; the dApp side is a real in-process `SignClient` over its
 * own storage prefix (DISABLE_GLOBAL_CORE keeps the Cores separate — set by the support module
 * before any SDK import). eip155:1 is a local anvil; every other chain RPC stays canned.
 *
 * Coverage: pairing URIs; modern and legacy (requiredNamespaces) proposals; EVM signing over anvil;
 * solana and bip122 namespaces; events and session lifecycle (group switch, chain switch, ping,
 * extend); disconnect both ways; proposal/request/session expiry; relay reconnect; two concurrent
 * sessions; hostile peers (oversized params, unknown methods/chains, replayed ids, hostile
 * metadata); lock/restart persistence; one-click auth.
 */
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base58, base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { address, getSignatureFromTransaction, getTransactionDecoder } from "@solana/kit";
import type { ProposalTypes, SessionTypes } from "@walletconnect/types";
import { getAddress, verifyMessage, verifyTypedData } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { verifyBitcoinMessage, verifyBitcoinPsbtSignatures } from "@qntx/wallet-chains/bitcoin";
import { verifySolanaSignature } from "@qntx/wallet-chains/solana";
import { chains } from "@qntx/wallet/chains";

import type { ConnectionSession } from "../src/connect/controller.ts";
import type { RiskFinding } from "../src/index.ts";
import { walletConnectKey } from "../src/requests/types.ts";
import type { WalletConnectProposal } from "../src/walletconnect/client.ts";
import {
  answerFor,
  approve,
  awaiting,
  BIP84_FIRST,
  BIP86_FIRST,
  BTC_EVENTS,
  BTC_MAIN,
  BTC_METHODS,
  caip10Tail,
  closeDapp,
  dapp,
  DAPP_META,
  DAPP_URL,
  eip155Namespace,
  EVM1,
  EVM_METHODS,
  legacyConnect,
  memoryStorage,
  openWalletConnect,
  pipelineRequest,
  PW,
  RECIP,
  requestValue,
  rig,
  rpcCall,
  sendRaw,
  sendRawRequest,
  SEPOLIA,
  settled,
  SOL_MAIN,
  SOL_METHODS,
  solTx,
  startAnvil,
  TRON_MAIN,
  TRON_METHODS,
  UNAUTHORIZED_UPDATE_REQUEST,
  UNSUPPORTED_CHAINS,
  UNSUPPORTED_METHODS,
  UNSUPPORTED_NAMESPACE_KEY,
  until,
  USER_REJECTED,
  watchTopic,
} from "./support/walletconnect-e2e.ts";
import type { Anvil, Dapp, Rig, WalletClient } from "./support/walletconnect-e2e.ts";

const RUN =
  process.env["ENGINE_E2E_WALLETCONNECT"] === "1" &&
  process.env["WALLETCONNECT_PROJECT_ID"] !== undefined;
const PROJECT_ID = process.env["WALLETCONNECT_PROJECT_ID"] ?? "missing-project-id";

type Namespaces = Parameters<Dapp["connect"]>[0];

const sessionOf = (r: Rig, topic: string): ConnectionSession | undefined =>
  r.engine.connections.session(walletConnectKey(topic));

const dangers = (proposal: WalletConnectProposal): ReadonlyArray<RiskFinding["code"]> =>
  proposal.risk.filter((finding) => finding.level === "danger").map((finding) => finding.code);

/** Connect → pair → proposal in wallet state; the dApp's `approval` left for the caller. */
const proposed = async (
  w: WalletClient,
  client: Dapp,
  namespaces: Namespaces,
): Promise<{
  proposal: WalletConnectProposal;
  approval: () => Promise<SessionTypes.Struct>;
  uri: string;
}> => {
  const { uri, approval } = await client.connect(namespaces);
  if (uri === undefined) {
    throw new Error("connect produced no uri");
  }
  await w.wc.pair(uri);
  await until(() => Object.keys(w.wc.getState().proposals).length === 1);
  const [proposal] = Object.values(w.wc.getState().proposals);
  if (proposal === undefined) {
    throw new Error("no proposal in state");
  }
  const settle = approval();
  settle.catch(() => undefined);
  return { proposal, approval: async () => settle, uri };
};

/** Propose → approve → settled session on both sides. */
const established = async (
  w: WalletClient,
  client: Dapp,
  namespaces: Namespaces,
  grant?: ReadonlyArray<string>,
): Promise<{
  session: ConnectionSession;
  live: SessionTypes.Struct;
}> => {
  const { proposal, approval } = await proposed(w, client, namespaces);
  const session = await w.wc.approve(proposal.id, {
    networks: grant ?? [...proposal.networks],
    acknowledged: dangers(proposal),
  });
  const live = await approval();
  return { session, live };
};

const accountOf = (session: ConnectionSession, network: string): string => {
  const scope = session.scopes[network];
  const [account] = scope?.accounts ?? [];
  if (account === undefined) {
    throw new Error(`no account for ${network}`);
  }
  return caip10Tail(account);
};

describe.runIf(RUN)("walletconnect e2e: real relay", () => {
  let anvil: Anvil;
  beforeAll(async () => {
    anvil = await startAnvil();
  }, 60_000);

  afterAll(() => {
    anvil?.stop();
  });

  it("pairs by URI, refuses a duplicate pair and a garbage URI", { timeout: 180_000 }, async () => {
    const r = await rig(anvil.url);
    const w = await openWalletConnect(r, PROJECT_ID, r.storage);
    const client = await dapp(PROJECT_ID);
    try {
      const { uri, approval } = await client.connect({
        optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
      });
      if (uri === undefined) {
        throw new Error("connect produced no uri");
      }
      const settled_ = approval();
      settled_.catch(() => undefined);
      await w.wc.pair(uri);
      await until(() => Object.keys(w.wc.getState().proposals).length === 1);
      const [proposal] = Object.values(w.wc.getState().proposals);
      if (proposal === undefined) {
        throw new Error("no proposal in state");
      }
      expect(proposal.peer).toMatchObject({ name: "e2e dapp", url: DAPP_URL });

      await expect(w.wc.pair(uri)).rejects.toMatchObject({ code: "duplicate-pairing" });
      await expect(w.wc.pair("garbage")).rejects.toMatchObject({ code: "invalid-uri" });
      await expect(w.wc.pair("wc:xyz@2?relay-protocol=irn&symKey=zz")).rejects.toMatchObject({
        code: "invalid-uri",
      });
      await w.wc.reject(proposal.id);
      await expect(settled_).rejects.toMatchObject({ code: USER_REJECTED });
    } finally {
      await closeDapp(client);
      await w.dispose();
    }
  });

  it(
    "judges modern and legacy proposals, grants subsets, refuses unservable required",
    { timeout: 180_000 },
    async () => {
      const r = await rig(anvil.url);
      const w = await openWalletConnect(r, PROJECT_ID, r.storage);
      const client = await dapp(PROJECT_ID);
      try {
        // Modern dApp: optional-only, four namespaces + tron — the tron row does not exist, so the
        // offer lists every servable chain and no tron chain.
        const { proposal, approval } = await proposed(w, client, {
          optionalNamespaces: {
            eip155: eip155Namespace([EVM1, SEPOLIA]),
            solana: { chains: [SOL_MAIN], methods: SOL_METHODS, events: ["accountsChanged"] },
            bip122: { chains: [BTC_MAIN], methods: BTC_METHODS, events: BTC_EVENTS },
            tron: { chains: [TRON_MAIN], methods: TRON_METHODS, events: [] },
          },
        });
        expect(proposal.networks).not.toContain(TRON_MAIN);
        expect([...proposal.networks].toSorted()).toStrictEqual(
          [EVM1, SEPOLIA, SOL_MAIN, BTC_MAIN].toSorted(),
        );
        expect(proposal.required).toStrictEqual([]);
        const session = await w.wc.approve(proposal.id, {
          networks: [EVM1, SOL_MAIN, BTC_MAIN],
          acknowledged: dangers(proposal),
        });
        const live = await approval();
        expect(Object.keys(live.namespaces).toSorted()).toStrictEqual(
          ["bip122", "eip155", "solana"].toSorted(),
        );
        expect(live.namespaces["eip155"]?.chains).toStrictEqual([EVM1]);
        const evmAccount = accountOf(session, EVM1);
        const solAccount = accountOf(session, SOL_MAIN);
        expect(live.namespaces["eip155"]?.accounts).toStrictEqual([`${EVM1}:${evmAccount}`]);
        expect(live.namespaces["solana"]?.accounts).toStrictEqual([`${SOL_MAIN}:${solAccount}`]);
        expect(live.namespaces["bip122"]?.accounts).toStrictEqual([`${BTC_MAIN}:${BIP84_FIRST}`]);

        // Legacy dApp: required eip155+solana+bip122 with optional sepolia.
        const legacy = await legacyConnect(client, {
          requiredNamespaces: {
            eip155: eip155Namespace([EVM1]),
            solana: { chains: [SOL_MAIN], methods: SOL_METHODS, events: [] },
            bip122: { chains: [BTC_MAIN], methods: BTC_METHODS, events: [] },
          },
          optionalNamespaces: { eip155: eip155Namespace([SEPOLIA]) },
        });
        if (legacy.uri === undefined) {
          throw new Error("connect produced no uri");
        }
        const legacySettled = legacy.approval();
        legacySettled.catch(() => undefined);
        await w.wc.pair(legacy.uri);
        await until(() => Object.keys(w.wc.getState().proposals).length === 1);
        const [legacyProposal] = Object.values(w.wc.getState().proposals);
        if (legacyProposal === undefined) {
          throw new Error("no legacy proposal");
        }
        expect([...legacyProposal.required].toSorted()).toStrictEqual(
          [EVM1, SOL_MAIN, BTC_MAIN].toSorted(),
        );
        await expect(
          w.wc.approve(legacyProposal.id, { networks: [SOL_MAIN, BTC_MAIN, SEPOLIA] }),
        ).rejects.toMatchObject({ code: "invalid-grant" });
        const legacySession = await w.wc.approve(legacyProposal.id, {
          networks: [...legacyProposal.networks],
          acknowledged: dangers(legacyProposal),
        });
        const legacyLive = await legacySettled;
        expect(legacyLive.namespaces["eip155"]?.chains?.toSorted()).toStrictEqual(
          [EVM1, SEPOLIA].toSorted(),
        );
        expect(legacySession.origin).toMatchObject({
          kind: "walletconnect",
          topic: legacyLive.topic,
          origin: walletConnectKey(legacyLive.topic),
        });
        expect(sessionOf(r, legacyLive.topic)).toBeDefined();

        // Required namespaces the wallet cannot serve are refused on the wire — never shown.
        const refusedCases: Array<[ProposalTypes.Struct["requiredNamespaces"], number]> = [
          [
            { tron: { chains: [TRON_MAIN], methods: [...TRON_METHODS], events: [] } },
            UNSUPPORTED_NAMESPACE_KEY,
          ],
          [{ eip155: eip155Namespace(["eip155:999999"]) }, UNSUPPORTED_CHAINS],
          [{ eip155: eip155Namespace([EVM1], [...EVM_METHODS, "eth_sign"]) }, UNSUPPORTED_METHODS],
        ];
        for (const [required, code] of refusedCases) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- refusals run in order
          const refused = await legacyConnect(client, {
            requiredNamespaces: required,
            optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
          });
          if (refused.uri === undefined) {
            throw new Error("connect produced no uri");
          }
          const refusedSettled = refused.approval();
          // oxlint-disable-next-line eslint/no-await-in-loop -- refusals run in order
          await w.wc.pair(refused.uri);
          // oxlint-disable-next-line eslint/no-await-in-loop -- refusals run in order
          await expect(refusedSettled).rejects.toMatchObject({ code });
          expect(w.wc.getState().proposals).toStrictEqual({});
        }

        // A proposal carrying `authentication`: our client does not read proposal.requests — the
        // session settles anyway and the dApp's session.authentication stays empty.
        const { proposal: authProposal, approval: authApproval } = await proposed(w, client, {
          optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
          authentication: [
            {
              domain: "dapp.example",
              chains: [EVM1],
              nonce: "e2e-auth-nonce",
              uri: DAPP_URL,
              ttl: 300,
            },
          ],
        });
        await w.wc.approve(authProposal.id, {
          networks: [...authProposal.networks],
          acknowledged: dangers(authProposal),
        });
        const authLive = await authApproval();
        // Our client does not answer proposal.requests — the session settles without auths.
        expect(authLive.authentication).toBeUndefined();
      } finally {
        await closeDapp(client);
        await w.dispose();
      }
    },
  );

  it(
    "answers EVM signing and send requests through the pipeline over anvil",
    {
      timeout: 180_000,
    },
    async () => {
      const r = await rig(anvil.url);
      const w = await openWalletConnect(r, PROJECT_ID, r.storage);
      const client = await dapp(PROJECT_ID);
      try {
        const { session, live } = await established(w, client, {
          optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
        });
        const from = getAddress(accountOf(session, EVM1));
        await rpcCall(anvil.url, "anvil_setBalance", [from, "0xde0b6b3a7640000"]);

        const message = `0x${Buffer.from("hello e2e").toString("hex")}`;
        const personal = settled(
          client.request({
            topic: live.topic,
            chainId: EVM1,
            request: { method: "personal_sign", params: [message, from] },
          }),
        );
        let pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const signature = requestValue(await personal) as `0x${string}`;
        await expect(
          verifyMessage({ address: from, message: "hello e2e", signature }),
        ).resolves.toBe(true);

        const typedData = {
          types: {
            EIP712Domain: [
              { name: "name", type: "string" },
              { name: "version", type: "string" },
              { name: "chainId", type: "uint256" },
            ],
            Mail: [
              { name: "from", type: "address" },
              { name: "text", type: "string" },
            ],
          },
          primaryType: "Mail",
          domain: { name: "E2E", version: "1", chainId: 1 },
          message: { from, text: "hi" },
        } as const;
        const typed = settled(
          client.request({
            topic: live.topic,
            chainId: EVM1,
            request: { method: "eth_signTypedData_v4", params: [from, JSON.stringify(typedData)] },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const typedSig = requestValue(await typed) as `0x${string}`;
        await expect(
          verifyTypedData({
            address: from,
            domain: { ...typedData.domain, chainId: BigInt(typedData.domain.chainId) },
            types: typedData.types,
            primaryType: typedData.primaryType,
            message: typedData.message,
            signature: typedSig,
          }),
        ).resolves.toBe(true);

        const to = "0x2222222222222222222222222222222222222222";
        const send = settled(
          client.request({
            topic: live.topic,
            chainId: EVM1,
            request: { method: "eth_sendTransaction", params: [{ from, to, value: "0x1" }] },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const hash = requestValue(await send) as string;
        expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
        const receipt = (await rpcCall(anvil.url, "eth_getTransactionReceipt", [hash])) as {
          status: string;
          from: string;
          to: string;
        } | null;
        expect(receipt?.status).toBe("0x1");
        expect(receipt?.from?.toLowerCase()).toBe(from.toLowerCase());
        expect(receipt?.to?.toLowerCase()).toBe(to);
        const sentTx = (await rpcCall(anvil.url, "eth_getTransactionByHash", [hash])) as {
          value: string;
        } | null;
        expect(sentTx?.value).toBe("0x1");

        const rejected = settled(
          client.request({
            topic: live.topic,
            chainId: EVM1,
            request: {
              method: "personal_sign",
              params: [`0x${Buffer.from("reject me").toString("hex")}`, from],
            },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        r.engine.requests.reject(pending.id);
        await expect(rejected).resolves.toMatchObject({ error: { code: USER_REJECTED } });
      } finally {
        await closeDapp(client);
        await w.dispose();
      }
    },
  );

  it(
    "serves the solana and bip122 namespaces and never admits tron",
    { timeout: 180_000 },
    async () => {
      const r = await rig(anvil.url);
      const w = await openWalletConnect(r, PROJECT_ID, r.storage);
      const client = await dapp(PROJECT_ID);
      try {
        const { session, live } = await established(w, client, {
          optionalNamespaces: {
            solana: { chains: [SOL_MAIN], methods: SOL_METHODS, events: ["accountsChanged"] },
            bip122: { chains: [BTC_MAIN], methods: BTC_METHODS, events: BTC_EVENTS },
            tron: { chains: [TRON_MAIN], methods: TRON_METHODS, events: [] },
          },
        });
        // No tron namespace ever settles — the wallet has no tron row.
        expect(live.namespaces["tron"]).toBeUndefined();
        expect(Object.keys(live.namespaces).toSorted()).toStrictEqual(["bip122", "solana"]);
        const solAccount = accountOf(session, SOL_MAIN);
        watchTopic(client, live.topic);

        const solText = utf8ToBytes("hello solana");
        const solSign = settled(
          client.request({
            topic: live.topic,
            chainId: SOL_MAIN,
            request: {
              method: "solana_signMessage",
              params: { message: base58.encode(solText), pubkey: solAccount },
            },
          }),
        );
        let pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const solResult = requestValue(await solSign) as { signature: string };
        expect(verifySolanaSignature(solText, base58.decode(solResult.signature), solAccount)).toBe(
          true,
        );

        const solSignTx = settled(
          client.request({
            topic: live.topic,
            chainId: SOL_MAIN,
            request: {
              method: "solana_signTransaction",
              params: { transaction: base64.encode(solTx(solAccount)), pubkey: solAccount },
            },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const signedTx = requestValue(await solSignTx) as {
          signature: string;
          transaction: string;
        };
        const decoded = getTransactionDecoder().decode(base64.decode(signedTx.transaction));
        const ours = decoded.signatures[address(solAccount)];
        expect(ours === null || ours === undefined).toBe(false);
        expect(base58.encode(new Uint8Array(ours ?? []))).toBe(signedTx.signature);
        expect(
          verifySolanaSignature(
            new Uint8Array(decoded.messageBytes),
            new Uint8Array(ours ?? []),
            solAccount,
          ),
        ).toBe(true);

        const txs = [solTx(solAccount), solTx(solAccount)];
        const signAll = settled(
          client.request({
            topic: live.topic,
            chainId: SOL_MAIN,
            request: {
              method: "solana_signAllTransactions",
              params: { transactions: txs.map((tx) => base64.encode(tx)) },
            },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const allResult = requestValue(await signAll) as { transactions: string[] };
        expect(allResult.transactions).toHaveLength(2);
        for (const encoded of allResult.transactions) {
          const item = getTransactionDecoder().decode(base64.decode(encoded));
          expect(
            item.signatures[address(solAccount)] === null ||
              item.signatures[address(solAccount)] === undefined,
          ).toBe(false);
        }

        const signSend = settled(
          client.request({
            topic: live.topic,
            chainId: SOL_MAIN,
            request: {
              method: "solana_signAndSendTransaction",
              params: { transaction: base64.encode(solTx(solAccount)), pubkey: solAccount },
            },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const sent = requestValue(await signSend) as { signature: string };
        const [wire] = r.world.solanaWires;
        if (wire === undefined) {
          throw new Error("no transaction reached the canned RPC endpoint");
        }
        expect(sent.signature).toBe(
          getSignatureFromTransaction(getTransactionDecoder().decode(wire)),
        );

        const addresses = await client.request<
          ReadonlyArray<{ address: string; publicKey: string; intention: string }>
        >({
          topic: live.topic,
          chainId: BTC_MAIN,
          request: { method: "getAccountAddresses", params: { account: BIP84_FIRST } },
        });
        expect(addresses.map((a) => a.intention)).toStrictEqual(["payment", "ordinal"]);
        expect(addresses.map((a) => a.address)).toStrictEqual([BIP84_FIRST, BIP86_FIRST]);

        const btcSign = settled(
          client.request({
            topic: live.topic,
            chainId: BTC_MAIN,
            request: {
              method: "signMessage",
              params: { account: BIP84_FIRST, message: "hello bitcoin", protocol: "bip322" },
            },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const btcResult = requestValue(await btcSign) as { address: string; signature: string };
        expect(btcResult.address).toBe(BIP84_FIRST);
        expect(
          verifyBitcoinMessage(
            BIP84_FIRST,
            "hello bitcoin",
            `smp${Buffer.from(hex.decode(btcResult.signature)).toString("base64")}`,
            BTC_MAIN,
          ),
        ).toBe(true);

        const psbt = r.world.dappPsbt({ from: BIP84_FIRST, to: RECIP, value: 100_000n });
        const signPsbt = settled(
          client.request({
            topic: live.topic,
            chainId: BTC_MAIN,
            request: {
              method: "signPsbt",
              params: {
                account: BIP84_FIRST,
                psbt: base64.encode(psbt),
                signInputs: [{ address: BIP84_FIRST, index: 0 }],
              },
            },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const psbtResult = requestValue(await signPsbt) as { psbt: string };
        const account = await chains(r.wallet).account({
          walletId: r.walletId,
          groupIndex: 0,
          template: "btc.bip84",
          network: BTC_MAIN,
        });
        const xpub = "xpub" in account ? (account.xpub ?? "") : "";
        expect(
          verifyBitcoinPsbtSignatures(
            base64.decode(psbtResult.psbt),
            [0],
            xpub,
            "btc.bip84",
            BTC_MAIN,
          ),
        ).toBe(true);

        r.world.fundPrev(BIP84_FIRST, 100_000n);
        const transfer = settled(
          client.request({
            topic: live.topic,
            chainId: BTC_MAIN,
            request: {
              method: "sendTransfer",
              params: { account: BIP84_FIRST, recipientAddress: RECIP, amount: "25000" },
            },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const sentBtc = requestValue(await transfer) as { txid: string };
        expect(
          r.world.broadcasts.some(
            (body) => Transaction.fromRaw(hex.decode(body)).id === sentBtc.txid,
          ),
        ).toBe(true);

        // A raw tron_signMessage on the session topic never reaches the pipeline — the session
        // carries no tron chain, so the wallet SDK answers an error itself.
        const tronId = 42_001;
        await sendRawRequest(
          client,
          live.topic,
          tronId,
          "tron_signMessage",
          { address: "Txxx", message: `0x${Buffer.from("hi").toString("hex")}` },
          TRON_MAIN,
        );
        const tronAnswer = await answerFor(client, live.topic, tronId);
        expect(tronAnswer.error).toBeDefined();
        expect(awaiting(r)).toHaveLength(0);
      } finally {
        await closeDapp(client);
        await w.dispose();
      }
    },
  );

  it(
    "drives session events, chain switching, pings and extension; ignores a hostile update",
    { timeout: 180_000 },
    async () => {
      const r = await rig(anvil.url);
      const w = await openWalletConnect(r, PROJECT_ID, r.storage);
      const client = await dapp(PROJECT_ID);
      try {
        const events: Array<{ name: string; chainId: string; data: unknown }> = [];
        const updates: SessionTypes.Namespaces[] = [];
        const extended: Array<{ id: number; topic: string }> = [];
        client.on("session_event", (event) => {
          events.push({
            name: event.params.event.name,
            chainId: event.params.chainId,
            data: event.params.event.data,
          });
        });
        client.on("session_update", (event) => {
          updates.push(event.params.namespaces);
        });
        client.on("session_extend", (event) => {
          extended.push({ id: event.id, topic: event.topic });
        });
        const { live } = await established(w, client, {
          optionalNamespaces: {
            eip155: eip155Namespace([EVM1, SEPOLIA]),
            solana: { chains: [SOL_MAIN], methods: SOL_METHODS, events: ["accountsChanged"] },
            bip122: { chains: [BTC_MAIN], methods: BTC_METHODS, events: BTC_EVENTS },
          },
        });
        watchTopic(client, live.topic);
        const expiryBefore = live.expiry;

        // Group switch: session_update plus accountsChanged on every chain (+ bip122's own event).
        const group = r.engine.accounts.addGroup(r.walletId);
        r.engine.accounts.select(r.walletId, group);
        await until(() =>
          [EVM1, SEPOLIA, SOL_MAIN, BTC_MAIN].every((chainId) =>
            events.some((e) => e.name === "accountsChanged" && e.chainId === chainId),
          ),
        );
        await until(() =>
          events.some((e) => e.name === "bip122_addressesChanged" && e.chainId === BTC_MAIN),
        );
        await until(() => updates.length > 0);
        const moved = updates.at(-1);
        const movedEvm = caip10Tail(moved?.["eip155"]?.accounts[0] ?? "");
        expect(movedEvm.startsWith("0x")).toBe(true);
        expect(moved?.["eip155"]?.chains?.toSorted()).toStrictEqual([EVM1, SEPOLIA].toSorted());

        // The dApp asks the wallet to switch eip155:1 → eip155:11155111; chainChanged follows.
        await client.request({
          topic: live.topic,
          chainId: EVM1,
          request: { method: "wallet_switchEthereumChain", params: [{ chainId: "0xaa36a7" }] },
        });
        await until(() => events.some((e) => e.name === "chainChanged"));
        const chainChanged = events.find((e) => e.name === "chainChanged");
        expect(chainChanged?.data).toBe(11_155_111);
        expect(chainChanged?.chainId).toBe(SEPOLIA);

        // Both directions of session ping, plus a pairing ping, resolve on the real relay.
        await client.ping({ topic: live.topic });
        await w.kit.engine.signClient.ping({ topic: live.topic });
        await client.core.pairing.ping({ topic: live.pairingTopic });

        // Wallet clock +2 days: the session is within the extension window, so the next reconcile
        // extends it — the dApp sees session_extend with a later expiry.
        r.clock.shift(2 * 24 * 60 * 60 * 1000);
        r.engine.accounts.select(r.walletId, 0);
        await until(() => extended.some((e) => e.topic === live.topic));
        await until(() => updates.length >= 2);
        const extendedSession = client.session.get(live.topic);
        expect(extendedSession.expiry).toBeGreaterThanOrEqual(expiryBefore);

        // A wc_sessionUpdate from the non-controller dApp must change nothing on the wallet.
        const updateId = 43_001;
        await sendRaw(
          client,
          live.topic,
          updateId,
          "wc_sessionUpdate",
          { namespaces: live.namespaces },
          1104,
        );
        const updateAnswer = await answerFor(client, live.topic, updateId);
        // A non-controller peer's update is refused with 3003 (unauthorized update request).
        expect(updateAnswer.error?.code).toBe(UNAUTHORIZED_UPDATE_REQUEST);
        const liveNow = w.kit.getActiveSessions()[live.topic];
        expect(liveNow?.namespaces).toStrictEqual(updates.at(-1));
        const scopes = sessionOf(r, live.topic)?.scopes;
        expect(Object.keys(scopes ?? {}).toSorted()).toStrictEqual(
          [EVM1, SEPOLIA, SOL_MAIN, BTC_MAIN].toSorted(),
        );
      } finally {
        await closeDapp(client);
        await w.dispose();
      }
    },
  );

  it(
    "drops the connection on dApp disconnect and on wallet-side revoke",
    {
      timeout: 180_000,
    },
    async () => {
      const r = await rig(anvil.url);
      const w = await openWalletConnect(r, PROJECT_ID, r.storage);
      const client = await dapp(PROJECT_ID);
      try {
        const { live } = await established(w, client, {
          optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
        });
        const deleted: string[] = [];
        client.on("session_delete", (event) => {
          deleted.push(event.topic);
        });
        const { getSdkError } = await import("@walletconnect/utils");
        await client.disconnect({ topic: live.topic, reason: getSdkError("USER_DISCONNECTED") });
        await until(() => sessionOf(r, live.topic) === undefined);

        const second = await established(w, client, {
          optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
        });
        await r.engine.connections.revoke(walletConnectKey(second.live.topic));
        await until(() => deleted.includes(second.live.topic));
        expect(sessionOf(r, second.live.topic)).toBeUndefined();
      } finally {
        await closeDapp(client);
        await w.dispose();
      }
    },
  );

  it("enforces proposal, request and session expiry", { timeout: 180_000 }, async () => {
    const r = await rig(anvil.url);
    const w = await openWalletConnect(r, PROJECT_ID, r.storage);
    const client = await dapp(PROJECT_ID);
    try {
      // A proposal approved after the wallet clock passed its expiry is refused.
      const first = await proposed(w, client, {
        optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
      });
      r.clock.set(first.proposal.expiresAt + 1000);
      await expect(
        w.wc.approve(first.proposal.id, { networks: [...first.proposal.networks] }),
      ).rejects.toMatchObject({ code: "expired" });
      expect(w.wc.getState().proposals).toStrictEqual({});
      r.clock.set(0);

      // A proposal the wallet's expirer drops leaves the state without ever being approved.
      const second = await proposed(w, client, {
        optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
      });
      w.core.expirer.set(second.proposal.id, Math.floor(Date.now() / 1000) - 10);
      await until(() => Object.keys(w.wc.getState().proposals).length === 0);

      // A request expired under the wallet's clock is answered 4100 — never dispatched.
      const { session, live } = await established(w, client, {
        optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
      });
      watchTopic(client, live.topic);
      const from = getAddress(accountOf(session, EVM1));
      const expiryTimestamp = Math.floor(Date.now() / 1000) + 300;
      r.clock.shift(400_000);
      const expiredId = 44_001;
      await sendRawRequest(
        client,
        live.topic,
        expiredId,
        "personal_sign",
        [`0x${Buffer.from("too late").toString("hex")}`, from],
        EVM1,
        expiryTimestamp,
      );
      const expiredAnswer = await answerFor(client, live.topic, expiredId);
      expect(expiredAnswer.error?.code).toBe(4100);
      expect(awaiting(r)).toHaveLength(0);
      r.clock.set(0);

      // A session the wallet's expirer drops is revoked engine-side. The dApp sees no
      // session_delete: the expired session's key is gone, so nothing can be published.
      const deleted: string[] = [];
      client.on("session_delete", (event) => {
        deleted.push(event.topic);
      });
      w.core.expirer.set(live.topic, Math.floor(Date.now() / 1000) - 10);
      await until(() => sessionOf(r, live.topic) === undefined);
      await new Promise((resolve) => setTimeout(resolve, 5000));
      expect(deleted).toHaveLength(0);
    } finally {
      await closeDapp(client);
      await w.dispose();
    }
  });

  it("survives a dropped relay socket on either side", { timeout: 180_000 }, async () => {
    const r = await rig(anvil.url);
    const w = await openWalletConnect(r, PROJECT_ID, r.storage);
    const client = await dapp(PROJECT_ID);
    try {
      const { session, live } = await established(w, client, {
        optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
      });
      const from = getAddress(accountOf(session, EVM1));

      const socketOf = (relayer: unknown): { terminate?: () => void; close?: () => void } => {
        const socket = (relayer as { provider?: { connection?: { socket?: unknown } } }).provider
          ?.connection?.socket;
        if (socket === undefined || socket === null) {
          throw new Error("no relay socket to drop");
        }
        return socket;
      };

      // The wallet's socket dies mid-session: the relay buffers the next request until the
      // relayer reconnects and resubscribes.
      socketOf(w.core.relayer).terminate?.();
      const afterDrop = settled(
        client.request({
          topic: live.topic,
          chainId: EVM1,
          request: {
            method: "personal_sign",
            params: [`0x${Buffer.from("after socket drop").toString("hex")}`, from],
          },
        }),
      );
      let pending = await pipelineRequest(r, live.topic, DAPP_URL, 90_000);
      await approve(r, pending);
      expect(requestValue(await afterDrop)).toBeTypeOf("string");

      // The dApp's socket dies the same way; the wallet's answer waits for its reconnect.
      socketOf(client.core.relayer).terminate?.();
      const afterDappDrop = settled(
        client.request({
          topic: live.topic,
          chainId: EVM1,
          request: {
            method: "personal_sign",
            params: [`0x${Buffer.from("after dapp socket drop").toString("hex")}`, from],
          },
        }),
      );
      pending = await pipelineRequest(r, live.topic, DAPP_URL, 90_000);
      await approve(r, pending);
      expect(requestValue(await afterDappDrop)).toBeTypeOf("string");
    } finally {
      await closeDapp(client);
      await w.dispose();
    }
  });

  it(
    "keeps two concurrent sessions' pipelines and origins distinct",
    {
      timeout: 180_000,
    },
    async () => {
      const r = await rig(anvil.url);
      const w = await openWalletConnect(r, PROJECT_ID, r.storage);
      const dappA = await dapp(PROJECT_ID, {
        metadata: { ...DAPP_META, url: "https://dapp-a.example" },
        prefix: "dapp-a",
      });
      const dappB = await dapp(PROJECT_ID, {
        metadata: { ...DAPP_META, url: "https://dapp-b.example" },
        prefix: "dapp-b",
      });
      try {
        const a = await established(w, dappA, {
          optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
        });
        const b = await established(w, dappB, {
          optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
        });
        const accountA = getAddress(accountOf(a.session, EVM1));
        const accountB = getAddress(accountOf(b.session, EVM1));

        const reqA = settled(
          dappA.request({
            topic: a.live.topic,
            chainId: EVM1,
            request: {
              method: "personal_sign",
              params: [`0x${Buffer.from("sign for A").toString("hex")}`, accountA],
            },
          }),
        );
        const reqB = settled(
          dappB.request({
            topic: b.live.topic,
            chainId: EVM1,
            request: {
              method: "personal_sign",
              params: [`0x${Buffer.from("sign for B").toString("hex")}`, accountB],
            },
          }),
        );
        await until(() => awaiting(r).length === 2, 60_000);
        const requestB = awaiting(r).find(
          (request) =>
            request.origin.kind === "walletconnect" && request.origin.topic === b.live.topic,
        );
        const requestA = awaiting(r).find(
          (request) =>
            request.origin.kind === "walletconnect" && request.origin.topic === a.live.topic,
        );
        if (requestA === undefined || requestB === undefined) {
          throw new Error("expected one pending request per session");
        }
        expect(requestA.origin).toMatchObject({
          kind: "walletconnect",
          topic: a.live.topic,
          origin: walletConnectKey(a.live.topic),
          url: "https://dapp-a.example",
        });
        expect(requestB.origin).toMatchObject({
          kind: "walletconnect",
          topic: b.live.topic,
          origin: walletConnectKey(b.live.topic),
          url: "https://dapp-b.example",
        });
        // Approve B before A — each dApp still gets its own correct signature.
        await approve(r, requestB);
        const sigB = requestValue(await reqB) as `0x${string}`;
        await expect(
          verifyMessage({ address: accountB, message: "sign for B", signature: sigB }),
        ).resolves.toBe(true);
        await approve(r, requestA);
        const sigA = requestValue(await reqA) as `0x${string}`;
        await expect(
          verifyMessage({ address: accountA, message: "sign for A", signature: sigA }),
        ).resolves.toBe(true);
      } finally {
        await closeDapp(dappA);
        await closeDapp(dappB);
        await w.dispose();
      }
    },
  );

  it(
    "refuses oversized, foreign and replayed traffic before the pipeline",
    { timeout: 180_000 },
    async () => {
      const r = await rig(anvil.url);
      let w = await openWalletConnect(r, PROJECT_ID, r.storage);
      const client = await dapp(PROJECT_ID);
      try {
        const { session, live } = await established(w, client, {
          optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
        });
        const from = getAddress(accountOf(session, EVM1));
        watchTopic(client, live.topic);

        // >128 KiB of params: MAX_MESSAGE_BYTES. The relay delivers it — the wallet refuses it
        // with -32005 before the pipeline.
        const huge = `0x${"aa".repeat(140 * 1024)}`;
        await sendRawRequest(client, live.topic, 50_001, "personal_sign", [huge, from], EVM1);
        const hugeAnswer = await answerFor(client, live.topic, 50_001, 30_000);
        expect(hugeAnswer.error?.code).toBe(-32_005);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        expect(awaiting(r)).toHaveLength(0);

        // Method not in the session, chain not in the session — the SDK answers, no pipeline.
        await sendRawRequest(client, live.topic, 50_002, "eth_sign", ["0x00", from], EVM1);
        await sendRawRequest(
          client,
          live.topic,
          50_003,
          "personal_sign",
          ["0x00", from],
          "eip155:137",
        );
        const [badMethod, badChain] = await Promise.all([
          answerFor(client, live.topic, 50_002),
          answerFor(client, live.topic, 50_003),
        ]);
        expect(badMethod.error).toBeDefined();
        expect(badChain.error).toBeDefined();
        expect(awaiting(r)).toHaveLength(0);

        // An account the session never granted: 4100.
        await sendRawRequest(
          client,
          live.topic,
          50_004,
          "personal_sign",
          [
            `0x${Buffer.from("forged").toString("hex")}`,
            "0x9999999999999999999999999999999999999999",
          ],
          EVM1,
        );
        const forged = await answerFor(client, live.topic, 50_004);
        expect(forged.error?.code).toBe(4100);
        expect(awaiting(r)).toHaveLength(0);

        // Hostile metadata: a javascript: url is refused outright; oversized/suspicious fields are
        // sanitized in proposal.peer.
        const evil = await dapp(PROJECT_ID, {
          // oxlint-disable-next-line eslint/no-script-url -- deliberately hostile metadata
          metadata: { ...DAPP_META, url: "javascript:alert(1)" },
          prefix: "dapp-evil",
        });
        try {
          const { uri, approval } = await evil.connect({
            optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
          });
          const evilSettled = approval();
          if (uri === undefined) {
            throw new Error("connect produced no uri");
          }
          await w.wc.pair(uri);
          await expect(evilSettled).rejects.toMatchObject({ code: USER_REJECTED });
          expect(w.wc.getState().proposals).toStrictEqual({});
        } finally {
          await closeDapp(evil);
        }
        const loud = await dapp(PROJECT_ID, {
          metadata: {
            name: `x${"a".repeat(5000)}`,
            description: `y${"b".repeat(5000)}`,
            url: "https://loud.example",
            icons: [
              // oxlint-disable-next-line eslint/no-script-url -- deliberately hostile metadata
              "javascript:alert(1)",
              "http://insecure.example/icon.png",
              "https://loud.example/1.png",
              "https://loud.example/2.png",
              "https://loud.example/3.png",
              "https://loud.example/4.png",
              "https://loud.example/5.png",
            ],
          },
          prefix: "dapp-loud",
        });
        try {
          const { proposal } = await proposed(w, loud, {
            optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
          });
          expect(proposal.peer.url).toBe("https://loud.example");
          // A name over the display limit falls back to the peer's host.
          expect(proposal.peer.name).toBe("loud.example");
          expect(proposal.peer.description).toBe("");
          expect(proposal.peer.icons).toStrictEqual([
            "https://loud.example/1.png",
            "https://loud.example/2.png",
            "https://loud.example/3.png",
            "https://loud.example/4.png",
          ]);
          await w.wc.reject(proposal.id);
        } finally {
          await closeDapp(loud);
        }

        // Replayed request ids: one pipeline request, one answer — then none after the answer.
        const replayId = 50_010;
        const replayMessage = `0x${Buffer.from("replay me").toString("hex")}`;
        await sendRawRequest(
          client,
          live.topic,
          replayId,
          "personal_sign",
          [replayMessage, from],
          EVM1,
        );
        await sendRawRequest(
          client,
          live.topic,
          replayId,
          "personal_sign",
          [replayMessage, from],
          EVM1,
        );
        const replayPending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, replayPending);
        const replayAnswer = await answerFor(client, live.topic, replayId);
        expect(replayAnswer.result).toBeTypeOf("string");
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(awaiting(r)).toHaveLength(0);
        await sendRawRequest(
          client,
          live.topic,
          replayId,
          "personal_sign",
          [replayMessage, from],
          EVM1,
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
        expect(awaiting(r)).toHaveLength(0);

        // Across a wallet-side restart the replayed id must not re-prompt.
        await w.dispose();
        w = await openWalletConnect(r, PROJECT_ID, r.storage);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        expect(awaiting(r)).toHaveLength(0);
      } finally {
        await closeDapp(client);
        await w.dispose();
      }
    },
  );

  it(
    "persists sessions and queued work across lock and restart",
    { timeout: 180_000 },
    async () => {
      const r = await rig(anvil.url);
      let w = await openWalletConnect(r, PROJECT_ID, r.storage);
      const dappStorage = memoryStorage();
      let client = await dapp(PROJECT_ID, { storage: dappStorage, prefix: "dapp-restart" });
      try {
        const { session, live } = await established(w, client, {
          optionalNamespaces: { eip155: eip155Namespace([EVM1]) },
        });
        const from = getAddress(accountOf(session, EVM1));

        // A request queued while the vault is locked is served after unlock.
        await r.wallet.vault.lock();
        await until(() => !r.engine.connections.getState().ready);
        const lockedCall = settled(
          client.request({
            topic: live.topic,
            chainId: EVM1,
            request: {
              method: "personal_sign",
              params: [`0x${Buffer.from("queued while locked").toString("hex")}`, from],
            },
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
        expect(awaiting(r)).toHaveLength(0);
        await r.wallet.vault.unlock(PW);
        await until(() => r.engine.connections.getState().ready);
        let pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        expect(requestValue(await lockedCall)).toBeTypeOf("string");

        // A request in the pipeline while the wallet side restarts is recovered by the recreated
        // client: dispose() voids the open pipeline request and answers nothing, so the SDK's
        // pending store keeps the request and the new instance re-dispatches it.
        const inFlight = settled(
          client.request({
            topic: live.topic,
            chainId: EVM1,
            request: {
              method: "personal_sign",
              params: [`0x${Buffer.from("in flight during restart").toString("hex")}`, from],
            },
          }),
        );
        const inFlightRequest = await pipelineRequest(r, live.topic, DAPP_URL);
        await w.dispose();
        await until(
          () => r.engine.requests.getState().requests[inFlightRequest.id]?.stage === "invalidated",
        );
        w = await openWalletConnect(r, PROJECT_ID, r.storage);
        const recovered = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, recovered);
        const recoveredSig = requestValue(await inFlight) as `0x${string}`;
        await expect(
          verifyMessage({
            address: from,
            message: "in flight during restart",
            signature: recoveredSig,
          }),
        ).resolves.toBe(true);
        expect(sessionOf(r, live.topic)).toBeDefined();

        // A fresh request on the surviving session is served by the recreated client.
        const afterRestart = settled(
          client.request({
            topic: live.topic,
            chainId: EVM1,
            request: {
              method: "personal_sign",
              params: [`0x${Buffer.from("post restart").toString("hex")}`, from],
            },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        expect(requestValue(await afterRestart)).toBeTypeOf("string");

        // The dApp side survives its own restart over the same storage/prefix.
        await closeDapp(client);
        client = await dapp(PROJECT_ID, { storage: dappStorage, prefix: "dapp-restart" });
        expect(client.session.get(live.topic)?.topic).toBe(live.topic);
        const dappRestarted = settled(
          client.request({
            topic: live.topic,
            chainId: EVM1,
            request: {
              method: "personal_sign",
              params: [`0x${Buffer.from("dapp restarted").toString("hex")}`, from],
            },
          }),
        );
        pending = await pipelineRequest(r, live.topic, DAPP_URL);
        await approve(r, pending);
        const dappRestartedSig = requestValue(await dappRestarted) as `0x${string}`;
        await expect(
          verifyMessage({ address: from, message: "dapp restarted", signature: dappRestartedSig }),
        ).resolves.toBe(true);
      } finally {
        await closeDapp(client);
        await w.dispose();
      }
    },
  );

  it("settles one-click auth into a working session", { timeout: 180_000 }, async () => {
    const r = await rig(anvil.url);
    const w = await openWalletConnect(r, PROJECT_ID, r.storage);
    const client = await dapp(PROJECT_ID);
    try {
      const { uri, response } = await client.authenticate({
        domain: "dapp.example",
        chains: [EVM1],
        nonce: "0123456789abcdef",
        uri: DAPP_URL,
        methods: ["personal_sign"],
      });
      if (uri === undefined) {
        throw new Error("authenticate produced no uri");
      }
      const authSettled = response()
        .then((value) => ({ value }))
        .catch((error: unknown) => ({ error }));
      authSettled.catch(() => undefined);
      const pairingTopic = uri.slice("wc:".length).split("@")[0] ?? "";
      await w.wc.pair(uri);
      const pending = await pipelineRequest(r, pairingTopic, DAPP_URL);
      expect(pending.display).toMatchObject({
        message: { kind: "text", signIn: { status: "valid" } },
      });
      const message = "message" in pending.display ? pending.display.message : undefined;
      if (message?.kind !== "text") {
        throw new Error("the request displays no text message");
      }
      const siweText = message.text;
      await approve(r, pending);
      const outcome = await authSettled;
      if ("error" in outcome) {
        throw new Error(`authenticate failed: ${JSON.stringify(outcome.error)}`);
      }
      const { auths, session } = outcome.value as {
        auths?: ReadonlyArray<{ p: { iss: string }; s: { t: string; s: string } }>;
        session?: SessionTypes.Struct;
      };
      const [cacao] = auths ?? [];
      if (cacao === undefined) {
        throw new Error("no cacao returned");
      }
      const signer = cacao.p.iss.slice(cacao.p.iss.lastIndexOf(":") + 1);
      expect(cacao.s.t).toBe("eip191");
      await expect(
        verifyMessage({
          address: signer as `0x${string}`,
          message: siweText,
          signature: cacao.s.s as `0x${string}`,
        }),
      ).resolves.toBe(true);
      if (session === undefined) {
        throw new Error("no session settled");
      }
      const account = getAddress(signer);
      const serve = settled(
        client.request({
          topic: session.topic,
          chainId: EVM1,
          request: { method: "personal_sign", params: [`0x6869`, account] },
        }),
      );
      const servePending = await pipelineRequest(r, session.topic, DAPP_URL);
      await approve(r, servePending);
      const sig = requestValue(await serve) as `0x${string}`;
      await expect(
        verifyMessage({
          address: account,
          message: { raw: "0x6869" },
          signature: sig,
        }),
      ).resolves.toBe(true);

      // The dApp controls auth sessions — a group switch the session cannot follow ends it
      // rather than attempting an update: the peer deletes, the wallet revokes.
      const deleted: string[] = [];
      client.on("session_delete", (event) => {
        deleted.push(event.topic);
      });
      const group = r.engine.accounts.addGroup(r.walletId);
      r.engine.accounts.select(r.walletId, group);
      await until(() => deleted.includes(session.topic));
      await until(() => sessionOf(r, session.topic) === undefined);
    } finally {
      await closeDapp(client);
      await w.dispose();
    }
  });
});
