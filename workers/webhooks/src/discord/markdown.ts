const ELLIPSIS = "…";
// A table's header row and delimiter row, e.g. `| --- | --- |`
const TABLE_HEADER_LINES = 2;
// Only cut at a line or word boundary if it keeps at least this much of the text
const MIN_BOUNDARY_RATIO = 0.75;
const CODE_FENCE = /^ {0,3}(?<fence>`{3,}|~{3,})/v;
const TABLE_DELIMITER_ROW = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/v;
const MARKDOWN_SPECIAL_CHARACTERS = /[\\*_~`\|\[\]<]/gv;
// Characters that only start a heading, list, or quote at the beginning of a line
const MARKDOWN_LINE_START_CHARACTERS = /^[#\->]/v;

// HTML tags GitHub renders that Discord shows as raw text, so they are dropped while keeping their contents
const STRIPPED_HTML_TAGS =
  /<\/?(?:b|blockquote|center|code|dd|del|details|div|dl|dt|em|i|ins|kbd|li|ol|p|picture|pre|s|samp|source|span|strike|strong|sub|summary|sup|u|ul|var)(?:\s[^>]*)?>/giv;

function isTableStart(lines: string[], index: number): boolean {
  const header = lines[index];
  const delimiter = lines[index + 1];
  return (
    header !== undefined &&
    delimiter !== undefined &&
    header.includes("|") &&
    delimiter.includes("-") &&
    TABLE_DELIMITER_ROW.test(delimiter)
  );
}

const NAMED_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};
const HTML_ENTITY = /&(?:#(?<decimal>\d+)|#x(?<hex>[\da-f]+)|(?<name>[a-z]+));/giv;
const MAX_CODE_POINT = 1_114_111;
// Renovate puts zero-width spaces after `@` and `#` in release notes so GitHub doesn't ping people or link issues;
// Discord does neither, so they only get in the way
const ZERO_WIDTH_SPACE = "\u200B";

// Decodes HTML entities like `&amp;` and `&#8203;`, which GitHub renders but Discord shows as-is
function decodeHtmlEntities(text: string): string {
  return text
    .replaceAll(HTML_ENTITY, (entity, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) {
        return NAMED_HTML_ENTITIES[name.toLowerCase()] ?? entity;
      }
      const codePoint = decimal === undefined ? Number(`0x${hex ?? ""}`) : Number(decimal);
      return codePoint > 0 && codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity;
    })
    .replaceAll(ZERO_WIDTH_SPACE, "");
}

function convertHtml(text: string): string {
  const converted = text
    .replaceAll(/<!--[\s\S]*?(?:-->|$)/gv, "")
    .replaceAll(/<table(?:\s[^>]*)?>[\s\S]*?(?:<\/table>|$)/giv, "\n(table)\n")
    .replaceAll(/<br\s*\/?>/giv, "\n")
    .replaceAll(/<hr\s*\/?>/giv, "\n---\n")
    .replaceAll(/<img\s[^>]*>/giv, (tag) => {
      const src = /\ssrc="(?<src>[^"]+)"/iv.exec(tag)?.groups?.src;
      const alt = /\salt="(?<alt>[^"]*)"/iv.exec(tag)?.groups?.alt;
      return src === undefined ? "(image)" : `[${alt === undefined || alt === "" ? "image" : alt}](${src})`;
    })
    .replaceAll(
      /<a\s[^>]*href="(?<href>[^"]+)"[^>]*>(?<label>[\s\S]*?)<\/a>/giv,
      (_match, href: string, label: string) => `[${label.trim() || href}](${href})`,
    )
    .replaceAll(/<\/?a(?:\s[^>]*)?>/giv, "")
    .replaceAll(
      /<h[1-6](?:\s[^>]*)?>(?<heading>[\s\S]*?)<\/h[1-6]>/giv,
      (_match, heading: string) => `**${heading.trim()}**`,
    )
    .replaceAll(STRIPPED_HTML_TAGS, "");
  // Decoded last so that escaped markup like `&lt;details&gt;` stays as text
  return decodeHtmlEntities(converted);
}

// Converts a line of GitHub markdown outside of code blocks into the closest equivalent Discord supports
function convertLine(line: string): string {
  return (
    line
      // Headings would be as large as or larger than the message's own title
      .replace(/^ {0,3}#{1,6}\s+(?<heading>.+?)\s*#*\s*$/v, (_match, heading: string) => `**${heading}**`)
      // Task lists
      .replace(/^(?<indent>\s*[\-*+]\s+)\[ \]\s/v, (_match, indent: string) => `${indent}☐ `)
      .replace(/^(?<indent>\s*[\-*+]\s+)\[[xX]\]\s/v, (_match, indent: string) => `${indent}☑ `)
      // Discord doesn't embed inline images, so link to them instead
      .replaceAll(
        /!\[(?<alt>[^\]]*)\]\((?<url>[^\)\s]+)(?:\s+"[^"]*")?\)/gv,
        (_match, alt: string, url: string) => `[${alt || "image"}](${url})`,
      )
  );
}

