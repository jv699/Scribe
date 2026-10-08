import { expect, test } from "bun:test";
import { cliExit } from "../src/cli.ts";
import { VERSION } from "../src/version.ts";

test("no arguments in a terminal starts the app", () => {
  expect(cliExit([], true)).toBeNull();
});

test("--version and -v print the package version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  expect(cliExit(["--version"], true)).toEqual({ output: VERSION, exitCode: 0 });
  expect(cliExit(["-v"], false)).toEqual({ output: VERSION, exitCode: 0 });
});

test("--help describes usage and where settings live", () => {
  const exit = cliExit(["--help"], false);
  expect(exit?.exitCode).toBe(0);
  expect(exit?.output).toContain("Usage: scribe");
  expect(exit?.output).toContain("config.json");
  expect(exit?.output).toContain("SCRIBE_CONFIG_DIR");
});

test("an unknown option fails with a pointer to --help", () => {
  const exit = cliExit(["--nope"], true);
  expect(exit?.exitCode).toBe(1);
  expect(exit?.output).toContain("--nope");
});

test("a non-terminal fails instead of hanging", () => {
  const exit = cliExit([], false);
  expect(exit?.exitCode).toBe(1);
  expect(exit?.output).toContain("terminal");
});
