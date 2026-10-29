// oxlint-disable import/no-commonjs, unicorn/prefer-module -- the RN CLI loads
// react-native.config.js via require; CJS is the required format.

// https://github.com/react-native-community/cli/blob/main/docs/dependencies.md
module.exports = {
  dependency: {
    platforms: {
      /** @type {import("@react-native-community/cli-types").IOSDependencyParams} */
      ios: {},
      /** @type {import("@react-native-community/cli-types").AndroidDependencyParams} */
      android: {},
    },
  },
};