function convertProse(text: string): string[] {
  const lines = convertHtml(text).split("\n");
  const converted: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isTableStart(lines, index)) {
      converted.push("(table)");
      index += TABLE_HEADER_LINES;
      while (index < lines.length && lines[index]?.includes("|") === true && lines[index]?.trim() !== "") {
        index += 1;
      }
      index -= 1;
    } else {
      converted.push(convertLine(lines[index] ?? ""));
    }
  }
  return converted;
}

/**
 * Escapes text so Discord shows it as-is, e.g. an issue title used as a link label.
 *
 * @param {string} text - Plain text from GitHub.
 * @returns {string} The text with markdown characters escaped.
 */
export function escapeMarkdown(text: string): string {
  return text
    .replaceAll(MARKDOWN_SPECIAL_CHARACTERS, String.raw`\$&`)
    .replace(MARKDOWN_LINE_START_CHARACTERS, String.raw`\$&`);
}

/**
 * Shortens text to a maximum length, ending it with an ellipsis when cut.
 *
 * @param {string} text - The text to shorten.
 * @param {number} maxLength - Maximum length of the result, including the ellipsis.
 * @returns {string} The text, cut short if it was longer than `maxLength`.
 */
export function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/**
 * Gets the first line of a commit message or similar text, shortened to `maxLength`.
 *
 * @param {string} text - Text that may span several lines.
 * @param {number} maxLength - Maximum length of the result.
 * @returns {string} The first line of `text`.
 */
export function firstLine(text: string, maxLength: number): string {
  return truncate(text.trim().split("\n", 1)[0] ?? "", maxLength);
}

/**
 * Converts GitHub-flavored markdown into markdown Discord can display: tables become `(table)`, HTML is dropped or
 * converted, and headings become bold text. Code blocks are left untouched.
 *
 * @param {string} markdown - Markdown from GitHub, e.g. an issue body or comment.
 * @returns {string} Markdown Discord can display.
 */
export function convertMarkdown(markdown: string): string {
  const output: string[] = [];
  let prose: string[] = [];
  let fence: string | undefined;

  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const marker = CODE_FENCE.exec(line)?.groups?.fence;
    if (fence === undefined) {
      if (marker === undefined) {
        prose.push(line);
      } else {
        output.push(...convertProse(prose.join("\n")), line);
        prose = [];
        fence = marker;
      }
    } else {
      output.push(line);
      if (
        marker !== undefined &&
        marker.startsWith(fence.charAt(0)) &&
        marker.length >= fence.length &&
        line.trim() === marker
      ) {
        fence = undefined;
      }
    }
  }
  output.push(...convertProse(prose.join("\n")));

  return output
    .join("\n")
    .replaceAll(/\n{3,}/gv, "\n\n")
    .trim();
}

/**
 * Cuts markdown down to a maximum length at a line or word boundary, closing any code block it cuts through.
 *
 * @param {string} markdown - Discord markdown, e.g. from {@link convertMarkdown}.
 * @param {number} maxLength - Maximum length of the result.
 * @returns {string} The markdown, cut short with an ellipsis if it was longer than `maxLength`.
 */
export function truncateMarkdown(markdown: string, maxLength: number): string {
  if (markdown.length <= maxLength) {
    return markdown;
  }
  // Leave room for the ellipsis and a closing code fence
  const closing = `\n${ELLIPSIS}\n\`\`\``;
  let cut = markdown.slice(0, maxLength - closing.length);
  const boundary = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
  if (boundary > cut.length * MIN_BOUNDARY_RATIO) {
    cut = cut.slice(0, boundary);
  }
  cut = cut.trimEnd();

  let openFence = false;
  for (const line of cut.split("\n")) {
    if (CODE_FENCE.test(line)) {
      openFence = !openFence;
    }
  }
  return openFence ? `${cut}${closing}` : `${cut}${ELLIPSIS}`;
}

/**
 * Converts GitHub-flavored markdown for Discord and cuts it down to a maximum length.
 *
 * @param {string | null | undefined} markdown - Markdown from GitHub, e.g. an issue body or comment.
 * @param {number} maxLength - Maximum length of the result.
 * @returns {string | undefined} Discord markdown, or `undefined` if there is nothing to show.
 */
export function formatMarkdown(markdown: string | null | undefined, maxLength: number): string | undefined {
  if (typeof markdown !== "string") {
    return undefined;
  }
  const converted = convertMarkdown(markdown);
  return converted === "" ? undefined : truncateMarkdown(converted, maxLength);
}

/**
 * Prepares text for use as a masked link's label. Discord shows backslash escapes inside a label as-is, so nothing is
 * escaped; instead, brackets that would end the label early are swapped for parentheses. Balanced brackets, as in
 * `renovate[bot]`, are kept.
 *
 * @param {string} text - Plain text from GitHub, e.g. an issue title.
 * @returns {string} Text that can sit between a masked link's square brackets.
 */
export function linkLabel(text: string): string {
  const label = text.replaceAll(/\s+/gv, " ");
  let depth = 0;
  for (const character of label) {
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
    }
    if (depth < 0 || depth > 1) {
      break;
    }
  }
  return depth === 0 ? label : label.replaceAll("[", "(").replaceAll("]", ")");
}
