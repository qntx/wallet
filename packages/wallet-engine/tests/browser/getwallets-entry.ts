import { getWallets } from "@wallet-standard/app";
// Eagerly create the registry so it listens before the injected wallet registers.
const wallets = getWallets();
(globalThis as Record<string, unknown>)["__getWallets"] = () => wallets;
