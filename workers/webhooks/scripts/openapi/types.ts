// A minimal model of the parts of an OpenAPI 3.1 description that the type generator reads.

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type SchemaType = "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

export interface SchemaObject {
  $ref?: string;
  title?: string;
  description?: string;
  format?: string;
  deprecated?: boolean;
  readOnly?: boolean;
  default?: JsonValue;
  example?: JsonValue;
  examples?: JsonValue[];
  type?: SchemaType | SchemaType[];
  nullable?: boolean;
  const?: JsonValue;
  enum?: JsonValue[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: Schema;
  patternProperties?: Record<string, Schema>;
  items?: Schema;
  prefixItems?: Schema[];
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
}

export type Schema = SchemaObject | boolean;

export interface MediaTypeObject {
  schema?: SchemaObject;
}

export interface OperationObject {
  summary?: string;
  requestBody?: { content: Record<string, MediaTypeObject> };
  [extension: `x-${string}`]: unknown;
}

export interface PathItemObject {
  post?: OperationObject;
}

export interface OpenAPIDocument {
  openapi: string;
  webhooks?: Record<string, PathItemObject>;
  components?: { schemas?: Record<string, SchemaObject> };
}
