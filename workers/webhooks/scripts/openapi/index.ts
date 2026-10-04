/**
 * Generates TypeScript types from the component schemas in an OpenAPI 3.1 description.
 *
 * It only understands the JSON Schema keywords that affect a value's shape (`type`, `properties`, `allOf`, etc.) and
 * builds the types as plain strings, so it doesn't depend on any version of the TypeScript compiler API.
 */

import type { JsonValue, OpenAPIDocument, Schema, SchemaObject, SchemaType } from "./types.ts";

const SCHEMA_REF_PREFIX = "#/components/schemas/";
const JSON_INDENT = 2;

function isOpenAPI31(value: unknown): value is OpenAPIDocument {
  return (
    typeof value === "object" &&
    value !== null &&
    "openapi" in value &&
    typeof value.openapi === "string" &&
    value.openapi.startsWith("3.1.")
  );
}

function toJSDoc(lines: string[]): string {
  const body = lines.flatMap((line) => line.replaceAll("*/", String.raw`*\/`).split(/\r?\n/v));
  return `/**\n${body.map((line) => ` * ${line}`.trimEnd()).join("\n")}\n */`;
}

// #region Type nodes

/* oxlint-disable no-use-before-define -- Rendering and converting schemas are both mutually recursive. */

interface PropertyNode {
  name: string;
  optional: boolean;
  readonly: boolean;
  type: TypeNode;
  comment: string[];
}

type TypeNode =
  | { kind: "keyword"; name: "boolean" | "never" | "null" | "number" | "string" | "unknown" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "ref"; name: string }
  | { kind: "array"; items: TypeNode }
  | { kind: "tuple"; items: TypeNode[] }
  | { kind: "object"; properties: PropertyNode[] }
  | { kind: "record"; values: TypeNode }
  | { kind: "union"; members: TypeNode[] }
  | { kind: "intersection"; members: TypeNode[] };

const UNKNOWN: TypeNode = { kind: "keyword", name: "unknown" };
const NEVER: TypeNode = { kind: "keyword", name: "never" };
const NULL: TypeNode = { kind: "keyword", name: "null" };

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/v;

function isKeyword(node: TypeNode, name: "never" | "null" | "unknown"): boolean {
  return node.kind === "keyword" && node.name === name;
}

function dedupe(nodes: TypeNode[]): TypeNode[] {
  const unique = new Map<string, TypeNode>();
  for (const node of nodes) {
    const key = renderType(node, "");
    if (!unique.has(key)) {
      unique.set(key, node);
    }
  }
  return [...unique.values()];
}

function union(nodes: TypeNode[]): TypeNode {
  const members = dedupe(
    nodes
      .flatMap((node) => (node.kind === "union" ? node.members : [node]))
      .filter((node) => !isKeyword(node, "never")),
  );
  if (members.some((node) => isKeyword(node, "unknown"))) {
    return UNKNOWN;
  }
  if (members.length <= 1) {
    return members[0] ?? NEVER;
  }
  return { kind: "union", members };
}

function intersection(nodes: TypeNode[]): TypeNode {
  const members = dedupe(
    nodes
      .flatMap((node) => (node.kind === "intersection" ? node.members : [node]))
      .filter((node) => !isKeyword(node, "unknown")),
  );
  if (members.some((node) => isKeyword(node, "never"))) {
    return NEVER;
  }
  if (members.length <= 1) {
    return members[0] ?? UNKNOWN;
  }
  return { kind: "intersection", members };
}

function literal(value: JsonValue): TypeNode {
  if (value === null) {
    return NULL;
  }
  if (Array.isArray(value)) {
    return { kind: "tuple", items: value.map(literal) };
  }
  if (typeof value === "object") {
    const properties = Object.entries(value).map(([name, child]): PropertyNode => {
      return { name, optional: false, readonly: false, type: literal(child), comment: [] };
    });
    return { kind: "object", properties };
  }
  return { kind: "literal", value };
}

function renderPropertyName(name: string): string {
  return IDENTIFIER_PATTERN.test(name) ? name : JSON.stringify(name);
}

function renderProperties(properties: PropertyNode[], indent: string): string {
  return properties
    .map(({ name, optional, readonly, type, comment }) => {
      const doc = comment.length === 0 ? "" : `${toJSDoc(comment).replaceAll("\n", `\n${indent}`)}\n${indent}`;
      const modifier = readonly ? "readonly " : "";
      return `${indent}${doc}${modifier}${renderPropertyName(name)}${optional ? "?" : ""}: ${renderType(type, indent)};`;
    })
    .join("\n");
}

