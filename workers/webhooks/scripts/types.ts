/**
 * Generates TypeScript types from OpenAPI specs.
 *
 * Run it with `pnpm types:openapi` so that `oxfmt` is on the PATH.
 */

import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import openapiTS, { type OpenAPI3, type OperationObject, type SchemaObject, astToString } from "openapi-typescript";

const SCHEMA_REF_PREFIX = "#/components/schemas/";

const workerRoot = path.resolve(import.meta.dirname, "..");
const oxfmtConfig = path.resolve(workerRoot, "../../oxfmt.config.ts");

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function isOpenAPI31(value: unknown): value is OpenAPI3 {
  return (
    typeof value === "object" &&
    value !== null &&
    "openapi" in value &&
    typeof value.openapi === "string" &&
    value.openapi.startsWith("3.1.")
  );
}

// Collects every component schema referenced by a value, including the schemas those schemas reference.
function collectSchemas(
  allSchemas: Record<string, SchemaObject>,
  value: unknown,
  collected: Record<string, SchemaObject> = {},
): Record<string, SchemaObject> {
  if (typeof value !== "object" || value === null) {
    return collected;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== "$ref" || typeof child !== "string") {
      collectSchemas(allSchemas, child, collected);
    } else if (child.startsWith(SCHEMA_REF_PREFIX)) {
      const name = child.slice(SCHEMA_REF_PREFIX.length);
      const schema = allSchemas[name];
      if (schema === undefined) {
        throw new Error(`Schema ${name} not found`);
      }
      if (!(name in collected)) {
        collected[name] = schema;
        collectSchemas(allSchemas, schema, collected);
      }
    } else {
      throw new Error(`Unexpected reference ${child}`);
    }
  }
  return collected;
}

function toJSDoc(lines: string[]): string {
  const body = lines.flatMap((line) => line.replaceAll("*/", String.raw`*\/`).split("\n"));
  return `/**\n${body.map((line) => ` * ${line}`.trimEnd()).join("\n")}\n */`;
}

// The first oxfmt pass wraps JSDoc comments before re-indenting them, which can leave them wrapped at the wrong width,
// so generated files get a second pass.
function formatFile(filePath: string): void {
  const args = ["--config", oxfmtConfig, "--write", filePath];
  execFileSync("oxfmt", args, { stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("oxfmt", args, { stdio: ["ignore", "ignore", "inherit"] });
}

// The types openapi-typescript generates for `enum` schemas are plain unions, so its `@enum` JSDoc tags are just noise.
function stripEnumTags(code: string): string {
  return code
    .replaceAll(/^[ \t]*\/\*\* @enum \{[^\}]+\} \*\/\n/gmv, "")
    .replaceAll(/^[ \t]*\* @enum \{[^\}]+\}\n/gmv, "");
}

// #region GitHub webhooks

const GITHUB_DESCRIPTIONS_API_URL =
  "https://api.github.com/repos/github/rest-api-description/contents/descriptions-next/api.github.com?ref=main";
const GITHUB_DESCRIPTIONS_RAW_URL =
  "https://raw.githubusercontent.com/github/rest-api-description/refs/heads/main/descriptions-next/api.github.com";
const GITHUB_DESCRIPTION_PATTERN = /^api\.github\.com\.(?<version>\d{4}-\d{2}-\d{2})\.json$/v;
const GITHUB_WEBHOOKS_DOCS_URL = "https://docs.github.com/webhooks/webhook-events-and-payloads";
const GITHUB_TYPES_PATH = path.join(workerRoot, "src/types/github.ts");

interface GitHubWebhookEvent {
  summary: string | undefined;
  schemas: Set<string>;
}

