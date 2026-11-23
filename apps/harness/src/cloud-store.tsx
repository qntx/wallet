/**
 * Cloud-store page (EXPO_PUBLIC_CLOUD_STORE=1): builds the platform cloud
 * transport, probes it with list(), then runs conformance-lite against unique
 * names. Every outcome is a CLOUD_RESULT <step> ok|fail <detail> line and the
 * run ends with CLOUD_DONE — this page is the real-device checklist runner
 * from the cloud-store owner setup. On Android an "Authorize" button runs the
 * Google consent flow and repeats the suite; on iOS account changes print
 * CLOUD_RESULT account-change.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { CloudStoreError } from "@qntx/wallet-engine";
import type { CloudStore } from "@qntx/wallet-engine";
import { createGoogleDriveStore, createICloudStore } from "@qntx/wallet-native/cloud";

const detail = (error: unknown): string =>
  error instanceof CloudStoreError
    ? `${error.code} ${error.message}`
    : `untyped ${error instanceof Error ? error.message : String(error)}`;

const buildStore = (): CloudStore & {
  readonly authorize?: () => Promise<void>;
  readonly onAccountChange?: (listener: () => void) => () => void;
} =>
  Platform.OS === "ios"
    ? createICloudStore({
        container: process.env.EXPO_PUBLIC_ICLOUD_CONTAINER ?? "",
      })
    : createGoogleDriveStore();

export const CloudStorePage = (): React.JSX.Element => {
  const [lines, setLines] = useState<string[]>([]);
  const [rerun, setRerun] = useState(0);
  const store = useRef(buildStore());

  const say = useCallback((line: string): void => {
    console.log(line);
    setLines((prev) => [...prev, line]);
  }, []);

  useEffect(() => {
    const cloud = store.current;
    const off = cloud.onAccountChange?.(() => {
      say("CLOUD_RESULT account-change");
    });
    return () => {
      off?.();
    };
  }, [say]);

  useEffect(() => {
    let cancelled = false;
    const emit = (line: string): void => {
      console.log(line);
      if (!cancelled) {
        setLines((prev) => [...prev, line]);
      }
    };
    const step = async (name: string, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
        emit(`CLOUD_RESULT ${name} ok`);
      } catch (error) {
        emit(`CLOUD_RESULT ${name} fail ${detail(error)}`);
      }
    };
    const run = async (): Promise<void> => {
      const cloud = store.current;
      const names: string[] = [];
      const prefix = `qntx-harness-${Math.random().toString(16).slice(2, 10)}`;
      const unique = (stepName: string): string => {
        const name = `${prefix}-${stepName}`;
        names.push(name);
        return name;
      };

      try {
        await cloud.list();
        emit("CLOUD_RESULT probe ok");
      } catch (error) {
        emit(`CLOUD_RESULT probe ${detail(error)}`);
        emit("CLOUD_DONE");
        return;
      }

      const written = unique("wr");
      await step("write-read", async () => {
        await cloud.write(written, "harness one");
        if ((await cloud.read(written)) !== "harness one") {
          throw new Error("read back the wrong text");
        }
      });
      await step("overwrite", async () => {
        await cloud.write(written, "harness two");
        if ((await cloud.read(written)) !== "harness two") {
          throw new Error("overwrite read back the wrong text");
        }
      });
      await step("list-once", async () => {
        const hits = (await cloud.list()).filter((name) => name === written);
        if (hits.length !== 1) {
          throw new Error(`listed ${hits.length} times`);
        }
      });
      await step("delete", async () => {
        await cloud.delete(written);
        if ((await cloud.read(written)) !== undefined) {
          throw new Error("deleted name still reads");
        }
      });
      await step("delete-missing", async () => {
        await cloud.delete(written);
      });
      const missing = unique("missing");
      await step("read-missing", async () => {
        if ((await cloud.read(missing)) !== undefined) {
          throw new Error("missing name reads as text");
        }
      });
      await step("invalid-name", async () => {
        try {
          await cloud.write(`${prefix} bad`, "x");
        } catch (error) {
          if (error instanceof CloudStoreError && error.code === "invalid") {
            return;
          }
          throw error;
        }
        throw new Error("invalid name was accepted");
      });

      for (const name of names) {
        try {
          await cloud.delete(name);
        } catch {
          // Best-effort cleanup — a missing name already resolves.
        }
      }
      emit("CLOUD_DONE");
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [rerun]);

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.title}>Cloud store</Text>
        {store.current.authorize === undefined ? null : (
          <Pressable
            style={styles.button}
            onPress={() => {
              void store.current.authorize?.().then(
                () => setRerun((n) => n + 1),
                (error: unknown) => say(`CLOUD_RESULT authorize fail ${detail(error)}`),
              );
            }}
          >
            <Text style={styles.buttonText}>Authorize</Text>
          </Pressable>
        )}
      </View>
      <ScrollView style={styles.scroll}>
        {lines.map((line, index) => (
          <Text key={index} style={styles.line}>
            {line}
          </Text>
        ))}
      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  title: { fontSize: 18, fontWeight: "600" },
  button: {
    backgroundColor: "#111",
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  buttonText: { color: "#fff", fontSize: 14 },
  scroll: { flex: 1, paddingHorizontal: 16 },
  line: { fontFamily: "Menlo", fontSize: 11, paddingVertical: 2 },
});
