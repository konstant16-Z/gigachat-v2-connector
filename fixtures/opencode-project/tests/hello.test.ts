import { describe, expect, test } from "bun:test";
import { greet } from "../src/hello";

describe("greet", () => {
  test("greets by name", () => {
    expect(greet("OpenCode")).toBe("Hello, OpenCode!");
  });
});