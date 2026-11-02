import { useEffect } from "react";
import { Text, View } from "react-native";

import { runConsumerSmoke } from "./smoke.ts";

export function App(): React.JSX.Element {
  useEffect(() => {
    void runConsumerSmoke();
  }, []);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Text>qntx wallet consumer</Text>
    </View>
  );
}