// Finds the newest API version (e.g. `2026-03-10`) with a github.com description on the main branch.
async function findLatestGitHubApiVersion(): Promise<string> {
  const response = await fetch(GITHUB_DESCRIPTIONS_API_URL, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) {
    throw new Error(`Failed to list GitHub API descriptions: ${response.status} ${response.statusText}`);
  }
  const contents: unknown = await response.json();
  if (!Array.isArray(contents)) {
    throw new TypeError("Expected a directory listing of GitHub API descriptions");
  }

  const versions = contents.flatMap((content: unknown) => {
    const name = typeof content === "object" && content !== null && "name" in content ? content.name : undefined;
    const version = typeof name === "string" ? GITHUB_DESCRIPTION_PATTERN.exec(name)?.groups?.version : undefined;
    return version === undefined ? [] : [version];
  });
  const latest = versions.toSorted().at(-1);
  if (latest === undefined) {
    throw new Error("No versioned api.github.com description found");
  }
  return latest;
}

// The spec's `X-GitHub-Event` header examples are wrong for a few events (e.g. `discussions` instead of `discussion`),
// so the event name comes from the webhook's subcategory instead, which is sometimes kebab-case.
function getGitHubEventName(operation: OperationObject): string | undefined {
  const extension: unknown = operation["x-github"];
  if (
    typeof extension === "object" &&
    extension !== null &&
    "subcategory" in extension &&
    typeof extension.subcategory === "string"
  ) {
    return extension.subcategory.replaceAll("-", "_");
  }
  return undefined;
}

function getPayloadSchemaName(operation: OperationObject): string | undefined {
  const { requestBody } = operation;
  const mediaType =
    requestBody === undefined || "$ref" in requestBody ? undefined : requestBody.content["application/json"];
  const schema = mediaType === undefined || "$ref" in mediaType ? undefined : mediaType.schema;
  return schema !== undefined && "$ref" in schema ? schema.$ref.slice(SCHEMA_REF_PREFIX.length) : undefined;
}

// Groups the spec's webhook payload schemas by event name, sorted by event name.
function getGitHubWebhookEvents(spec: OpenAPI3): Map<string, GitHubWebhookEvent> {
  const events = new Map<string, GitHubWebhookEvent>();
  for (const [webhookId, pathItem] of Object.entries(spec.webhooks ?? {})) {
    const operation = "$ref" in pathItem ? undefined : pathItem.post;
    if (operation === undefined || "$ref" in operation) {
      throw new Error(`Webhook ${webhookId} has no POST operation`);
    }
    const name = getGitHubEventName(operation);
    const schemaName = getPayloadSchemaName(operation);
    if (name === undefined || schemaName === undefined) {
      throw new Error(`Webhook ${webhookId} is missing its event name or payload schema`);
    }

    const event = events.get(name) ?? { summary: operation.summary, schemas: new Set() };
    event.schemas.add(schemaName);
    events.set(name, event);
  }
  return new Map([...events].toSorted(([left], [right]) => left.localeCompare(right)));
}

// GitHub always sends an `action` with the events that have one, but the spec doesn't always mark it as required.
// Making it required lets `action` narrow a payload union without having to handle `undefined`.
function requireAction(schema: SchemaObject): void {
  for (const variant of schema.oneOf ?? [schema]) {
    if (
      !("$ref" in variant) &&
      "properties" in variant &&
      variant.properties.action !== undefined &&
      variant.required?.includes("action") !== true
    ) {
      variant.required = [...(variant.required ?? []), "action"];
    }
  }
}

