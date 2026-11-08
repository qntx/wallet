import * as AbiFunction from "ox/AbiFunction";
import * as AbiParameters from "ox/AbiParameters";
import * as Hex from "ox/Hex";

import { checksumEvmAddress, isEvmAddress } from "./address.ts";

/**
 * MetaMask Delegation Framework EIP7702StatelessDeleGator v1.3.0 — deterministic CREATE2, the same
 * address on every chain that supports it.
 */
export const EVM_DELEGATOR = {
  address: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
  name: "EIP7702StatelessDeleGator",
  version: "1.3.0",
} as const;

/** The EIP-7702 designator byte prefix: `0xef0100 ‖ address` marks a delegated account's code. */
export const EVM_DELEGATION_PREFIX = "0xef0100";

/** ERC-7821 batch-default execution mode: `0x01` followed by 31 zero bytes. */
export const EXECUTE_BATCH_MODE =
  "0x0100000000000000000000000000000000000000000000000000000000000000";

export const EXECUTE: AbiFunction.AbiFunction = AbiFunction.from(
  "function execute(bytes32 mode, bytes executionData)",
);

const EXECUTIONS = [
  {
    type: "tuple[]",
    components: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "callData", type: "bytes" },
    ],
  },
] as const;

const hex = (v: string): `0x${string}` => {
  Hex.assert(v);
  return v;
};

/** ERC-7821 batch-default self-call payload for `execute` on the delegator. */
export const encodeBatchExecute = (
  calls: ReadonlyArray<{ readonly to: string; readonly value: bigint; readonly data: string }>,
): string =>
  AbiFunction.encodeData(EXECUTE, [
    EXECUTE_BATCH_MODE,
    AbiParameters.encode(EXECUTIONS, [
      calls.map((c) => ({
        target: hex(checksumEvmAddress(c.to)),
        value: c.value,
        callData: hex(c.data),
      })),
    ]),
  ]);

type Execution = { readonly to: string; readonly value: bigint; readonly data: string };

const list = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : []);

const isExecution = (
  e: unknown,
): e is { readonly target: string; readonly value: bigint; readonly callData: string } =>
  typeof e === "object" &&
  e !== null &&
  "target" in e &&
  "value" in e &&
  "callData" in e &&
  typeof e.target === "string" &&
  isEvmAddress(e.target) &&
  typeof e.value === "bigint" &&
  typeof e.callData === "string";

/** Decodes an `execute` call; undefined unless the encoding is canonical batch-default mode. */
export const decodeBatchExecute = (data: string): ReadonlyArray<Execution> | undefined => {
  try {
    const args = list(AbiFunction.decodeData(EXECUTE, hex(data)));
    const [mode, executionData] = args;
    if (mode !== EXECUTE_BATCH_MODE || typeof executionData !== "string") {
      return undefined;
    }
    const decoded: unknown = AbiParameters.decode(EXECUTIONS, hex(executionData));
    const [inner] = list(decoded);
    const executions: Execution[] = [];
    for (const e of list(inner)) {
      if (!isExecution(e)) {
        return undefined;
      }
      executions.push({
        to: checksumEvmAddress(e.target),
        value: e.value,
        data: e.callData,
      });
    }
    return executions;
  } catch {
    return undefined;
  }
};
