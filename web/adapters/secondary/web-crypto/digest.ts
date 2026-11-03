import type { OutlookCryptoPort } from "../../../ports/outlook";

export const createWebCrypto = (): OutlookCryptoPort => ({
  digestSha256: (data) => {
    const bytes = new ArrayBuffer(data.byteLength);
    const view = new Uint8Array(bytes);
    view.set(data);

    return crypto.subtle.digest("SHA-256", view);
  },
  randomUuid: () => crypto.randomUUID(),
});
