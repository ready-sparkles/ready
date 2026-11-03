import type { z } from "zod";

import { bindPortFunction } from "./bind-port";

const SECRET_CRYPTO_PORT_IS_NOT_CONFIGURED_MESSAGE = "SecretCrypto port is not configured.";

type DecryptedJsonSecret =
  | string
  | number
  | boolean
  | null
  | DecryptedJsonSecret[]
  | { [key: string]: DecryptedJsonSecret };

type SecretCryptoPort = {
  decryptStoredJsonSecret: <T>(input: { secretRef: string; schema: z.ZodType<T> }) => T;
  encryptJsonSecret: (value: unknown) => string;
  isStoredJsonObject: (value: unknown) => value is object;
  decryptJsonSecret: (secretRef: string) => DecryptedJsonSecret;
};

const secretCryptoState: { port?: SecretCryptoPort } = {};

export function configureSecretCrypto(port: SecretCryptoPort): void {
  secretCryptoState.port = port;
}

function secretCrypto(): SecretCryptoPort {
  if (secretCryptoState.port === undefined) {
    throw new Error(SECRET_CRYPTO_PORT_IS_NOT_CONFIGURED_MESSAGE);
  }

  return secretCryptoState.port;
}

export const decryptStoredJsonSecret: SecretCryptoPort["decryptStoredJsonSecret"] = bindPortFunction(
  () => secretCrypto().decryptStoredJsonSecret,
);

export const encryptJsonSecret: SecretCryptoPort["encryptJsonSecret"] = bindPortFunction(
  () => secretCrypto().encryptJsonSecret,
);

export const isStoredJsonObject: SecretCryptoPort["isStoredJsonObject"] = bindPortFunction(
  () => secretCrypto().isStoredJsonObject,
);

export const decryptJsonSecret: SecretCryptoPort["decryptJsonSecret"] = bindPortFunction(
  () => secretCrypto().decryptJsonSecret,
);
