import "./src/polyfills.ts";

// The leak tap must be installed before App's module graph loads @qntx/v1-probe,
// which creates a hybrid object at module evaluation. require() defers those
// modules until after the recorder is in place.
if (process.env.EXPO_PUBLIC_CARD_SURFACES === "1") {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { installLeakRecorder } = require("./src/leak-recorder.ts") as typeof import("./src/leak-recorder.ts");
  installLeakRecorder();
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registerRootComponent } = require("expo") as typeof import("expo");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { App } = require("./src/App") as typeof import("./src/App");

registerRootComponent(App);
