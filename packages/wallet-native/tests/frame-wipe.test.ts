/**
 * Every copy of a channel frame is wiped once its bytes are consumed: the JS transport and host
 * port wipe the encoded frame and the transfer list on every path — success or a throwing post —
 * and wipe the inbound frame after decode. cborg's own `encode` must never be on the path: its
 * module-level writer keeps the first chunk alive across calls, so the frame would stay resident in
 * library state.
 */
import { encode } from "cborg";
import type * as Cborg from "cborg";
import { describe, expect, it, vi } from "vite-plus/test";

import { createKernelPort } from "../kernel/transport.ts";
import { encodeFrame } from "../src/cbor.ts";
import { spawnFromHost } from "../src/host.ts";
import type { KernelHostLike } from "../src/host.ts";

// Every Uint8Array cborg's encode produced or was handed to fill — post-fix
// only the latter kind may exist, and it must be wiped by the caller.
const cborgSeen = vi.hoisted(() => ({ buffers: [] as Uint8Array[] }));

vi.mock("cborg", async (importOriginal) => {
  const real = await importOriginal<typeof Cborg>();
  return {
    ...real,
    encode: (value: unknown, options?: Parameters<typeof real.encode>[1]) => {
      const bytes = real.encode(value, options);
      cborgSeen.buffers.push(bytes);
      return bytes;
    },
    encodeInto: (
      value: unknown,
      dest: Uint8Array,
      options?: Parameters<typeof real.encodeInto>[2],
    ) => {
      cborgSeen.buffers.push(dest);
      return real.encodeInto(value, dest, options);
    },
  };
});

const isZeroed = (bytes: Uint8Array) => bytes.every((b) => b === 0);
const bytesOf = (buffer: ArrayBuffer | undefined) => new Uint8Array(buffer ?? new ArrayBuffer(0));

const pipe = (impl: {
  post?: (frame: ArrayBuffer) => void;
  onMessage?: (cb: (frame: ArrayBuffer) => void) => void;
}) => ({
  post: impl.post ?? (() => undefined),
  onMessage: impl.onMessage ?? (() => undefined),
});

describe("encodeFrame", () => {
  it("emits bytes identical to cborg encode for a broad sample", () => {
    const samples: ReadonlyArray<Parameters<typeof encodeFrame>[0]> = [
      null,
      true,
      0,
      -1,
      1_000_000,
      Number.MAX_SAFE_INTEGER,
      "",
      "plain ascii",
      "unicode ✓ 🔑",
      new Uint8Array([0, 1, 2, 255]),
      [],
      [1, "two", new Uint8Array([3]), null],
      {},
      { a: 1, z: 2, nested: { deep: [true, new Uint8Array(8)] } },
      {
        v: 1,
        id: 42,
        result: {
          mnemonic: new Uint8Array(32).fill(0xaa),
          wallets: [{ id: "w1", origin: "imported" }],
        },
      },
    ];
    for (const sample of samples) {
      expect(new Uint8Array(encodeFrame(sample))).toStrictEqual(encode(sample));
    }
  });
});

