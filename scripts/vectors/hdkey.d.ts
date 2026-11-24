/** The parts of the untyped `hdkey` package the export-account vector generator uses. */
declare module "hdkey" {
  export default class HDKey {
    static fromMasterSeed(
      seed: Uint8Array,
      versions?: { readonly public: number; readonly private: number },
    ): HDKey;
    derive(path: string): HDKey;
    readonly publicKey: Uint8Array;
    readonly chainCode: Uint8Array;
    readonly parentFingerprint: number;
    readonly fingerprint: number;
    readonly publicExtendedKey: string;
  }
}
