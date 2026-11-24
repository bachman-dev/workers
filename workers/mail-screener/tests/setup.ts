import { reset } from "cloudflare:test";
import { afterEach } from "vitest";

afterEach(async () => {
  // Every test starts with an empty Screener
  await reset();
});
