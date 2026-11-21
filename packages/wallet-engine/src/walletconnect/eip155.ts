import { evmChainId } from "../connect/controller.ts";
import type { NamespaceRow } from "./namespaces.ts";

const EIP155_METHODS: ReadonlyArray<string> = [
  "personal_sign",
  "eth_signTypedData_v4",
  "eth_sendTransaction",
  "wallet_sendCalls",
  "wallet_getCallsStatus",
  "wallet_showCallsStatus",
  "wallet_getCapabilities",
  "wallet_watchAsset",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
];

/**
 * The eip155 namespace: every WalletConnect method is the EIP-1193 method of the same name, so
 * dispatch is a straight pass-through into the injected-provider handler with the request's CAIP-2
 * chain as its network.
 */
export const eip155Row: NamespaceRow = {
  namespace: "eip155",
  methods: Object.fromEntries(EIP155_METHODS.map((method) => [method, [method]])),
  events: ["accountsChanged", "chainChanged"],
  serves: (network) => evmChainId(network) !== undefined,
  accounts: (scope) => scope.accounts,
  dispatch: async (call, engine) =>
    engine.eip1193.handle(call.origin, {
      method: call.method,
      params: call.params,
      network: call.network,
    }),
};
