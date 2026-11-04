export async function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.addEventListener("success", () => {
      resolve(req.result);
    });
    req.addEventListener("error", () => {
      reject(new Error("indexeddb request failed", { cause: req.error }));
    });
  });
}

export async function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.addEventListener("complete", () => {
      resolve();
    });
    tx.addEventListener("error", () => {
      reject(new Error("indexeddb transaction failed", { cause: tx.error }));
    });
    tx.addEventListener("abort", () => {
      reject(new Error("indexeddb transaction aborted", { cause: tx.error }));
    });
  });
}
