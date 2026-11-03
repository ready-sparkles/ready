// Must stay the first import: switches the OpenAI SDK off its bundled
// node-fetch@2, which deterministically fails with ERR_STREAM_PREMATURE_CLOSE
// while reading gzipped response bodies on newer Node runtimes, onto the
// built-in undici fetch.
import "openai/shims/web";

await import("./composition/wire");
await import("./composition/server");
