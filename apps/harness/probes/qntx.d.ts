declare const __qntx: {
  readonly random: (length: number) => Uint8Array;
  readonly now: () => number;
  readonly elapsed: () => number;
  readonly setTimer: (delayMs: number, fn: () => void) => () => void;
  readonly frames: {
    readonly post: (message: ArrayBuffer) => void;
    readonly onMessage: (fn: (message: ArrayBuffer) => void) => void;
    readonly onIntegrityViolation: (fn: () => void) => void;
  };
  readonly cardReader: {
    readonly open: (
      prompt: string,
      done: (code: string | undefined, detail: string | undefined) => void,
    ) => void;
    readonly transmit: (
      apdu: Uint8Array,
      done: (
        response: Uint8Array | undefined,
        code: string | undefined,
        detail: string | undefined,
      ) => void,
    ) => void;
    readonly close: (outcome: "success" | "failure", text: string) => void;
  };
  readonly secureInput: {
    readonly request: (
      kind: "access-code" | "short-id" | "backup-password",
      label: string,
      done: (value: Uint8Array | undefined, code: string | undefined) => void,
    ) => void;
    readonly cancel: () => void;
  };
  readonly pbkdf2: (
    hash: "sha256" | "sha512",
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    length: number,
    done: (result: Uint8Array | undefined, error: string | undefined) => void,
  ) => void;
  readonly argon2id: (
    password: Uint8Array,
    salt: Uint8Array,
    memoryKiB: number,
    passes: number,
    lanes: number,
    length: number,
    done: (result: Uint8Array | undefined, error: string | undefined) => void,
  ) => void;
};

declare const NitroModulesProxy:
  | {
      readonly createHybridObject: (name: string) => {
        readonly publicKey: (secretKey: ArrayBuffer) => ArrayBuffer;
        readonly sign: (id: ArrayBuffer, secretKey: ArrayBuffer, auxRand: ArrayBuffer) => ArrayBuffer;
        readonly verifySerialized: (
          serializedUtf8: ArrayBuffer,
          id: ArrayBuffer,
          pubkey: ArrayBuffer,
          sig: ArrayBuffer,
        ) => boolean;
      };
    }
  | undefined;

declare const HermesInternal:
  | {
      readonly getRuntimeProperties?: () => Record<string, string>;
    }
  | undefined;
