import type { ExpoConfig } from "expo/config";
import { withAndroidManifest } from "expo/config-plugins";

/** The card surfaces need NFC; the library manifest stays empty so hosts opt in. */
export default function withCardAndroidManifest(config: ExpoConfig): ExpoConfig {
  return withAndroidManifest(config, (c) => {
    const root = c.modResults.manifest;
    const entries = root["uses-feature"] ?? [];
    if (!entries.some((e) => e.$?.["android:name"] === "android.hardware.nfc")) {
      entries.push({
        $: { "android:name": "android.hardware.nfc", "android:required": "false" },
      });
    }
    root["uses-feature"] = entries;
    return c;
  });
}
