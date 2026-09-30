import { describe, expect, test } from "bun:test";
import {
  MAX_LOCATIONS,
  MAX_NAME_LENGTH,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  hasMapSchematic,
  parseMapSpec,
  renderMap,
  toAscii,
  type MapSpec,
} from "../src/map.ts";

function spec(args: Record<string, unknown>): MapSpec {
  const parsed = parseMapSpec(args, "Fallback");
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  return parsed.value;
}

function draw(args: Record<string, unknown>): string {
  const page = renderMap(spec(args));
  if (!page.ok) throw new Error(page.errors.join("; "));
  return page.value;
}

function errors(args: Record<string, unknown>): string[] {
  const parsed = parseMapSpec(args, "Fallback");
  if (!parsed.ok) return parsed.errors;
  const page = renderMap(parsed.value);
  return page.ok ? [] : page.errors;
}

/** The map rows between the title and legend rules, without the frame. */
function mapRows(page: string): string[] {
  const lines = page.split("\n");
  const rules = lines.flatMap((line, index) => (line.startsWith("+--") ? [index] : []));
  return lines.slice(rules[1]! + 1, rules[2]).map((line) => line.slice(2, -2));
}

const abbey = {
  title: "The Sunken Abbey",
  locations: [
    { id: 1, name: "Gate", column: 2, row: 1, size: "small" },
    { id: 2, name: "Barracks", column: 1, row: 2 },
    { id: 3, name: "Courtyard", column: 2, row: 2, size: "large" },
    { id: 4, name: "Chapel", column: 3, row: 2 },
    { id: 5, name: "Great Hall", column: 2, row: 3, size: "large" },
    { id: 6, name: "Crypt", column: 3, row: 3 },
  ],
  connections: [
    { from: 1, to: 3 },
    { from: 2, to: 3, type: "door" },
    { from: 3, to: 4 },
    { from: 3, to: 5, type: "locked" },
    { from: 4, to: 6, type: "secret" },
    { from: 5, to: 6 },
  ],
};

describe("hasMapSchematic", () => {
  test("recognizes the prompt's ## Map section, and nothing looser", () => {
    expect(hasMapSchematic("## Hook\n\nx\n\n## Map\n\n```text\n[1 Gate]\n```")).toBe(true);
    expect(hasMapSchematic("## map of the abbey\n")).toBe(true);
    expect(hasMapSchematic("### Map\n")).toBe(false);
    expect(hasMapSchematic("## Mapping the stars\n")).toBe(false);
    expect(hasMapSchematic("The map is lost.")).toBe(false);
  });
});

describe("parseMapSpec", () => {
  test("coerces what models actually send", () => {
    const parsed = spec({
      locations: JSON.stringify([
        { id: "1", name: "  Gate  ", column: "1", row: 1 },
        { id: 2, name: "Hall", column: 2, row: 1, size: "enormous" },
      ]),
      connections: [{ from: "1", to: 2, type: "Secret Door" }],
    });
    expect(parsed.title).toBe("Fallback");
    expect(parsed.locations).toEqual([
      { id: 1, name: "Gate", column: 1, row: 1, size: "medium" },
      { id: 2, name: "Hall", column: 2, row: 1, size: "medium" },
    ]);
    expect(parsed.connections).toEqual([{ from: 1, to: 2, type: "secret" }]);
  });

  test("defaults a missing connection type to open and drops a pair listed twice", () => {
    const parsed = spec({
      locations: [
        { id: 1, name: "A", column: 1, row: 1 },
        { id: 2, name: "B", column: 2, row: 1 },
      ],
      connections: [{ from: 1, to: 2 }, { from: 2, to: 1, type: "door" }],
    });
    expect(parsed.connections).toEqual([{ from: 1, to: 2, type: "open" }]);
  });

  test("reports every problem at once, by location and connection", () => {
    const problems = errors({
      locations: [
        { id: 1, name: "A", column: 1, row: 1 },
        { id: 1, name: "Again", column: 2, row: 1 },
        { id: 2, name: "B", column: 1, row: 1 },
        { id: 3, name: "", column: 7, row: 6 },
      ],
      connections: [
        { from: 1, to: 9 },
        { from: 2, to: 2 },
        { from: 1, to: 2, type: "portal" },
      ],
    });
    expect(problems).toEqual([
      "location 1: id is used more than once",
      "location 2: column 1, row 1 is already taken by location 1",
      "location 3: name is required",
      "location 3: column must be 1-6",
      "location 3: row must be 1-5",
      "connection 1-9: there is no location 9",
      "connection 2-2: a location cannot connect to itself",
      "connection 1-2: type must be one of open, door, locked, secret, stairs, one-way",
    ]);
  });

  test("caps a page at MAX_LOCATIONS", () => {
    const locations = Array.from({ length: MAX_LOCATIONS + 1 }, (_, i) => ({
      id: i + 1,
      name: `Room ${i + 1}`,
      column: (i % 6) + 1,
      row: Math.floor(i / 6) + 1,
    }));
    expect(errors({ locations, connections: [] })[0]).toContain(`at most ${MAX_LOCATIONS} locations`);
  });

  test("caps names, so one long name can't stretch the key over the map", () => {
    const layout = (name: string) => ({ locations: [{ id: 1, name, column: 1, row: 1 }], connections: [] });
    expect(errors(layout("x".repeat(MAX_NAME_LENGTH)))).toEqual([]);
    expect(errors(layout("x".repeat(MAX_NAME_LENGTH + 1)))).toEqual([
      `location 1: name must be at most ${MAX_NAME_LENGTH} characters; use a short name`,
    ]);
  });

  test("a full page of longest names keeps a three-column key", () => {
    const locations = Array.from({ length: MAX_LOCATIONS }, (_, i) => ({
      id: i + 1,
      name: "x".repeat(MAX_NAME_LENGTH),
      column: (i % 4) + 1,
      row: Math.floor(i / 4) + 1,
    }));
    const lines = draw({ locations, connections: [] }).split("\n");
    const keyLines = lines.filter((line) => /^\| \d+ x/.test(line));
    expect(keyLines).toHaveLength(Math.ceil(MAX_LOCATIONS / 3));
  });

  test("rejects non-array layouts", () => {
    expect(errors({ locations: "not json", connections: [] })).toEqual(["locations must be an array"]);
  });
});

