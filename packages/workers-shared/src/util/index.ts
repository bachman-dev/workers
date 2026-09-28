export function log(level: "error" | "warn" | "info" = "info", ...items: unknown[]): void {
  console[level](items);
}

export function stringToUInt8Array(value: string, format?: "hex"): Uint8Array {
  if (value === "") {
    return new Uint8Array();
  } else if (format === "hex") {
    const matches = value.match(/.{1,2}/gv);
    if (matches === null) {
      throw new TypeError("Value is not a valid hex string");
    }
    const hexVal = matches.map((byte: string) => Number.parseInt(byte, 16));
    return new Uint8Array(hexVal);
  }
  return new TextEncoder().encode(value);
}

export async function withTimeout<T>(promise: Promise<T>, limit = 5000): Promise<T> {
  const { promise: timeout, reject } = Promise.withResolvers<never>();
  const timeoutId = setTimeout(() => {
    reject(new Error(`Timed out after ${limit}ms`));
  }, limit);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}
