import { reset } from "cloudflare:test";
import { afterEach } from "vitest";

afterEach(async () => {
  // Every test starts with empty Durable Object storage
  await reset();
});