// Renders a type as a member of an array, union or intersection, adding parentheses where precedence requires them.
function renderOperand(node: TypeNode, indent: string, parent: "array" | "intersection" | "union"): string {
  const rendered = renderType(node, indent);
  const needsParentheses =
    node.kind === "union" ? parent !== "union" : node.kind === "intersection" && parent === "array";
  return needsParentheses ? `(${rendered})` : rendered;
}

function renderType(node: TypeNode, indent: string): string {
  switch (node.kind) {
    case "keyword":
      return node.name;
    case "literal":
      return typeof node.value === "string" ? JSON.stringify(node.value) : String(node.value);
    case "ref":
      return `components["schemas"][${JSON.stringify(node.name)}]`;
    case "array":
      return `${renderOperand(node.items, indent, "array")}[]`;
    case "tuple":
      return `[${node.items.map((item) => renderType(item, indent)).join(", ")}]`;
    case "object":
      return node.properties.length === 0 ? "{}" : `{\n${renderProperties(node.properties, `${indent}  `)}\n${indent}}`;
    case "record":
      return `Record<string, ${renderType(node.values, indent)}>`;
    case "union":
    case "intersection": {
      const separator = node.kind === "union" ? " | " : " & ";
      return node.members.map((member) => renderOperand(member, indent, node.kind)).join(separator);
    }
    default:
      throw new TypeError(`Unknown type node ${JSON.stringify(node satisfies never)}`);
  }
}

// #endregion

// #region Schema conversion

// Primitive examples are rendered inline and the rest are fenced. They're not `@example` tags, since oxfmt formats those as
// code, mangling plain values and not settling on a fixed point for fenced ones.
function describeExamples(examples: JsonValue[]): string | undefined {
  if (examples.length === 0) {
    return undefined;
  }
  const label = examples.length === 1 ? "Example:" : "Examples:";
  const rendered = examples.map((example) => JSON.stringify(example, null, JSON_INDENT));
  if (rendered.every((example) => !example.includes("\n") && !example.includes("`"))) {
    return `${label} ${rendered.map((example) => `\`${example}\``).join(", ")}`;
  }
  const blocks = rendered.map((example) => `\`\`\`json\n${example}\n\`\`\``);
  return [label, ...blocks].join("\n\n");
}

// The title, format, description and examples become paragraphs, followed by any tags.
function describeSchema(schema: Schema): string[] {
  if (typeof schema === "boolean") {
    return [];
  }
  const examples = [...(schema.example === undefined ? [] : [schema.example]), ...(schema.examples ?? [])];
  const paragraphs = [
    schema.title,
    schema.format === undefined ? undefined : `Format: ${schema.format}`,
    schema.description,
    describeExamples(examples),
  ]
    .map((paragraph) => paragraph?.trim())
    .filter((paragraph): paragraph is string => paragraph !== undefined && paragraph !== "");
  const tags: string[] = [];
  if (schema.deprecated === true) {
    tags.push("@deprecated");
  }
  if (schema.default !== undefined) {
    tags.push(`@default ${JSON.stringify(schema.default)}`);
  }
  const lines = paragraphs.flatMap((paragraph, index) => (index === 0 ? [paragraph] : ["", paragraph]));
  return tags.length === 0 || lines.length === 0 ? [...lines, ...tags] : [...lines, "", ...tags];
}

function refType(ref: string): TypeNode {
  if (!ref.startsWith(SCHEMA_REF_PREFIX)) {
    throw new Error(`Unsupported reference ${ref}`);
  }
  return { kind: "ref", name: ref.slice(SCHEMA_REF_PREFIX.length) };
}

function isEmptySchema(schema: Schema): boolean {
  return schema === true || (typeof schema === "object" && Object.keys(schema).length === 0);
}

function hasObjectKeywords(schema: SchemaObject): boolean {
  return (
    Object.keys(schema.properties ?? {}).length > 0 ||
    (schema.additionalProperties !== undefined && schema.additionalProperties !== false) ||
    Object.keys(schema.patternProperties ?? {}).length > 0
  );
}

// Properties with a default are treated as required, since the server fills in defaults for the payloads it sends.
function isOptional(schema: SchemaObject, name: string, property: Schema): boolean {
  const hasDefault = typeof property === "object" && property.default !== undefined;
  return schema.required?.includes(name) !== true && !hasDefault;
}

