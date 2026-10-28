// https://github.com/react-native-community/cli/blob/main/docs/projects.md
const path = require("path");

// @qntx/wallet-native lives outside the app root (repo packages/), so Expo
// autolinking does not discover it via node_modules scanning — declare it here.
const walletNative = path.resolve(__dirname, "../../packages/wallet-native");

module.exports = {
  dependencies: {
    "@qntx/wallet-native": {
      root: walletNative,
      platforms: {
        ios: {
          podspecPath: path.join(walletNative, "WalletNative.podspec"),
        },
        android: {
          sourceDir: path.join(walletNative, "android"),
        },
      },
    },
  },
};
