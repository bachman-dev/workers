import {
  type APIMessageComponent,
  type APIMessageTopLevelComponent,
  ComponentType,
  MessageFlags,
} from "discord-api-types/v10";

import { stringToUInt8Array } from "../util/index.ts";
import type { MessageBodyByFormat, MessageFormat, SplitComponentsResult } from "./types.ts";

export const MAX_TOTAL_COMPONENTS_PER_MESSAGE = 40;

/**
 * A top-level component that, together with everything nested under it, exceeds
 * {@link MAX_TOTAL_COMPONENTS_PER_MESSAGE} and so can never be sent in a single message.
 */
export class ComponentLimitError extends Error {
  public override readonly name = "ComponentLimitError";
  /** The offending top-level component, e.g. to forward to a dead-letter queue. */
  public readonly component: APIMessageTopLevelComponent;
  /** Position of the component in the array passed to {@link splitComponentsToMessages}. */
  public readonly index: number;
  /** Total components counted, including the top-level component itself. */
  public readonly componentCount: number;

  public constructor(component: APIMessageTopLevelComponent, index: number, componentCount: number) {
    super(
      `Top-level component at index ${index} contains ${componentCount} total components, exceeding the limit of ${MAX_TOTAL_COMPONENTS_PER_MESSAGE}`,
    );
    this.component = component;
    this.index = index;
    this.componentCount = componentCount;
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
 * Packs top-level components into as few Components V2 messages as possible, preserving order. A component that would
 * push the current message over the limit starts a new message; a component that exceeds the limit on its own is
 * skipped and reported in `errors`.
 *
 * @param {MessageFormat} format - Whether the bodies are for a bot channel message or a webhook execution.
 * @param {APIMessageTopLevelComponent[]} components - Top-level components to send, in order.
 * @returns {SplitComponentsResult} The message bodies to send, plus an error for each component that could not fit in
 *   any message.
 */
export function splitComponentsToMessages<Format extends MessageFormat>(
  format: Format,
  components: APIMessageTopLevelComponent[],
): SplitComponentsResult<Format> {
  const messages: MessageBodyByFormat[Format][] = [];
  const errors: ComponentLimitError[] = [];
  let current: APIMessageTopLevelComponent[] = [];
  let currentCount = 0;

  for (const [index, component] of components.entries()) {
    const count = countComponents(component);
    if (count > MAX_TOTAL_COMPONENTS_PER_MESSAGE) {
      errors.push(new ComponentLimitError(component, index, count));
    } else {
      if (currentCount + count > MAX_TOTAL_COMPONENTS_PER_MESSAGE) {
        messages.push({ components: current, flags: MessageFlags.IsComponentsV2 });
        current = [];
        currentCount = 0;
      }
      current.push(component);
      currentCount += count;
    }
  }
  if (current.length > 0) {
    messages.push({ components: current, flags: MessageFlags.IsComponentsV2 });
  }

  return { messages, errors };
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