function objectType(schema: SchemaObject): TypeNode {
  const properties = Object.entries(schema.properties ?? {}).map(([name, property]): PropertyNode => {
    return {
      name,
      optional: isOptional(schema, name, property),
      readonly: typeof property === "object" && property.readOnly === true,
      type: schemaToType(property),
      comment: describeSchema(property),
    };
  });
  const { additionalProperties = false } = schema;
  const indexTypes = [
    ...(additionalProperties === false
      ? []
      : [isEmptySchema(additionalProperties) ? UNKNOWN : schemaToType(additionalProperties)]),
    ...Object.values(schema.patternProperties ?? {}).map(schemaToType),
  ];

  if (indexTypes.length === 0) {
    return properties.length === 0 ? { kind: "record", values: NEVER } : { kind: "object", properties };
  }
  const record: TypeNode = { kind: "record", values: union(indexTypes) };
  return properties.length === 0 ? record : intersection([{ kind: "object", properties }, record]);
}

function arrayType(schema: SchemaObject): TypeNode {
  if (schema.prefixItems !== undefined) {
    return { kind: "tuple", items: schema.prefixItems.map(schemaToType) };
  }
  return { kind: "array", items: schema.items === undefined ? UNKNOWN : schemaToType(schema.items) };
}

function coreType(schema: SchemaObject, type: SchemaType): TypeNode {
  switch (type) {
    case "null":
      return NULL;
    case "boolean":
    case "string":
      return { kind: "keyword", name: type };
    case "integer":
    case "number":
      return { kind: "keyword", name: "number" };
    case "array":
      return arrayType(schema);
    case "object":
      // An object without any properties could hold anything, unless additional properties are explicitly disallowed.
      return hasObjectKeywords(schema) || schema.additionalProperties === false
        ? objectType(schema)
        : { kind: "record", values: UNKNOWN };
    default:
      throw new TypeError(`Unknown schema type ${JSON.stringify(type satisfies never)}`);
  }
}

function schemaToType(schema: Schema): TypeNode {
  if (typeof schema === "boolean") {
    return schema ? UNKNOWN : NEVER;
  }
  if (schema.$ref !== undefined) {
    return refType(schema.$ref);
  }

  const types = schema.type === undefined ? undefined : [schema.type].flat();
  const nullable = schema.nullable === true || types?.includes("null") === true;
  if (schema.const !== undefined) {
    return literal(schema.const);
  }
  if (schema.enum !== undefined) {
    return union([...schema.enum.map(literal), ...(nullable ? [NULL] : [])]);
  }

  // GitHub's descriptions often pair compositions with a `type` that only adds `null`, e.g. `{ type: ["null"], allOf:
  // [{ $ref }] }` for a nullable reference, so the compositions decide the type and `type` only decides nullability.
  const compositions = [
    ...(schema.allOf ?? []).map(schemaToType),
    ...(schema.anyOf === undefined ? [] : [union(schema.anyOf.map(schemaToType))]),
    ...(schema.oneOf === undefined ? [] : [union(schema.oneOf.map(schemaToType))]),
  ];
  if (compositions.length > 0) {
    const composed = intersection([...(hasObjectKeywords(schema) ? [objectType(schema)] : []), ...compositions]);
    if (!isKeyword(composed, "unknown")) {
      return nullable ? union([composed, NULL]) : composed;
    }
  }

  if (types === undefined) {
    const type = hasObjectKeywords(schema) ? objectType(schema) : UNKNOWN;
    return nullable ? union([type, NULL]) : type;
  }
  return union([...types.map((type) => coreType(schema, type)), ...(nullable ? [NULL] : [])]);
}

// #endregion

/* oxlint-enable no-use-before-define */

/**
 * Renders component schemas as an exported `components` interface, so that a schema's type can be looked up with
 * `components["schemas"]["name"]`, and references between schemas resolve the same way.
 *
 * @param schemas The component schemas to render, by name.
 * @returns The `components` interface's source code.
 */
function renderComponentSchemas(schemas: Record<string, SchemaObject>): string {
  const properties = Object.entries(schemas).map(([name, schema]): PropertyNode => {
    return { name, optional: false, readonly: false, type: schemaToType(schema), comment: describeSchema(schema) };
  });
  return `export interface components {\n  schemas: {\n${renderProperties(properties, "    ")}\n  };\n}\n`;
}

export { SCHEMA_REF_PREFIX, isOpenAPI31, renderComponentSchemas, toJSDoc };
export type * from "./types.ts";