describe("toAscii", () => {
  test("folds typography and accents so every line keeps its width", () => {
    expect(toAscii("Café — “Nöel’s” Rest…")).toBe('Cafe - "Noel\'s" Rest...');
    expect(toAscii("Dragon 🐉 Lair")).toBe("Dragon Lair");
    // A backtick run would close the map file's code fence.
    expect(toAscii("Vault ```")).toBe("Vault '''");
  });
});

describe("renderMap", () => {
  test("draws a fixed-size, pure-ASCII page", () => {
    const lines = draw(abbey).split("\n");
    expect(lines).toHaveLength(PAGE_HEIGHT);
    for (const line of lines) {
      expect(line).toHaveLength(PAGE_WIDTH);
      expect(line).toMatch(/^[\x20-\x7e]+$/);
    }
    expect(lines[1]).toContain("THE SUNKEN ABBEY");
  });

  test("labels rooms, and lists the legend and key", () => {
    const page = draw(abbey);
    for (const name of ["Barracks", "Courtyard", "Chapel", "Great Hall", "Crypt"]) {
      expect(mapRows(page).join("\n")).toContain(name);
    }
    expect(page).toContain("Legend:  --- passage  -D- door  -L- locked  ... secret");
    // Only the connection types the map uses.
    expect(page).not.toContain("stairs");
    expect(page).toMatch(/1 Gate +2 Barracks +3 Courtyard +4 Chapel/);
  });

  test("marks a door mid-corridor between rooms in one row", () => {
    const rows = mapRows(draw(abbey));
    expect(rows.some((row) => /Barracks +\|-+D-+\|/.test(row))).toBe(true);
  });

  test("draws secret passages dotted", () => {
    const rows = mapRows(draw(abbey));
    expect(rows.filter((row) => row.includes(":")).length).toBeGreaterThan(1);
  });

  test("points one-way arrows from `from` to `to`", () => {
    const layout = (from: number, to: number) => ({
      locations: [
        { id: 1, name: "West", column: 1, row: 1 },
        { id: 2, name: "East", column: 2, row: 1 },
      ],
      connections: [{ from, to, type: "one-way" }],
    });
    const eastward = mapRows(draw(layout(1, 2))).join("\n");
    const westward = mapRows(draw(layout(2, 1))).join("\n");
    expect(eastward).toContain(">");
    expect(eastward).not.toContain("<");
    expect(westward).toContain("<");
  });

  test("turns a corner for locations in different rows and columns", () => {
    const rows = mapRows(
      draw({
        locations: [
          { id: 1, name: "Top", column: 1, row: 1 },
          { id: 2, name: "Bottom", column: 2, row: 2 },
        ],
        connections: [{ from: 1, to: 2, type: "stairs" }],
      }),
    );
    // Out of Top's east wall, stairs marked mid-leg, then the turn down to Bottom.
    const corner = rows.findIndex((row) => /Top +\|-+#-+\+ /.test(row));
    expect(corner).toBeGreaterThan(-1);
    const turnAt = rows[corner]!.lastIndexOf("+");
    expect(rows[corner + 1]![turnAt]).toBe("|");
  });

  test("refuses a corridor that would cross another location", () => {
    expect(
      errors({
        locations: [
          { id: 1, name: "A", column: 1, row: 1 },
          { id: 2, name: "B", column: 2, row: 1 },
          { id: 3, name: "C", column: 3, row: 1 },
        ],
        connections: [{ from: 1, to: 3 }],
      }),
    ).toEqual([
      "connection 1-3: every route crosses another location's cell; move one of them, or connect through the location in between",
    ]);
  });

  test("closes up empty grid rows and columns", () => {
    const spaced = {
      locations: [
        { id: 1, name: "A", column: 1, row: 1 },
        { id: 2, name: "B", column: 5, row: 4 },
      ],
      connections: [{ from: 1, to: 2 }],
    };
    const adjacent = {
      locations: [
        { id: 1, name: "A", column: 1, row: 1 },
        { id: 2, name: "B", column: 2, row: 2 },
      ],
      connections: [{ from: 1, to: 2 }],
    };
    expect(draw(spaced)).toBe(draw(adjacent));
  });

  test("shows only the number when a name can't fit whole, never a fragment", () => {
    const locations = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      name: i === 0 ? "Extraordinarily Long Name" : `R${i + 1}`,
      column: i + 1,
      row: 1,
      size: "small",
    }));
    const page = draw({ locations, connections: [] });
    const rows = mapRows(page).join("\n");
    expect(rows).not.toContain("Extraordinar");
    expect(rows).toMatch(/\| +1 +\|/);
    // The key still carries the whole name.
    expect(page).toContain("1 Extraordinarily Long Name");
  });
});