describe("kernel transport frame hygiene", () => {
  it("wipes the encoded frame and the transfer list after post", () => {
    const posted: ArrayBuffer[] = [];
    const port = createKernelPort(
      pipe({
        post: (frame) => {
          posted.push(frame);
        },
      }),
    );
    const secret = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    port.post({ v: 1, id: 1, result: { nsec: new Uint8Array([7, 7, 7]) } }, [secret.buffer]);
    expect(posted).toHaveLength(1);
    const [frame] = posted;
    expect(frame).toBeDefined();
    expect(isZeroed(bytesOf(frame))).toBe(true);
    expect(isZeroed(secret)).toBe(true);
  });

  it("wipes the encoded frame and the transfer list when pipe.post throws", () => {
    let captured: ArrayBuffer | undefined;
    const port = createKernelPort(
      pipe({
        post: (frame) => {
          captured = frame;
          throw new Error("pipe down");
        },
      }),
    );
    const secret = new Uint8Array([1, 2, 3]);
    expect(() => port.post({ v: 1, id: 1, result: new Uint8Array([9]) }, [secret.buffer])).toThrow(
      "pipe down",
    );
    expect(captured).toBeDefined();
    expect(isZeroed(bytesOf(captured))).toBe(true);
    expect(isZeroed(secret)).toBe(true);
  });

  it("wipes the inbound frame after dispatch while decoded bytes survive", () => {
    let deliver: ((frame: ArrayBuffer) => void) | undefined;
    const port = createKernelPort(
      pipe({
        onMessage: (cb) => {
          deliver = cb;
        },
      }),
    );
    let received: unknown;
    port.listen((message) => {
      received = message;
    });
    const frame = encodeFrame({ v: 1, id: 1, result: { key: new Uint8Array([9, 8, 7]) } });
    deliver?.(frame);
    expect(isZeroed(new Uint8Array(frame))).toBe(true);
    // The decoded byte string is a copy, not a view into the wiped frame.
    expect(received).toStrictEqual({ v: 1, id: 1, result: { key: new Uint8Array([9, 8, 7]) } });
  });

  it("rethrows out of the handler on an undecodable frame and still wipes it", () => {
    let deliver = (_frame: ArrayBuffer): void => {
      throw new Error("onMessage not registered");
    };
    const port = createKernelPort(
      pipe({
        onMessage: (cb) => {
          deliver = cb;
        },
      }),
    );
    let received: unknown;
    port.listen((message) => {
      received = message;
    });
    const frame = Uint8Array.from([0xff, 0xff, 0xfe]).buffer;
    // The throw is the crash path: the C++ deliver turns a task exception into onError.
    expect(() => {
      deliver(frame);
    }).toThrow("cbor");
    expect(isZeroed(new Uint8Array(frame))).toBe(true);
    expect(received).toBeUndefined();
  });

  it("leaves no frame bytes in buffers cborg owns or filled", () => {
    cborgSeen.buffers.length = 0;
    const port = createKernelPort(pipe({}));
    port.post({ v: 1, id: 1, result: { secret: crypto.getRandomValues(new Uint8Array(64)) } }, []);
    expect(cborgSeen.buffers.length).toBeGreaterThan(0);
    for (const buffer of cborgSeen.buffers) {
      expect(isZeroed(buffer)).toBe(true);
    }
  });
});

describe("host port frame hygiene", () => {
  const host = (out: {
    frame?: ArrayBuffer;
    inbound?: (f: ArrayBuffer) => void;
  }): KernelHostLike => ({
    start: () => undefined,
    post: (frame) => {
      out.frame = frame;
    },
    onMessage: (cb) => {
      out.inbound = cb;
    },
    onExit: () => undefined,
    setBackgroundLock: () => undefined,
    lock: () => undefined,
  });

  it("wipes the encoded frame and the transfer list after host.post", () => {
    const out: { frame?: ArrayBuffer; inbound?: (f: ArrayBuffer) => void } = {};
    const port = spawnFromHost(host(out), 60);
    const secret = new Uint8Array([5, 6, 7]);
    port.post({ v: 1, id: 1, result: new Uint8Array([2]) }, [secret.buffer]);
    expect(out.frame).toBeDefined();
    expect(isZeroed(bytesOf(out.frame))).toBe(true);
    expect(isZeroed(secret)).toBe(true);
  });

  it("wipes the encoded frame and the transfer list when host.post throws", () => {
    let captured: ArrayBuffer | undefined;
    const throwing: KernelHostLike = {
      start: () => undefined,
      post: (frame) => {
        captured = frame;
        throw new Error("host down");
      },
      onMessage: () => undefined,
      onExit: () => undefined,
      setBackgroundLock: () => undefined,
      lock: () => undefined,
    };
    const port = spawnFromHost(throwing, 60);
    const secret = new Uint8Array([4, 4]);
    expect(() => port.post({ v: 1, id: 1, result: 0 }, [secret.buffer])).toThrow("host down");
    expect(isZeroed(bytesOf(captured))).toBe(true);
    expect(isZeroed(secret)).toBe(true);
  });

  it("wipes the inbound frame after dispatch while decoded bytes survive", () => {
    const out: { frame?: ArrayBuffer; inbound?: (f: ArrayBuffer) => void } = {};
    const port = spawnFromHost(host(out), 60);
    let received: unknown;
    port.listen((message) => {
      received = message;
    });
    const frame = encodeFrame({ v: 1, id: 1, result: { key: new Uint8Array([3, 2, 1]) } });
    out.inbound?.(frame);
    expect(isZeroed(new Uint8Array(frame))).toBe(true);
    const value = received as { result: { key: Uint8Array } };
    expect(value.result.key).toStrictEqual(new Uint8Array([3, 2, 1]));
  });
});
