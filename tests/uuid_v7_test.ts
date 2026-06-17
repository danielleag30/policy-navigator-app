import { extractTimestamp, generate, validate } from "@std/uuid/v7";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("generate() emits ordered UUID v7 values within the same millisecond", () => {
  const timestamp = Date.UTC(2026, 0, 1, 0, 0, 0, 123);
  const originalDateNow = Date.now;
  const originalGetRandomValues = crypto.getRandomValues.bind(crypto);
  let nextEntropy = 0;

  // Pin time and entropy so same-millisecond ordering is validated without random chance.
  Date.now = () => timestamp;
  crypto.getRandomValues = ((array: ArrayBufferView) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    let entropy = nextEntropy++;

    bytes.fill(0);
    for (let index = bytes.length - 1; index >= 0; index--) {
      bytes[index] = entropy & 0xff;
      entropy = Math.floor(entropy / 0x100);
    }

    return array;
  }) as Crypto["getRandomValues"];

  try {
    const ids = Array.from({ length: 16 }, () => generate());

    for (const id of ids) {
      assert(validate(id), `Expected a valid UUID v7, received ${id}`);
      assert(
        extractTimestamp(id) === timestamp,
        `Expected UUID ${id} to encode timestamp ${timestamp}`,
      );
    }

    for (let index = 1; index < ids.length; index++) {
      assert(
        ids[index - 1] < ids[index],
        `Expected UUIDs to be monotonically ordered: ${ids[index - 1]} >= ${ids[index]}`,
      );
      assert(
        extractTimestamp(ids[index - 1]) === extractTimestamp(ids[index]),
        "Expected adjacent UUIDs to be generated within the same millisecond",
      );
    }
  } finally {
    Date.now = originalDateNow;
    crypto.getRandomValues = originalGetRandomValues;
  }
});
