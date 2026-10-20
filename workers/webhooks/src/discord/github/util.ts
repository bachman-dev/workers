import { escapeMarkdown, formatMarkdown } from "../markdown.ts";
import { type GithubRepository, type GithubUser, markdownLink, userLink } from "../message.ts";

// GitHub shows the first seven characters of a commit SHA
const SHORT_SHA_LENGTH = 7;

/** Maximum length of a long markdown section, e.g. a comment or an issue body. */
export const BODY_LENGTH = 1500;
/** Maximum length of a secondary markdown section, e.g. a check run summary or a deleted comment. */
export const EXCERPT_LENGTH = 500;

export interface GithubIssueLike {
  number: number;
  title: string;
  html_url?: string | undefined;
}

/**
 * Formats GitHub markdown from a comment, issue body, etc. for Discord.
 *
 * @param {string | null | undefined} markdown - Markdown from GitHub.
 * @param {number} maxLength - Maximum length of the result.
 * @returns {string | undefined} Discord markdown, or `undefined` if there is nothing to show.
 */
export function formatBody(markdown: string | null | undefined, maxLength = BODY_LENGTH): string | undefined {
  return formatMarkdown(markdown, maxLength);
}

/**
 * Shows text, e.g. a branch name, as inline code.
 *
 * @param {string} text - The text to show.
 * @returns {string} The text wrapped in backticks.
 */
export function code(text: string): string {
  return `\`${text.replaceAll("`", "'")}\``;
}

/**
 * Shortens a commit SHA the same way GitHub does.
 *
 * @param {string} sha - A full commit SHA.
 * @returns {string} The first seven characters of the SHA.
 */
export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

/**
 * Builds a URL for a path under a repository, encoding characters that would break a markdown link.
 *
 * @param {GithubRepository} repository - The repository the path is under.
 * @param {string[]} segments - Path segments, e.g. `["tree", "main"]`; branch names may contain slashes.
 * @returns {string} The URL.
 */
export function repositoryUrl(repository: GithubRepository, ...segments: string[]): string {
  return `${repository.html_url}/${encodeURI(segments.join("/")).replaceAll("(", "%28").replaceAll(")", "%29")}`;
}

/**
 * Links to a commit with its short SHA as inline code.
 *
 * @param {GithubRepository} repository - The repository the commit is in.
 * @param {string} sha - The full commit SHA.
 * @param {string} url - Where to link to, if not the commit page itself.
 * @returns {string} A markdown link.
 */
export function commitLink(
  repository: GithubRepository,
  sha: string,
  url = repositoryUrl(repository, "commit", sha),
): string {
  return `[${code(shortSha(sha))}](${url})`;
}

/**
 * Links to a branch or tag with its name as inline code.
 *
 * @param {GithubRepository} repository - The repository the branch is in.
 * @param {string} name - The branch or tag name.
 * @returns {string} A markdown link.
 */
export function refLink(repository: GithubRepository, name: string): string {
  return `[${code(name)}](${repositoryUrl(repository, "tree", name)})`;
}

/**
 * Links to an issue, pull request, or discussion as `#123 Title`, prefixed with its repository if it is in a different
 * one than the event's.
 *
 * @param {GithubIssueLike} issue - The issue, pull request, or discussion to link to.
 * @param {string | undefined} repositoryName - The full name of the issue's repository, if it differs from the event's.
 * @returns {string} A markdown link.
 */
export function issueLink(issue: GithubIssueLike, repositoryName?: string): string {
  return markdownLink(`${repositoryName ?? ""}#${issue.number} ${issue.title}`, issue.html_url);
}

/**
 * Turns a GitHub enum value like `not_planned` into words like `not planned`.
 *
 * @param {string} value - The enum value.
 * @returns {string} The value as plain, escaped words.
 */
export function humanize(value: string): string {
  return escapeMarkdown(value.replaceAll(/[_\-]/gv, " "));
}

/**
 * Describes who an issue, pull request, or alert was assigned to or unassigned from.
 *
 * @param {string} verb - What happened, e.g. "Assigned to".
 * @param {GithubUser | null | undefined} assignee - The user the event is about.
 * @returns {string | undefined} A markdown line, or `undefined` if there is no assignee.
 */
export function assigneeLine(verb: string, assignee: GithubUser | null | undefined): string | undefined {
  return assignee === null || assignee === undefined ? undefined : `${verb} ${userLink(assignee)}`;
}
