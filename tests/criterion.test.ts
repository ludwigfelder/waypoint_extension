import { describe, expect, test } from "bun:test";
import { criterionKey, isHumanCriterion } from "../src/extension/criterion";

describe("criterionKey", () => {
  test("is deterministic 8-hex", () => {
    expect(criterionKey("#C1 `bun test` exits 0")).toBe(criterionKey("#C1 `bun test` exits 0"));
    expect(criterionKey("#C1 `bun test` exits 0")).toMatch(/^[0-9a-f]{8}$/);
  });

  test("differs across texts", () => {
    expect(criterionKey("#C1 run the tests")).not.toBe(criterionKey("#C2 run the tests"));
    expect(criterionKey("a")).not.toBe(criterionKey("b"));
  });
});

describe("isHumanCriterion", () => {
  test("detects @human with and without an #ID prefix", () => {
    expect(isHumanCriterion("@human check the layout")).toBe(true);
    expect(isHumanCriterion("#C3 @human The login page reads well")).toBe(true);
  });

  test("plain criteria are not human", () => {
    expect(isHumanCriterion("#C1 `bun test` exits 0")).toBe(false);
    expect(isHumanCriterion("verify with @human help later")).toBe(false);
    expect(isHumanCriterion("")).toBe(false);
  });
});
