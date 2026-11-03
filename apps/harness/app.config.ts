import type { ExpoConfig } from "expo/config";

const config = (): ExpoConfig => ({
  name: "V1 Harness",
  slug: "qntx-wallet-harness",
  version: "0.0.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "org.qntx.wallet.harness",
    supportsTablet: false,
    appleTeamId: "RU84U75XZM",
    // Native passkeys (W6c) need the associated domain; the relying party in
    // apps/harness/relying-party serves the AASA file for it.
    associatedDomains: ["webcredentials:wallet-harness.qntx.org?mode=developer"],
    infoPlist: {
      NSFaceIDUsageDescription: "Face ID unlocks the wallet and approves each transaction.",
    },
  },
  android: {
    package: "org.qntx.wallet.harness",
  },
  // WD-024: the hardware vault factor needs API 30.
  plugins: [["expo-build-properties", { android: { minSdkVersion: 30 } }]],
});

export default config;
