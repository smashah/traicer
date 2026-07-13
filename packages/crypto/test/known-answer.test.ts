import { describe, expect, test } from "bun:test";

import { constantTimeEqual, sha256Hex } from "../src";

describe("crypto known-answer tests", () => {
  test("matches the NIST SHA-256 abc vector", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  test("compares capabilities without an early content exit", () => {
    expect(constantTimeEqual("same-capability", "same-capability")).toBe(true);
    expect(constantTimeEqual("same-capability", "other-capability")).toBe(false);
  });
});
