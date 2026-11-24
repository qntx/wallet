/**
 * Card-surfaces page (EXPO_PUBLIC_CARD_SURFACES=1): mounts the trusted
 * SecureInput next to a plain TextInput decoy and drives the scripted
 * sequence the leak checker verifies — decoy, access code, short id,
 * session approval, a cancelled request, two fake-reader taps, then one real
 * device tap. The driver types only when a `CARD_STEP` line appears;
 * everything else is automatic. Ends with `CARD_SURFACES_RESULT <json>` and
 * `CARD_SURFACES_DONE`.
 */
import { useEffect, useRef, useState } from "react";
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { callback } from "react-native-nitro-modules";

import { closeKernel, openKernel, sendToKernel } from "@qntx/v1-probe";
import { SecureInput } from "@qntx/wallet-native/secure-input";
import type { SecureInputState } from "@qntx/wallet-native/secure-input";

import { recordLeak } from "./leak-recorder.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const send = async (command: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const reply = await sendToKernel(
    encoder.encode(JSON.stringify(command)).buffer as ArrayBuffer,
  );
  return JSON.parse(decoder.decode(reply)) as Record<string, unknown>;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const CardSurfacesPage = (): React.JSX.Element => {
  const [status, setStatus] = useState("starting");
  const [lines, setLines] = useState<string[]>([]);
  const [decoy, setDecoy] = useState("");
  const [secureState, setSecureState] = useState<SecureInputState>("idle");
  const decoySubmitted = useRef<(() => void) | undefined>(undefined);
  const decoyWait = useRef<Promise<void> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const say = (line: string): void => {
      console.log(line);
      if (!cancelled) {
        setLines((prev) => [...prev, line]);
      }
    };
    const run = async (): Promise<void> => {
      decoyWait.current = new Promise<void>((resolve) => {
        decoySubmitted.current = resolve;
      });
      const result: Record<string, unknown> = {};

      say("CARD_STEP type-decoy");
      setStatus("type into the decoy field");
      await decoyWait.current;

      setStatus("opening kernel (fake reader)");
      await openKernel("card-surfaces", "source");

      say("CARD_STEP type-code");
      setStatus("type the access code into the secure field");
      result["code"] = await send({ cmd: "input", kind: "access-code" });

      say("CARD_STEP type-short-id");
      setStatus("type the short ID into the secure field");
      result["shortId"] = await send({ cmd: "input", kind: "short-id" });

      say("CARD_STEP type-approval");
      setStatus("type the 4-digit approval code into the secure field");
      result["approval"] = await send({ cmd: "input", kind: "session-approval" });

      setStatus("requesting then cancelling an input");
      const cancelledInput = send({ cmd: "input", kind: "access-code" });
      await sleep(1000);
      const cancelled = send({ cmd: "cancel-input" });
      result["cancelledInput"] = await cancelledInput;
      result["cancelled"] = await cancelled;

      setStatus("tap: ok scenario");
      result["tapOk"] = await send({ cmd: "tap", scenario: "ok" });
      setStatus("tap: lost scenario");
      result["tapLost"] = await send({ cmd: "tap", scenario: "lost" });
      closeKernel();

      setStatus("opening kernel (platform reader)");
      await openKernel("card-surfaces-device", "source");
      result["deviceTap"] = await send({ cmd: "device-tap" });
      closeKernel();

      say(`CARD_SURFACES_RESULT ${JSON.stringify(result)}`);
      say("CARD_SURFACES_DONE");
      setStatus("done");
    };
    run().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      say(`CARD_SURFACES_RESULT ${JSON.stringify({ error: message })}`);
      say("CARD_SURFACES_DONE");
      setStatus(`failed: ${message}`);
    });
    return () => {
      cancelled = true;
      closeKernel();
    };
  }, []);

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>Card surfaces</Text>
      <Text style={styles.status}>{status}</Text>
      <Text style={styles.caption}>Decoy (ordinary field, positive control):</Text>
      <TextInput
        style={styles.decoy}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        value={decoy}
        onChangeText={(text) => {
          recordLeak("react-state", { field: "decoy", value: text });
          setDecoy(text);
        }}
        onSubmitEditing={() => decoySubmitted.current?.()}
      />
      <Text style={styles.caption}>SecureInput (trusted view):</Text>
      <SecureInput
        style={styles.secure}
        onStateChange={callback((state: SecureInputState) => {
          recordLeak("secure-state", state);
          setSecureState(state);
        })}
      />
      <Text style={styles.caption}>state: {secureState}</Text>
      <ScrollView style={styles.list}>
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
  root: { flex: 1, backgroundColor: "#fff", padding: 16 },
  title: { fontSize: 17, fontWeight: "600" },
  status: { marginTop: 4, fontSize: 13, color: "#666" },
  caption: { marginTop: 12, fontSize: 12, color: "#888" },
  decoy: {
    marginTop: 4,
    borderWidth: 1,
    borderColor: "#bbb",
    borderRadius: 4,
    padding: 8,
    fontSize: 14,
  },
  secure: { marginTop: 4, minHeight: 90 },
  list: { flex: 1, marginTop: 12 },
  line: { fontFamily: "Menlo", fontSize: 11, paddingVertical: 2 },
});
