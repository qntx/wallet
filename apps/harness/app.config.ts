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
    appleTeamId: "6Z33CD4837",
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
