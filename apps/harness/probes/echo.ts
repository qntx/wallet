import { postJson } from "./share";

__qntx.frames.onMessage((message) => {
  __qntx.frames.post(message);
});

postJson({ ready: true });
