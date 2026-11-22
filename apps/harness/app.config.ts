import type { ExpoConfig } from "expo/config";

const config = (): ExpoConfig => ({
  name: "V1 Harness",
  slug: "qntx-wallet-harness",
  version: "0.0.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  ios: {
    // A different bundle id than Android: org.qntx.wallet.harness is already
    // registered under the old free team and App IDs cannot be re-registered
    // under the paid team.
    bundleIdentifier: "org.qntx.wallet.harness.ios",
    supportsTablet: false,
    appleTeamId: "RU84U75XZM",
    // Native passkeys (W6c) need the associated domain; the relying party in
    // apps/harness/relying-party serves the AASA file for it.
    associatedDomains: ["webcredentials:wallet-harness.qntx.org?mode=developer"],
    entitlements: {
      // ISO 14443 tag sessions for the qntx card reader surface.
      "com.apple.developer.nfc.readersession.formats": ["TAG"],
    },
    infoPlist: {
      NSFaceIDUsageDescription: "Face ID unlocks the wallet and approves each transaction.",
      NFCReaderUsageDescription: "Hold the qntx card against the phone to sign.",
      // Every AID a SELECT may name: the wallet applet and its NDEF applet
      // (protocol.md §2).
      "com.apple.developer.nfc.readersession.iso7816.select-identifiers": [
        "F0716E74780101",
        "D2760000850101",
      ],
    },
  },
  android: {
    package: "org.qntx.wallet.harness",
  },
  // WD-024: the hardware vault factor needs API 30.
  plugins: [["expo-build-properties", { android: { minSdkVersion: 30 } }]],
});

export default config;
