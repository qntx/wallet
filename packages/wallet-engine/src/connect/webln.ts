/** The WebLN (`window.webln`) handler — the bridge routes `provider: "webln"` messages here. */
export type WeblnRequest = {
  readonly method: string;
  readonly params?: unknown;
};

export type WeblnHandler = {
  readonly handle: (origin: string, request: WeblnRequest) => Promise<unknown>;
};
