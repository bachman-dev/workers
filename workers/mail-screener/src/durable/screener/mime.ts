import { log } from "@bachman-dev/workers-shared/util";

/** An RFC 2047 encoded word, e.g. `=?UTF-8?B?SMOpbGxv?=`. */
const ENCODED_WORD = /[=]\?(?<charset>[^?\s]+)\?(?<encoding>[BbQq])\?(?<text>[^?\s]*)\?=/gv;
/** Whitespace between two encoded words, which RFC 2047 says to drop. */
const BETWEEN_ENCODED_WORDS = /(?<=\?=)\s+(?==\?)/gv;
const QUOTED_PRINTABLE_BYTE = /[=](?<hex>[0-9A-Fa-f]{2})/gv;
const HEX_RADIX = 16;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Turns the payload of an encoded word into bytes.
 *
 * @param {string} encoding - `B` (base64) or `Q` (quoted-printable-like).
 * @param {string} text - The encoded payload.
 * @returns {Uint8Array} The decoded bytes.
 */
function encodedWordBytes(encoding: string, text: string): Uint8Array {
  if (encoding.toUpperCase() === "B") {
    return Uint8Array.from(atob(text), (character) => character.codePointAt(0) ?? 0);
  }
  const binary = text
    .replaceAll("_", " ")
    .replaceAll(QUOTED_PRINTABLE_BYTE, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, HEX_RADIX)));
  return Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
}

/**
 * Decodes one encoded word, leaving it as it was if its charset or payload can't be read.
 *
 * @param {string} word - The whole encoded word.
 * @param {string} charset - Its charset, possibly with an RFC 2231 `*language` suffix.
 * @param {string} encoding - `B` or `Q`.
 * @param {string} text - The encoded payload.
 * @returns {string} The decoded text.
 */
function decodeEncodedWord(word: string, charset: string, encoding: string, text: string): string {
  try {
    const [label = charset] = charset.split("*");
    return new TextDecoder(label).decode(encodedWordBytes(encoding, text));
  } catch (error) {
    log("warn", "Couldn't decode an encoded word in a header", word, error);
    return word;
  }
}

/**
 * Makes a header's text fit for display: decodes RFC 2047 encoded words, then turns control characters and runs of
 * whitespace into single spaces.
 *
 * @param {string} value - The raw header text.
 * @returns {string} The decoded, single-line text.
 */
export function decodeHeaderText(value: string): string {
  const decoded = value
    .replaceAll(BETWEEN_ENCODED_WORDS, "")
    .replaceAll(ENCODED_WORD, (word, charset: string, encoding: string, text: string) =>
      decodeEncodedWord(word, charset, encoding, text),
    );
  return decoded.replaceAll(/[\p{Cc}\s]+/gv, " ").trim();
}

/**
 * Shortens text to a number of characters (grapheme clusters), so a cut never splits an emoji or accented letter.
 *
 * @param {string} value - The text.
 * @param {number} length - The most characters to keep.
 * @returns {string} The text, cut to `length` characters with an ellipsis if it was longer.
 */
export function truncate(value: string, length: number): string {
  const characters = Array.from(GRAPHEMES.segment(value), (segment) => segment.segment);
  if (characters.length <= length) {
    return value;
  }
  return `${characters.slice(0, length - 1).join("")}…`;
}
