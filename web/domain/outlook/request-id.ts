const UUID_BYTE_LENGTH = 16;
const UUID_VERSION_INDEX = 6;
const UUID_VARIANT_INDEX = 8;
const UUID_VERSION_MASK = 15;
const UUID_VERSION = 64;
const UUID_VARIANT_MASK = 63;
const UUID_VARIANT = 128;
const UUID_HEX_RADIX = 16;
const UUID_BYTE_HEX_LENGTH = 2;
const UUID_FIRST_SEGMENT_END = 8;
const UUID_SECOND_SEGMENT_END = 12;
const UUID_THIRD_SEGMENT_END = 16;
const UUID_FOURTH_SEGMENT_END = 20;

export const requestIdMaterial = ({ mailbox, itemId }: { mailbox: string; itemId: string }): Uint8Array =>
  new TextEncoder().encode(`ready-outlook-v1\0${mailbox.toLowerCase()}\0${itemId}`);

const versionedByte = ({ byte, index }: { byte: number; index: number }): number => {
  if (index === UUID_VERSION_INDEX) {
    return (byte & UUID_VERSION_MASK) | UUID_VERSION;
  }
  if (index === UUID_VARIANT_INDEX) {
    return (byte & UUID_VARIANT_MASK) | UUID_VARIANT;
  }

  return byte;
};

export const requestIdFromDigest = ({ digest }: { digest: Uint8Array }): string => {
  const bytes = Uint8Array.from(digest.slice(0, UUID_BYTE_LENGTH), (byte, index) => versionedByte({ byte, index }));
  const hex = Array.from(bytes, (byte) => byte.toString(UUID_HEX_RADIX).padStart(UUID_BYTE_HEX_LENGTH, "0")).join("");

  return [
    hex.slice(0, UUID_FIRST_SEGMENT_END),
    hex.slice(UUID_FIRST_SEGMENT_END, UUID_SECOND_SEGMENT_END),
    hex.slice(UUID_SECOND_SEGMENT_END, UUID_THIRD_SEGMENT_END),
    hex.slice(UUID_THIRD_SEGMENT_END, UUID_FOURTH_SEGMENT_END),
    hex.slice(UUID_FOURTH_SEGMENT_END),
  ].join("-");
};
