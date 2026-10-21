import {
  type APIMessageComponent,
  type APIMessageTopLevelComponent,
  ComponentType,
  MessageFlags,
} from "discord-api-types/v10";

import { stringToUInt8Array } from "../util/index.ts";
import type { MessageBodyByFormat, MessageFormat, SplitComponentsResult } from "./types.ts";

export const MAX_TOTAL_COMPONENTS_PER_MESSAGE = 40;
export const MAX_TEXT_LENGTH_PER_MESSAGE = 4000;

/**
 * A top-level component that, together with everything nested under it, exceeds
 * {@link MAX_TOTAL_COMPONENTS_PER_MESSAGE} or {@link MAX_TEXT_LENGTH_PER_MESSAGE} and so can never be sent in a single
 * message.
 */
export class ComponentLimitError extends Error {
  public override readonly name = "ComponentLimitError";
  /** The offending top-level component, e.g. to forward to a dead-letter queue. */
  public readonly component: APIMessageTopLevelComponent;
  /** Position of the component in the array passed to {@link splitComponentsToMessages}. */
  public readonly index: number;
  /** Total components counted, including the top-level component itself. */
  public readonly componentCount: number;
  /** Total characters of text counted across the component and everything nested under it. */
  public readonly textLength: number;

  public constructor(
    component: APIMessageTopLevelComponent,
    index: number,
    componentCount: number,
    textLength: number,
  ) {
    super(
      `Top-level component at index ${index} contains ${componentCount} total components and ${textLength} characters of text, exceeding the limit of ${MAX_TOTAL_COMPONENTS_PER_MESSAGE} components or ${MAX_TEXT_LENGTH_PER_MESSAGE} characters`,
    );
    this.component = component;
    this.index = index;
    this.componentCount = componentCount;
    this.textLength = textLength;
  }
}

/**
 * Counts a component plus every component nested under it.
 *
 * @param {APIMessageComponent} component - The component to count.
 * @returns {number} The total number of components, including `component` itself.
 */
export function countComponents(component: APIMessageComponent): number {
  switch (component.type) {
    case ComponentType.ActionRow:
    case ComponentType.Container:
      return component.components.reduce((total, child) => total + countComponents(child), 1);
    case ComponentType.Section:
      return component.components.reduce(
        (total, child) => total + countComponents(child),
        1 + countComponents(component.accessory),
      );
    default:
      return 1;
  }
}

/**
 * Counts the characters of text a component displays, plus the text of every component nested under it. Text displays,
 * button labels, and media descriptions all count toward a message's text limit.
 *
 * @param {APIMessageComponent} component - The component to count.
 * @returns {number} The total length of the text displayed by `component` and its children.
 */
export function countTextLength(component: APIMessageComponent): number {
  switch (component.type) {
    case ComponentType.ActionRow:
    case ComponentType.Container:
      return component.components.reduce((total, child) => total + countTextLength(child), 0);
    case ComponentType.Section:
      return component.components.reduce(
        (total, child) => total + countTextLength(child),
        countTextLength(component.accessory),
      );
    case ComponentType.TextDisplay:
      return component.content.length;
    case ComponentType.Button:
      return "label" in component ? component.label.length : 0;
    case ComponentType.Thumbnail:
      return component.description?.length ?? 0;
    case ComponentType.MediaGallery:
      return component.items.reduce((total, item) => total + (item.description?.length ?? 0), 0);
    default:
      return 0;
  }
}

/**
 * Packs top-level components into as few Components V2 messages as possible, preserving order. A component that would
 * push the current message over the component or text limit starts a new message; a component that exceeds either limit
 * on its own is skipped and reported in `errors`.
 *
 * @param {MessageFormat} format - Whether the bodies are for a bot channel message or a webhook execution.
 * @param {APIMessageTopLevelComponent[]} components - Top-level components to send, in order.
 * @returns {SplitComponentsResult} The message bodies to send and which components each one holds, plus an error for
 *   each component that could not fit in any message.
 */
export function splitComponentsToMessages<Format extends MessageFormat>(
  format: Format,
  components: APIMessageTopLevelComponent[],
): SplitComponentsResult<Format> {
  const messages: MessageBodyByFormat[Format][] = [];
  const indices: number[][] = [];
  const errors: ComponentLimitError[] = [];
  let current: APIMessageTopLevelComponent[] = [];
  let currentIndices: number[] = [];
  let currentCount = 0;
  let currentTextLength = 0;

  for (const [index, component] of components.entries()) {
    const count = countComponents(component);
    const textLength = countTextLength(component);
    if (count > MAX_TOTAL_COMPONENTS_PER_MESSAGE || textLength > MAX_TEXT_LENGTH_PER_MESSAGE) {
      errors.push(new ComponentLimitError(component, index, count, textLength));
    } else {
      if (
        currentCount + count > MAX_TOTAL_COMPONENTS_PER_MESSAGE ||
        currentTextLength + textLength > MAX_TEXT_LENGTH_PER_MESSAGE
      ) {
        messages.push({ components: current, flags: MessageFlags.IsComponentsV2 });
        indices.push(currentIndices);
        current = [];
        currentIndices = [];
        currentCount = 0;
        currentTextLength = 0;
      }
      current.push(component);
      currentIndices.push(index);
      currentCount += count;
      currentTextLength += textLength;
    }
  }
  if (current.length > 0) {
    messages.push({ components: current, flags: MessageFlags.IsComponentsV2 });
    indices.push(currentIndices);
  }

  return { messages, indices, errors };
}

export async function verifyDiscordRequest(
  publicKey: string,
  signatureHeader: string,
  timestamp: string,
  body: string,
): Promise<boolean> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    stringToUInt8Array(publicKey, "hex"),
    {
      name: "Ed25519",
      namedCurve: "Ed25519",
    },
    true,
    ["verify"],
  );
  const signature = stringToUInt8Array(signatureHeader, "hex");
  return await crypto.subtle.verify("Ed25519", cryptoKey, signature, new TextEncoder().encode(timestamp + body));
}
