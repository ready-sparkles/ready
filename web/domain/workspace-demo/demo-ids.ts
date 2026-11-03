// Stable, schema-valid UUIDs for fixture keys (cyrb128), so links survive reloads.
const LINT_NUM_N597399067 = 597399067;
const LINT_NUM_N2869860233 = 2869860233;
const LINT_NUM_N951274213 = 951274213;
const LINT_NUM_N2716044179 = 2716044179;
const LINT_NUM_N1779033703 = 1779033703;
const LINT_NUM_N3144134277 = 3144134277;
const LINT_NUM_N1013904242 = 1013904242;
const LINT_NUM_N2773480762 = 2773480762;
const LINT_NUM_N18 = 18;
const LINT_NUM_N22 = 22;
const LINT_NUM_N17 = 17;
const LINT_NUM_N19 = 19;
const LINT_NUM_N16 = 16;
const LINT_NUM_N8 = 8;
const LINT_NUM_N4 = 4;
const LINT_NUM_N12 = 12;
const LINT_NUM_N13 = 13;
const LINT_NUM_N20 = 20;
const LINT_NUM_N32 = 32;
const lintNumGoldenRatio = 0x9e3779b1;

export function demoId(key: string): string {
  const mixed = Array.from({ length: key.length }, (_, index) => key.charCodeAt(index)).reduce(
    (hash, code) => {
      const h1 = hash.h2 ^ Math.imul(hash.h1 ^ code, LINT_NUM_N597399067);
      const h2 = hash.h3 ^ Math.imul(hash.h2 ^ code, LINT_NUM_N2869860233);
      const h3 = hash.h4 ^ Math.imul(hash.h3 ^ code, LINT_NUM_N951274213);
      const h4 = h1 ^ Math.imul(hash.h4 ^ code, LINT_NUM_N2716044179);

      return { h1, h2, h3, h4 };
    },
    { h1: LINT_NUM_N1779033703, h2: LINT_NUM_N3144134277, h3: LINT_NUM_N1013904242, h4: LINT_NUM_N2773480762 },
  );
  const h1 = Math.imul(mixed.h3 ^ (mixed.h1 >>> LINT_NUM_N18), LINT_NUM_N597399067);
  const h2 = Math.imul(mixed.h4 ^ (mixed.h2 >>> LINT_NUM_N22), LINT_NUM_N2869860233);
  const h3 = Math.imul(h1 ^ (mixed.h3 >>> LINT_NUM_N17), LINT_NUM_N951274213);
  const h4 = Math.imul(h2 ^ (mixed.h4 >>> LINT_NUM_N19), LINT_NUM_N2716044179);
  const mixedH1 = h1 ^ h2 ^ h3 ^ h4;
  const mixedH2 = h2 ^ mixedH1;
  const mixedH3 = h3 ^ mixedH1;
  const mixedH4 = h4 ^ mixedH1;
  const hex = [mixedH1, mixedH2, mixedH3, mixedH4]
    .map((part) => (part >>> 0).toString(LINT_NUM_N16).padStart(LINT_NUM_N8, "0"))
    .join("");
  const variant = (LINT_NUM_N8 + (parseInt(hex.charAt(LINT_NUM_N16), LINT_NUM_N16) % LINT_NUM_N4)).toString(
    LINT_NUM_N16,
  );

  return `${hex.slice(0, LINT_NUM_N8)}-${hex.slice(LINT_NUM_N8, LINT_NUM_N12)}-4${hex.slice(LINT_NUM_N13, LINT_NUM_N16)}-${variant}${hex.slice(LINT_NUM_N17, LINT_NUM_N20)}-${hex.slice(LINT_NUM_N20, LINT_NUM_N32)}`;
}

/** A distinct id for a record's secondary key (its source, its evidence)
 * without hashing again. */
export function demoSiblingId(...args: [id: string, salt: number]): string {
  const [id, salt] = args;
  const tail = ((parseInt(id.slice(-LINT_NUM_N8), LINT_NUM_N16) ^ Math.imul(salt, lintNumGoldenRatio)) >>> 0)
    .toString(LINT_NUM_N16)
    .padStart(LINT_NUM_N8, "0");

  return `${id.slice(0, -LINT_NUM_N8)}${tail}`;
}
