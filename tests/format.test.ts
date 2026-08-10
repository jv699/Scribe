import { describe, expect, test } from "bun:test";
import { formatDollars, formatTokenCount } from "../src/format.ts";

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
