import type { ExpoConfig } from "expo/config";

const config = (): ExpoConfig => ({
  name: "WalletConsumer",
  slug: "wallet-consumer",
  version: "0.0.0",
  orientation: "portrait",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: "org.qntx.wallet.consumer",
    infoPlist: {
      NSFaceIDUsageDescription: "Verify your identity to unlock your wallet.",
    },
  },
  android: {
    package: "org.qntx.wallet.consumer",
  },
  // WD-024: the hardware vault factor needs API 30.
  plugins: [["expo-build-properties", { android: { minSdkVersion: 30 } }]],
});

export default config;
