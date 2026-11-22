const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The workspace links packages (wallet-native, v1-probe) that carry their own
// nested react-native/react-native-nitro-modules. Two module instances mean
// two ReactNativeViewConfigRegistry maps: a Nitro view registers its config in
// one and the renderer looks it up in the other. Pin both to the app's copies.
const PINNED = ["react-native", "react-native-nitro-modules"];

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (PINNED.includes(moduleName)) {
    return {
      type: "sourceFile",
      filePath: require.resolve(moduleName, { paths: [__dirname] }),
    };
  }
  if (upstream != null) {
    return upstream(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
