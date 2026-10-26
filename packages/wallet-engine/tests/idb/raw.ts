/** Raw fake-indexeddb access for tamper tests — not a test file, so control flow is allowed. */

export async function rawGet(storeKey: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("t", 1);
    r.addEventListener("success", () => {
      const g = r.result.transaction("records").objectStore("records").get(storeKey);
      g.addEventListener("success", () => {
        const value: unknown = g.result;
        if (value instanceof Uint8Array) {
          resolve(new Uint8Array(value));
        } else {
          reject(new Error("unexpected record shape"));
        }
      });
      g.addEventListener("error", () => {
        reject(new Error("get failed", { cause: g.error }));
      });
    });
    r.addEventListener("error", () => {
      reject(new Error("open failed", { cause: r.error }));
    });
  });
}

export async function rawPut(storeKey: string, value: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("t", 1);
    r.addEventListener("success", () => {
      const tx = r.result.transaction("records", "readwrite");
      const p = tx.objectStore("records").put(value, storeKey);
      p.addEventListener("success", () => {
        resolve();
      });
      p.addEventListener("error", () => {
        reject(new Error("put failed", { cause: p.error }));
      });
    });
    r.addEventListener("error", () => {
      reject(new Error("open failed", { cause: r.error }));
    });
  });
}

export function corruptByte(bytes: Uint8Array, index: number): void {
  bytes[index] = (bytes[index] ?? 0) + 1;
}
