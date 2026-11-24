import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import worker from "../src/index.ts";
import Screener from "../src/screener.ts";
import { screenerStub } from "./env.ts";

vi.setConfig({ testTimeout: 10_000 });

describe("mail-screener", () => {
  it("loads with an email handler", () => {
    expect.hasAssertions();

    expect(worker.email).toBeTypeOf("function");
  });

  it("runs the Screener Durable Object in the pool", async () => {
    expect.hasAssertions();
    const stub = screenerStub();

    await expect(stub.ping()).resolves.toBe("ok");
    await expect(runInDurableObject(stub, (instance) => instance instanceof Screener)).resolves.toBe(true);
  });
});
