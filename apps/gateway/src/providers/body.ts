/** An upstream body exceeded the byte cap applied where it is consumed. */
// oxlint-disable-next-line unicorn/custom-error-definition -- a marker type, not a generic Error
export class ResponseTooLarge extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`upstream body exceeds ${maxBytes} bytes`);
    this.name = "ResponseTooLarge";
    this.maxBytes = maxBytes;
  }
}

const overCap = (headers: Headers, maxBytes: number): boolean => {
  const declared = Number(headers.get("content-length") ?? 0);
  return Number.isFinite(declared) && declared > maxBytes;
};

/**
 * The whole body as text, bounded by `maxBytes`: an over-cap `content-length` fails before the body
 * is touched, and a body that grows past the cap while streaming is cancelled at once.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (overCap(response.headers, maxBytes)) {
    throw new ResponseTooLarge(maxBytes);
  }
  if (response.body === null) {
    return "";
  }
  // fetch bodies stream Uint8Array chunks; ReadableStream defaults its chunk type to any.
  // oxlint-disable-next-line typescript/no-unsafe-assignment
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- reads are sequential on purpose
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        return text + decoder.decode();
      }
      received += value.byteLength;
      if (received > maxBytes) {
        throw new ResponseTooLarge(maxBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/**
 * A pass-through stream that errors with {@link ResponseTooLarge} once the bytes seen exceed
 * `maxBytes`; `pipeThrough` propagates the error by cancelling the source.
 */
export function capStream(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          throw new ResponseTooLarge(maxBytes);
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
