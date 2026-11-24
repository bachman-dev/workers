/** Crockford's base32 alphabet, which ULIDs are written in. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BITS_PER_CHARACTER = 5;
const TIME_CHARACTERS = 10;
const RANDOM_CHARACTERS = 16;

/**
 * Makes a ULID: 48 bits of Unix time in milliseconds, then 80 random bits, as 26 base32 characters. They sort by
 * creation time and fit easily in a Discord custom ID.
 *
 * @param {number} now - The time to encode, as Unix time in milliseconds.
 * @returns {string} The ULID.
 */
export default function ulid(now: number = Date.now()): string {
  let time = "";
  let remaining = Math.floor(now);
  for (let index = 0; index < TIME_CHARACTERS; index += 1) {
    time = `${ALPHABET.charAt(remaining % ALPHABET.length)}${time}`;
    remaining = Math.floor(remaining / ALPHABET.length);
  }
  // One random byte per character; masking to 5 bits keeps each character uniform
  const random = Array.from(
    crypto.getRandomValues(new Uint8Array(RANDOM_CHARACTERS)),
    // oxlint-disable-next-line no-bitwise -- Keeps the low 5 bits
    (byte) => ALPHABET.charAt(byte & ((1 << BITS_PER_CHARACTER) - 1)),
  ).join("");
  return `${time}${random}`;
}
