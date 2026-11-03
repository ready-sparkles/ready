import { decryptContentFields, encryptContentFields } from "./content-encryption";

const OBJECT_MODEL = "meetingContentObjects";
const FAILURE = "Meeting object encryption failed.";

/** Storage keys contain opaque IDs/hashes, not meeting text or account identities. */
export async function encryptMeetingObject(input: { storageKey: string; contentBase64: string }): Promise<string> {
  const fields = await encryptContentFields({
    model: OBJECT_MODEL,
    recordId: input.storageKey,
    fields: { content: input.contentBase64 },
  });
  const ciphertext = fields.content;
  if (ciphertext === undefined) {
    throw new Error(FAILURE);
  }

  return ciphertext;
}

export async function decryptMeetingObject(input: { storageKey: string; ciphertext: string }): Promise<string> {
  const fields = await decryptContentFields({
    model: OBJECT_MODEL,
    recordId: input.storageKey,
    fields: { content: input.ciphertext },
  });
  if (typeof fields.content !== "string") {
    throw new Error(FAILURE);
  }

  return fields.content;
}
