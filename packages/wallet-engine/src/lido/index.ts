/** Lido liquid staking on Ethereum mainnet: read-only position and validator-side helpers. */
import { getAddress, parseAbi } from "viem";
import { readContract } from "viem/actions";

import { LIDO_QUEUE, LIDO_STETH } from "@qntx/wallet-chains/evm";

export const LIDO_QUEUE_ABI = parseAbi([
  "function isPaused() view returns (bool)",
  "function getLastCheckpointIndex() view returns (uint256)",
  "function findCheckpointHints(uint256[] requestIds, uint256 firstIndex, uint256 lastIndex) view returns (uint256[])",
  "function getWithdrawalRequests(address owner) view returns (uint256[])",
  "function getWithdrawalStatus(uint256[] requestIds) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[])",
  "function getClaimableEther(uint256[] requestIds, uint256[] hints) view returns (uint256[])",
  "function requestWithdrawals(uint256[] amounts, address owner)",
  "function claimWithdrawals(uint256[] requestIds, uint256[] hints)",
]);

export const LIDO_STETH_ABI = parseAbi([
  "function isStakingPaused() view returns (bool)",
  "function getCurrentStakeLimit() view returns (uint256)",
  "function submit(address referral) payable",
  "function balanceOf(address account) view returns (uint256)",
]);

/* The queue bounds each withdrawal request: ≤ 1000 ETH per id, ≥ 100 wei. */
export const LIDO_CHUNK_MAX = 1_000_000_000_000_000_000_000n;
export const LIDO_CHUNK_MIN = 100n;

export type LidoWithdrawalRequest = {
  readonly id: bigint;
  readonly amountOfStETH: bigint;
  readonly timestamp: number;
  readonly status: "pending" | "claimable" | "claimed";
  readonly claimableEther?: bigint;
};

export type LidoPosition = {
  readonly stETH: bigint;
  readonly requests: ReadonlyArray<LidoWithdrawalRequest>;
};

/**
 * The account's stETH balance and withdrawal-request states — display only. Checkpoint hints are
 * searched once for all finalised, unclaimed ids; per-request claimable ether comes back in order.
 */
export const lidoPosition = async (
  client: Parameters<typeof readContract>[0],
  owner: string,
): Promise<LidoPosition> => {
  const address = getAddress(owner);
  const [stETH, ids] = await Promise.all([
    readContract(client, {
      address: LIDO_STETH,
      abi: LIDO_STETH_ABI,
      functionName: "balanceOf",
      args: [address],
    }),
    readContract(client, {
      address: LIDO_QUEUE,
      abi: LIDO_QUEUE_ABI,
      functionName: "getWithdrawalRequests",
      args: [address],
    }),
  ]);
  const status =
    ids.length === 0
      ? []
      : await readContract(client, {
          address: LIDO_QUEUE,
          abi: LIDO_QUEUE_ABI,
          functionName: "getWithdrawalStatus",
          args: [ids],
        });
  const claimable = status
    .map((entry, i) => ({ entry, id: ids[i] ?? 0n }))
    .filter(({ entry }) => entry.isFinalized && !entry.isClaimed);
  const ethers =
    claimable.length === 0
      ? []
      : await (async () => {
          const last = await readContract(client, {
            address: LIDO_QUEUE,
            abi: LIDO_QUEUE_ABI,
            functionName: "getLastCheckpointIndex",
          });
          const hints = await readContract(client, {
            address: LIDO_QUEUE,
            abi: LIDO_QUEUE_ABI,
            functionName: "findCheckpointHints",
            args: [claimable.map(({ id }) => id), 1n, last],
          });
          return readContract(client, {
            address: LIDO_QUEUE,
            abi: LIDO_QUEUE_ABI,
            functionName: "getClaimableEther",
            args: [claimable.map(({ id }) => id), hints],
          });
        })();
  const etherOf = new Map(claimable.map(({ id }, i) => [id, ethers[i] ?? 0n]));
  return {
    stETH,
    requests: status.map((entry, i) => {
      const id = ids[i] ?? 0n;
      const request: {
        id: bigint;
        amountOfStETH: bigint;
        timestamp: number;
        status: "pending" | "claimable" | "claimed";
        claimableEther?: bigint;
      } = {
        id,
        amountOfStETH: entry.amountOfStETH,
        timestamp: Number(entry.timestamp),
        status: entry.isClaimed ? "claimed" : entry.isFinalized ? "claimable" : "pending",
      };
      const claimableEther = entry.isFinalized && !entry.isClaimed ? etherOf.get(id) : undefined;
      if (claimableEther !== undefined) {
        request.claimableEther = claimableEther;
      }
      return request;
    }),
  };
};
