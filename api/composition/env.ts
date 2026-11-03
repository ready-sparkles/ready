import { configureMeetingContentKeys } from "@readymeet/db";

import { apiEnv } from "./bootstrap";

export { apiEnv };

const INSECURE_PRODUCTION_DEFAULTS = [
  { key: "AUTH_EXCHANGE_SECRET", value: "dev_auth_exchange_secret_change_me" },
  { key: "OAUTH_TOKEN_ENCRYPTION_KEY", value: "dev_oauth_token_encryption_key_change_me" },
] as const;

if (apiEnv.NODE_ENV === "production") {
  const insecureKeys = INSECURE_PRODUCTION_DEFAULTS.filter(({ key, value }) => apiEnv[key] === value).map(
    ({ key }) => key,
  );

  if (insecureKeys.length !== 0) {
    throw new Error(
      `Refusing to start in production with insecure default value(s) for: ${insecureKeys.join(", ")}. ` +
        "Set a unique, high-entropy secret for each of these environment variables.",
    );
  }
}

configureMeetingContentKeys();
