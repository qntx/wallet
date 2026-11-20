// The workspace code that may run inside the enclave: the kernel, the native kernel entry and
// everything they bundle. One list serves both checks that guard it — the lint config applies the
// enclave.mdx global allow-list to exactly these paths, and check-boundaries.ts fails when the
// kernel bundle's import closure reaches a file outside them. Entries ending in `.ts` are files,
// the rest directories.
export const ENCLAVE_ZONE: ReadonlyArray<string> = [
  "packages/wallet-kernel/src",
  "packages/wallet-native/kernel",
  "packages/wallet-native/src/cbor.ts",
  "packages/wallet-chains/src",
  "packages/wallet/src/protocol",
  "packages/wallet/src/types.ts",
];
