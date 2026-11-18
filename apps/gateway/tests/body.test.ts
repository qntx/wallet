import { describe, expect, it } from "vite-plus/test";

import { ResponseTooLarge, capStream, readCapped } from "../src/providers/body.ts";

const stream = (chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(65);

describe("readCapped", () => {
  it("rejects on an over-cap content-length", async () => {
    const res = new Response(stream([bytes(4)]), { headers: { "content-length": "11" } });
    await expect(readCapped(res, 10)).rejects.toBeInstanceOf(ResponseTooLarge);
  });

  it("reads a body at exactly the cap", async () => {
    const res = new Response(stream([bytes(6), bytes(4)]));
    await expect(readCapped(res, 10)).resolves.toBe("A".repeat(10));
  });

  it("rejects a body at cap plus one byte", async () => {
    const res = new Response(stream([bytes(11)]));
    await expect(readCapped(res, 10)).rejects.toBeInstanceOf(ResponseTooLarge);
  });

  it("rejects a chunked body once the running count passes the cap", async () => {
    const res = new Response(stream([bytes(6), bytes(6)]));
    await expect(readCapped(res, 10)).rejects.toBeInstanceOf(ResponseTooLarge);
  });

  it("joins a multi-byte utf-8 sequence split across chunks", async () => {
    const encoded = new TextEncoder().encode("éè");
    const res = new Response(stream([encoded.slice(0, 3), encoded.slice(3)]));
    await expect(readCapped(res, 10)).resolves.toBe("éè");
  });

  it("answers an empty body as an empty string", async () => {
    await expect(readCapped(new Response(null), 10)).resolves.toBe("");
  });
});

describe("capStream", () => {
  it("passes a body at exactly the cap through intact", async () => {
    const res = new Response(capStream(stream([bytes(6), bytes(4)]), 10));
    await expect(res.text()).resolves.toBe("A".repeat(10));
  });

  it("errors the stream once the count exceeds the cap", async () => {
    const res = new Response(capStream(stream([bytes(6), bytes(4), bytes(1)]), 10));
    await expect(res.text()).rejects.toBeInstanceOf(ResponseTooLarge);
  });
});
