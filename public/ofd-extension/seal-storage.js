// Public, signed ESL bytes only. IndexedDB avoids localStorage's small quota and
// base64 expansion; private keys stay in the certificate worker's memory.
export async function sealStorage(method, value) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("paperdesk.seals", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("seals", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(Error("印章目录被其他页面占用，请关闭旧页面后重试。"));
  });
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        "seals",
        method === "getAll" ? "readonly" : "readwrite",
      );
      const request = transaction.objectStore("seals")[method](value);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error || request.error);
    });
  } finally {
    db.close();
  }
}
