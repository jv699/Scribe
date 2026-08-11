import { describe, expect, test } from "bun:test";
import { formatDollars, formatDuration, formatTokenCount } from "../src/format.ts";

describe("formatTokenCount", () => {
  test("leaves counts under 1000 alone", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(1)).toBe("1");
    expect(formatTokenCount(950)).toBe("950");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("switches to thousands at exactly 1000", () => {
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(1500)).toBe("1.5k");
    expect(formatTokenCount(128000)).toBe("128k");
  });

  test("keeps one decimal only when it is not a whole number of thousands", () => {
    expect(formatTokenCount(45300)).toBe("45.3k");
    expect(formatTokenCount(45000)).toBe("45k");
  });

  test("handles millions without a separate unit", () => {
    expect(formatTokenCount(1000000)).toBe("1000k");
  });
});

describe("formatDuration", () => {
  test("shows one decimal of seconds", () => {
    expect(formatDuration(340)).toBe("0.3s");
    expect(formatDuration(4312)).toBe("4.3s");
    expect(formatDuration(59900)).toBe("59.9s");
  });

  test("floors at 0.1s so an instant tool never reads as no time at all", () => {
    expect(formatDuration(0)).toBe("0.1s");
    expect(formatDuration(12)).toBe("0.1s");
  });

  test("rolls over to minutes at 60s", () => {
    expect(formatDuration(60000)).toBe("1m 0s");
    expect(formatDuration(72400)).toBe("1m 12s");
    expect(formatDuration(3_600_000)).toBe("60m 0s");
  });

  // Regression: rounding after the split let the seconds field reach 60, so a
  // shade under two minutes read as "1m 60s" and a shade under one as "60.0s".
  test("never shows 60 in the seconds field", () => {
    expect(formatDuration(59_960)).toBe("1m 0s");
    expect(formatDuration(119_600)).toBe("2m 0s");
    expect(formatDuration(119_999)).toBe("2m 0s");
    expect(formatDuration(3_599_900)).toBe("60m 0s");
  });
});

describe("formatDollars", () => {
  test("uses four decimals below a cent", () => {
    expect(formatDollars(0)).toBe("$0.0000");
    expect(formatDollars(0.0001)).toBe("$0.0001");
    expect(formatDollars(0.0099)).toBe("$0.0099");
  });

  test("uses two decimals at and above a cent", () => {
    expect(formatDollars(0.01)).toBe("$0.01");
    expect(formatDollars(0.025)).toBe("$0.03");
    expect(formatDollars(12.5)).toBe("$12.50");
  });
});