function renderGitHubWebhookHelpers(events: Map<string, GitHubWebhookEvent>): string {
  const eventNames = [...events].map(([name, { summary }]) => {
    const see = `@see {@link ${GITHUB_WEBHOOKS_DOCS_URL}#${name}}`;
    const key = name.replaceAll(/(?:^|_)(?<letter>[a-z\d])/gv, (_match, letter: string) => letter.toUpperCase());
    return `${toJSDoc(summary === undefined ? [see] : [summary, "", see])}\n${key}: "${name}",`;
  });
  const payloads = [...events].map(([name, { schemas }]) => {
    const union = [...schemas].map((schema) => `components["schemas"]["${schema}"]`).join(" | ");
    return `${toJSDoc([`@see {@link ${GITHUB_WEBHOOKS_DOCS_URL}#${name}}`])}\n${name}: ${union};`;
  });

  return `
/** GitHub webhook event names, as sent in the \`X-GitHub-Event\` header. */
export const GithubWebhookEventName = {
${eventNames.join("\n")}
} as const;
export type GithubWebhookEventName = (typeof GithubWebhookEventName)[keyof typeof GithubWebhookEventName];

const webhookEventNames: ReadonlySet<string> = new Set(Object.values(GithubWebhookEventName));

/** Checks whether an \`X-GitHub-Event\` header value is a known webhook event name. */
export function isGithubWebhookEventName(name: string | undefined): name is GithubWebhookEventName {
  return name !== undefined && webhookEventNames.has(name);
}

/** Maps each webhook event name to the union of its payloads. */
export interface GithubWebhookPayloadMap {
${payloads.join("\n")}
}

/** The request body for a webhook event; payloads with an \`action\` can be narrowed by it. */
export type GithubWebhookPayload<Name extends GithubWebhookEventName = GithubWebhookEventName> = GithubWebhookPayloadMap[Name];

/** The possible \`action\` values for a webhook event, or \`never\` if its payloads don't have one. */
export type GithubWebhookAction<Name extends GithubWebhookEventName = GithubWebhookEventName> = Extract<
  GithubWebhookPayload<Name>,
  { action: unknown }
>["action"];

/** A webhook event name paired with its payload; narrow it by \`name\`, then by \`payload.action\`. */
export type GithubWebhookEvent<Name extends GithubWebhookEventName = GithubWebhookEventName> = {
  [N in Name]: { event: N; payload: GithubWebhookPayloadMap[N] };
}[Name];

/**
 * Checks whether a request's \`X-GitHub-Event\` header value is a known webhook event name, narrowing the request body
 * to that event's payloads. The body itself isn't validated, so only trust requests with a verified signature.
 */
export function isGithubWebhookEvent(webhook: { event: string | undefined; payload: unknown }): webhook is GithubWebhookEvent {
  return isGithubWebhookEventName(webhook.event);
}
`;
}

// Downloads the latest github.com API description into `tempDir` and generates types for its webhook payloads.
async function generateGitHubWebhookTypes(tempDir: string): Promise<void> {
  const version = await findLatestGitHubApiVersion();
  const fileName = `api.github.com.${version}.json`;
  const url = `${GITHUB_DESCRIPTIONS_RAW_URL}/${fileName}`;
  log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`Failed to download ${fileName}: ${response.status} ${response.statusText}`);
  }
  const specPath = path.join(tempDir, fileName);
  await fs.writeFile(specPath, response.body);

  const spec: unknown = JSON.parse(await fs.readFile(specPath, "utf8"));
  if (!isOpenAPI31(spec)) {
    throw new TypeError(`${fileName} is not an OpenAPI 3.1 description`);
  }
  const events = getGitHubWebhookEvents(spec);
  const payloadSchemas = events
    .values()
    .flatMap(({ schemas }) => schemas)
    .toArray();
  const schemas = collectSchemas(
    spec.components?.schemas ?? {},
    payloadSchemas.map((name) => {
      return { $ref: `${SCHEMA_REF_PREFIX}${name}` };
    }),
  );
  for (const name of payloadSchemas) {
    const schema = schemas[name];
    if (schema !== undefined) {
      requireAction(schema);
    }
  }

  log(`Generating types for ${events.size} webhook events (${payloadSchemas.length} payloads)`);
  const ast = await openapiTS(
    { openapi: spec.openapi, info: spec.info, paths: {}, components: { schemas } } satisfies OpenAPI3,
    { silent: true },
  );
  const header = toJSDoc([
    `GitHub webhook payload types, generated from ${fileName} in github/rest-api-description.`,
    "",
    "Do not edit this file by hand; run `pnpm types:openapi` to regenerate it.",
  ]);
  const helpers = renderGitHubWebhookHelpers(events);
  await fs.writeFile(GITHUB_TYPES_PATH, `${header}\n${helpers}\n${stripEnumTags(astToString(ast))}`);

  formatFile(GITHUB_TYPES_PATH);
  log(`Wrote ${path.relative(workerRoot, GITHUB_TYPES_PATH)}`);
}

// #endregion

const tempDir = await fs.mkdtemp(path.join(tmpdir(), "webhooks-openapi-"));
try {
  await generateGitHubWebhookTypes(tempDir);
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}
