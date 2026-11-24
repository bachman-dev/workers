import { orgDomain } from "../src/durable/screener/decide.ts";
import type { Sender } from "../src/types/screener.ts";

/**
 * Builds a sender the way the worker would parse one.
 *
 * @param {string} address - The normalized address.
 * @param {Partial<Sender>} overrides - Fields to set, e.g. `dmarc` or `name`.
 * @returns {Sender} The sender.
 */
export default function makeSender(address: string, overrides: Partial<Sender> = {}): Sender {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  return { address, name: null, domain, org: orgDomain(domain), dmarc: "pass", ...overrides };
}
