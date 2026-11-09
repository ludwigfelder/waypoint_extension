import { beforeEach, describe, expect, test } from "bun:test";
import "./setup-dom";

const {
  CARD_DEFAULT_W,
  CARD_MIN_W,
  CARD_MAX_W,
  clampCardWidth,
  loadCardWidth,
  saveCardWidth,
} = await import("../src/webview/lib/layout");

beforeEach(() => localStorage.clear());

describe("card width store", () => {
  test("defaults to 720 when nothing is stored", () => {
    expect(loadCardWidth()).toBe(CARD_DEFAULT_W);
    expect(CARD_DEFAULT_W).toBe(720);
  });

  test("round-trips and clamps to the allowed range", () => {
    saveCardWidth(800);
    expect(loadCardWidth()).toBe(800);
    saveCardWidth(100);
    expect(loadCardWidth()).toBe(CARD_MIN_W);
    saveCardWidth(5000);
    expect(loadCardWidth()).toBe(CARD_MAX_W);
    expect(clampCardWidth(719.6)).toBe(720);
  });

  test("garbage in storage falls back to the default", () => {
    localStorage.setItem("wp-art-w", "not-a-number");
    expect(loadCardWidth()).toBe(CARD_DEFAULT_W);
  });
});
