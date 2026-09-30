/**
 * Full-page ASCII maps. The model supplies only a grid layout — which cell each
 * location occupies and how locations connect — and this module owns every
 * drawing decision, so a map looks the same whichever model laid it out.
 * Layout problems come back as errors the model can fix and retry.
 */

export const PAGE_WIDTH = 100;
export const PAGE_HEIGHT = 45;
export const MAX_COLUMNS = 6;
export const MAX_ROWS = 5;
export const MAX_LOCATIONS = 16;
/**
 * Keeps every key entry ("16 " + name) within a three-column key cell, so one
 * long name can't stretch the key down into the map's rows.
 */
export const MAX_NAME_LENGTH = 27;

export const ROOM_SIZES = ["small", "medium", "large"] as const;
export type RoomSize = (typeof ROOM_SIZES)[number];

export const CONNECTION_TYPES = ["open", "door", "locked", "secret", "stairs", "one-way"] as const;
export type ConnectionType = (typeof CONNECTION_TYPES)[number];

export interface MapLocation {
  id: number;
  name: string;
  /** 1-based; column 1 is the left edge. */
  column: number;
  /** 1-based; row 1 is the top edge. */
  row: number;
  size: RoomSize;
}

export interface MapConnection {
  from: number;
  to: number;
  type: ConnectionType;
}

export interface MapSpec {
  title: string;
  locations: MapLocation[];
  connections: MapConnection[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** A plan is ready for a full map once it carries the prompt's `## Map` schematic. */
export function hasMapSchematic(body: string): boolean {
  return /^##[ \t]+map\b/im.test(body);
}

// ---------------------------------------------------------------------------
// Parsing model arguments

// Width varies less than height: names need the columns more than the rows.
const WIDTH_FRACTIONS: Record<RoomSize, number> = { small: 0.75, medium: 0.9, large: 1 };
const HEIGHT_FRACTIONS: Record<RoomSize, number> = { small: 0.55, medium: 0.75, large: 0.95 };

const TYPE_ALIASES: Record<string, ConnectionType> = {
  open: "open",
  passage: "open",
  corridor: "open",
  path: "open",
  hall: "open",
  hallway: "open",
  door: "door",
  doorway: "door",
  locked: "locked",
  "locked-door": "locked",
  barred: "locked",
  secret: "secret",
  "secret-door": "secret",
  "secret-passage": "secret",
  hidden: "secret",
  stairs: "stairs",
  stair: "stairs",
  staircase: "stairs",
  ladder: "stairs",
  "one-way": "one-way",
  oneway: "one-way",
  "one-way-door": "one-way",
};

/** Models sometimes send nested arrays as JSON strings. */
function arrayArg(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return value === undefined || value === null ? [] : null;
}

function intArg(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Keeps every page line exactly PAGE_WIDTH columns by folding text to printable
 * ASCII. Backticks become quotes so model text can't close the map file's fence.
 */
export function toAscii(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019`]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\s+/g, " ")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function parseMapSpec(args: Record<string, unknown>, fallbackTitle: string): Parsed<MapSpec> {
  const errors: string[] = [];
  const title = toAscii(typeof args["title"] === "string" ? args["title"] : "") || toAscii(fallbackTitle) || "Map";

  const rawLocations = arrayArg(args["locations"]);
  const rawConnections = arrayArg(args["connections"]);
  if (!rawLocations) errors.push("locations must be an array");
  if (!rawConnections) errors.push("connections must be an array");
  if (!rawLocations || !rawConnections) return { ok: false, errors };

  if (rawLocations.length === 0) errors.push("add at least one location");
  if (rawLocations.length > MAX_LOCATIONS) {
    errors.push(`at most ${MAX_LOCATIONS} locations fit on one page; split the site into one map per area`);
  }

  const locations: MapLocation[] = [];
  const byCell = new Map<string, number>();
  const ids = new Set<number>();
  rawLocations.forEach((raw, index) => {
    const entry = record(raw);
    const id = intArg(entry["id"]);
    const label = id === null ? `location #${index + 1}` : `location ${id}`;
    const name = toAscii(typeof entry["name"] === "string" ? entry["name"] : "");
    const column = intArg(entry["column"]);
    const row = intArg(entry["row"]);
    const size = String(entry["size"] ?? "medium").toLowerCase();

    if (id === null || id < 1) errors.push(`${label}: id must be a positive whole number`);
    else if (ids.has(id)) errors.push(`${label}: id is used more than once`);
    if (name === "") errors.push(`${label}: name is required`);
    else if (name.length > MAX_NAME_LENGTH) {
      errors.push(`${label}: name must be at most ${MAX_NAME_LENGTH} characters; use a short name`);
    }
    if (column === null || column < 1 || column > MAX_COLUMNS) {
      errors.push(`${label}: column must be 1-${MAX_COLUMNS}`);
    }
    if (row === null || row < 1 || row > MAX_ROWS) errors.push(`${label}: row must be 1-${MAX_ROWS}`);
    if (id === null || id < 1 || ids.has(id) || column === null || row === null) return;
    if (name === "" || name.length > MAX_NAME_LENGTH) return;
    if (column < 1 || column > MAX_COLUMNS || row < 1 || row > MAX_ROWS) return;

    ids.add(id);
    const cell = `${column},${row}`;
    const other = byCell.get(cell);
    if (other !== undefined) {
      errors.push(`${label}: column ${column}, row ${row} is already taken by location ${other}`);
      return;
    }
    byCell.set(cell, id);
    locations.push({
      id,
      name,
      column,
      row,
      // Size is cosmetic, so an unknown value falls back rather than failing the map.
      size: (ROOM_SIZES as readonly string[]).includes(size) ? (size as RoomSize) : "medium",
    });
  });

  const connections: MapConnection[] = [];
  const seen = new Set<string>();
  rawConnections.forEach((raw, index) => {
    const entry = record(raw);
    const from = intArg(entry["from"]);
    const to = intArg(entry["to"]);
    const label = from !== null && to !== null ? `connection ${from}-${to}` : `connection #${index + 1}`;
    const rawType = String(entry["type"] ?? "open")
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-");
    const alias = rawType === "" ? "open" : rawType;
    const type = Object.hasOwn(TYPE_ALIASES, alias) ? TYPE_ALIASES[alias] : undefined;

    if (from === null || to === null) {
      errors.push(`${label}: from and to must be location ids`);
      return;
    }
    if (!type) errors.push(`${label}: type must be one of ${CONNECTION_TYPES.join(", ")}`);
    if (from === to) errors.push(`${label}: a location cannot connect to itself`);
    for (const end of [from, to]) {
      if (!ids.has(end) && rawLocations.every((loc) => intArg(record(loc)["id"]) !== end)) {
        errors.push(`${label}: there is no location ${end}`);
      }
    }
    if (!type || from === to || !ids.has(from) || !ids.has(to)) return;

    // The same pair listed twice would draw over itself; keep the first.
    const key = from < to ? `${from}-${to}` : `${to}-${from}`;
    if (seen.has(key)) return;
    seen.add(key);
    connections.push({ from, to, type });
  });

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { title, locations, connections } };
}

// ---------------------------------------------------------------------------
// Rendering

const INNER_WIDTH = PAGE_WIDTH - 4;
const MIN_ROOM_WIDTH = 9;
const MAX_ROOM_WIDTH = 30;
const MIN_ROOM_HEIGHT = 3;
const MAX_ROOM_HEIGHT = 9;
/** Corridor space kept between neighbouring rooms, so a marker has room to sit mid-corridor. */
const MIN_GAP_X = 4;
const MIN_GAP_Y = 3;

const LEGEND: Record<ConnectionType, string> = {
  open: "--- passage",
  door: "-D- door",
  locked: "-L- locked",
  secret: "... secret",
  stairs: "-#- stairs",
  "one-way": "->- one-way",
};

interface Room {
  location: MapLocation;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The centre lines of the room's grid cell; corridors run along these. */
  cx: number;
  cy: number;
}

interface Point {
  x: number;
  y: number;
}

class Canvas {
  readonly cells: string[][];
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  }

  get(x: number, y: number): string {
    return this.cells[y]?.[x] ?? " ";
  }

  set(x: number, y: number, ch: string): void {
    const row = this.cells[y];
    if (row && x >= 0 && x < this.width) row[x] = ch;
  }

  lines(): string[] {
    return this.cells.map((row) => row.join(""));
  }
}

function clamp(n: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, n));
}

/** Word-wrap, or null when a word is wider than the line: a split word reads worse than none. */
function wrap(text: string, width: number): string[] | null {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (word.length > width) return null;
    if (line === "") line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** A room shows its whole name, or only its number when the name can't fit; the key always has both. */
function roomLabel(location: MapLocation, width: number, height: number): string[] {
  const id = String(location.id);
  const named = wrap(location.name, width);
  if (named && named.length + 1 <= height) return [id, ...named];
  const joined = wrap(`${id} ${location.name}`, width);
  if (joined && joined.length <= height) return joined;
  return [id];
}

/**
 * Close up grid rows and columns no location uses, so rooms get the space.
 * Safe for routing: every cell a route must keep clear lies in a used row or
 * column, so dropping empty ones can only unblock routes, never block them.
 */
function compact(locations: MapLocation[]): MapLocation[] {
  const columns = [...new Set(locations.map((l) => l.column))].sort((a, b) => a - b);
  const rows = [...new Set(locations.map((l) => l.row))].sort((a, b) => a - b);
  return locations.map((l) => ({ ...l, column: columns.indexOf(l.column) + 1, row: rows.indexOf(l.row) + 1 }));
}

/** Expects compacted locations, so the grid starts at column 1, row 1. */
function layoutRooms(locations: MapLocation[], mapHeight: number): Room[] {
  const columns = Math.max(...locations.map((l) => l.column));
  const rows = Math.max(...locations.map((l) => l.row));
  const cellW = Math.floor(INNER_WIDTH / columns);
  const cellH = Math.floor(mapHeight / rows);
  const offsetX = Math.floor((INNER_WIDTH - cellW * columns) / 2);
  const offsetY = Math.floor((mapHeight - cellH * rows) / 2);
  const maxW = Math.min(MAX_ROOM_WIDTH, cellW - MIN_GAP_X);
  const maxH = Math.min(MAX_ROOM_HEIGHT, cellH - MIN_GAP_Y);

  return locations.map((location) => {
    const w = clamp(Math.round(maxW * WIDTH_FRACTIONS[location.size]), MIN_ROOM_WIDTH, maxW);
    const h = clamp(Math.round(maxH * HEIGHT_FRACTIONS[location.size]), MIN_ROOM_HEIGHT, maxH);
    const cellX = offsetX + (location.column - 1) * cellW;
    const cellY = offsetY + (location.row - 1) * cellH;
    return {
      location,
      w,
      h,
      x: cellX + Math.floor((cellW - w) / 2),
      y: cellY + Math.floor((cellH - h) / 2),
      // Always inside the room's side walls, whatever its size, so rooms in one
      // row (or column) share the line a straight corridor runs along.
      cx: cellX + Math.floor((cellW - 1) / 2),
      cy: cellY + Math.floor((cellH - 1) / 2),
    };
  });
}

/** Where a corridor leaves `room` heading in direction (dx, dy). */
function exitPoint(room: Room, dx: number, dy: number): Point {
  if (dx > 0) return { x: room.x + room.w, y: room.cy };
  if (dx < 0) return { x: room.x - 1, y: room.cy };
  if (dy > 0) return { x: room.cx, y: room.y + room.h };
  return { x: room.cx, y: room.y - 1 };
}

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = Math.min(a, b) + 1; i < Math.max(a, b); i++) out.push(i);
  return out;
}

/**
 * Route a corridor as a polyline from `a` to `b`: straight when they share a
 * row or column, otherwise with one turn. Returns null when every route would
 * cross another location's cell.
 */
function route(a: Room, b: Room, occupied: Set<string>, canvas: Canvas): Point[] | null {
  const A = a.location;
  const B = b.location;
  const free = (cells: [number, number][]) => cells.every(([c, r]) => !occupied.has(`${c},${r}`));
  const sx = Math.sign(B.column - A.column);
  const sy = Math.sign(B.row - A.row);

  if (sy === 0) {
    if (!free(range(A.column, B.column).map((c) => [c, A.row]))) return null;
    return [exitPoint(a, sx, 0), exitPoint(b, -sx, 0)];
  }
  if (sx === 0) {
    if (!free(range(A.row, B.row).map((r) => [A.column, r]))) return null;
    return [exitPoint(a, 0, sy), exitPoint(b, 0, -sy)];
  }

  const candidates: Point[][] = [];
  // Across first, turning in the cell above/below the destination.
  if (
    free([
      ...range(A.column, B.column).map((c): [number, number] => [c, A.row]),
      [B.column, A.row],
      ...range(A.row, B.row).map((r): [number, number] => [B.column, r]),
    ])
  ) {
    const start = exitPoint(a, sx, 0);
    candidates.push([start, { x: b.cx, y: start.y }, exitPoint(b, 0, -sy)]);
  }
  // Down (or up) first, turning in the cell beside the destination.
  if (
    free([
      ...range(A.row, B.row).map((r): [number, number] => [A.column, r]),
      [A.column, B.row],
      ...range(A.column, B.column).map((c): [number, number] => [c, B.row]),
    ])
  ) {
    const start = exitPoint(a, 0, sy);
    candidates.push([start, { x: start.x, y: b.cy }, exitPoint(b, -sx, 0)]);
  }
  if (candidates.length === 0) return null;
  // Prefer the route that shares the least ground with corridors already drawn.
  const overlap = (path: Point[]) => pathCells(path).filter((p) => canvas.get(p.x, p.y) !== " ").length;
  return candidates.reduce((best, next) => (overlap(next) < overlap(best) ? next : best));
}

function pathCells(path: Point[]): Point[] {
  const cells: Point[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const from = path[i]!;
    const to = path[i + 1]!;
    const dx = Math.sign(to.x - from.x);
    const dy = Math.sign(to.y - from.y);
    for (let x = from.x, y = from.y; ; x += dx, y += dy) {
      if (i === 0 || x !== from.x || y !== from.y) cells.push({ x, y });
      if (x === to.x && y === to.y) break;
    }
  }
  return cells;
}

const HORIZONTAL = new Set(["-", "."]);
const VERTICAL = new Set(["|", ":"]);

function drawCorridor(canvas: Canvas, path: Point[], secret: boolean): void {
  for (let i = 0; i + 1 < path.length; i++) {
    const from = path[i]!;
    const to = path[i + 1]!;
    const horizontal = from.y === to.y;
    const glyph = horizontal ? (secret ? "." : "-") : secret ? ":" : "|";
    const crossing = horizontal ? VERTICAL : HORIZONTAL;
    for (const p of pathCells([from, to])) {
      const existing = canvas.get(p.x, p.y);
      canvas.set(p.x, p.y, existing === "+" || crossing.has(existing) ? "+" : glyph);
    }
    // The turn of an L-shaped corridor.
    if (i > 0) canvas.set(from.x, from.y, "+");
  }
}

function markerGlyph(type: ConnectionType, dx: number, dy: number): string | null {
  switch (type) {
    case "door":
      return "D";
    case "locked":
      return "L";
    case "stairs":
      return "#";
    case "one-way":
      return dx > 0 ? ">" : dx < 0 ? "<" : dy > 0 ? "v" : "^";
    default:
      return null;
  }
}

/** Mark the middle of the corridor's longest leg, stepping off any junction. */
function drawMarker(canvas: Canvas, path: Point[], type: ConnectionType): void {
  let leg: [Point, Point] = [path[0]!, path[1]!];
  for (let i = 1; i + 1 < path.length; i++) {
    const from = path[i]!;
    const to = path[i + 1]!;
    const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    if (length > Math.abs(leg[1].x - leg[0].x) + Math.abs(leg[1].y - leg[0].y)) leg = [from, to];
  }
  const glyph = markerGlyph(type, Math.sign(leg[1].x - leg[0].x), Math.sign(leg[1].y - leg[0].y));
  if (!glyph) return;
  const cells = pathCells(leg);
  const middle = Math.floor((cells.length - 1) / 2);
  for (let step = 0; step < cells.length; step++) {
    const index = middle + (step % 2 === 0 ? step / 2 : -(step + 1) / 2);
    const cell = cells[index];
    if (!cell) continue;
    const existing = canvas.get(cell.x, cell.y);
    if (HORIZONTAL.has(existing) || VERTICAL.has(existing)) {
      canvas.set(cell.x, cell.y, glyph);
      return;
    }
  }
}

function drawRoom(canvas: Canvas, room: Room): void {
  const { x, y, w, h } = room;
  for (let i = 0; i < w; i++) {
    canvas.set(x + i, y, i === 0 || i === w - 1 ? "+" : "-");
    canvas.set(x + i, y + h - 1, i === 0 || i === w - 1 ? "+" : "-");
  }
  for (let j = 1; j < h - 1; j++) {
    canvas.set(x, y + j, "|");
    canvas.set(x + w - 1, y + j, "|");
    for (let i = 1; i < w - 1; i++) canvas.set(x + i, y + j, " ");
  }
  const textWidth = w - 4;
  const textHeight = h - 2;
  const lines = roomLabel(room.location, textWidth, textHeight);
  const top = y + 1 + Math.floor((textHeight - lines.length) / 2);
  lines.forEach((line, index) => {
    const left = x + 2 + Math.floor((textWidth - line.length) / 2);
    for (let i = 0; i < line.length; i++) canvas.set(left + i, top + index, line[i]!);
  });
}

/** The numbered key, in as many columns as fit every entry whole. */
function keyLayout(locations: MapLocation[]): string[] {
  const entries = [...locations].sort((a, b) => a.id - b.id).map((l) => `${l.id} ${l.name}`);
  const longest = Math.max(...entries.map((entry) => entry.length));
  let columns = 4;
  while (columns > 1 && longest > Math.floor(INNER_WIDTH / columns) - 2) columns--;
  const cell = Math.floor(INNER_WIDTH / columns);
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += columns) {
    lines.push(
      entries
        .slice(i, i + columns)
        .map((entry) => entry.slice(0, cell - 2).padEnd(cell))
        .join("")
        .trimEnd(),
    );
  }
  return lines;
}

function frameLine(text: string): string {
  return `| ${text.slice(0, INNER_WIDTH).padEnd(INNER_WIDTH)} |`;
}

function centered(text: string): string {
  const clipped = text.slice(0, INNER_WIDTH);
  return " ".repeat(Math.floor((INNER_WIDTH - clipped.length) / 2)) + clipped;
}

/**
 * Draw the whole page: a framed title, the map, a legend of the connection
 * types used, and a numbered key. Every line is exactly PAGE_WIDTH columns and
 * the page is exactly PAGE_HEIGHT lines.
 */
export function renderMap(spec: MapSpec): Parsed<string> {
  const keyLines = keyLayout(spec.locations);
  const mapHeight = PAGE_HEIGHT - 6 - keyLines.length;

  const canvas = new Canvas(INNER_WIDTH, mapHeight);
  const locations = compact(spec.locations);
  const rooms = layoutRooms(locations, mapHeight);
  const roomById = new Map(rooms.map((room) => [room.location.id, room]));
  const occupied = new Set(locations.map((l) => `${l.column},${l.row}`));

  const errors: string[] = [];
  const routes: { path: Point[]; type: ConnectionType }[] = [];
  for (const connection of spec.connections) {
    const a = roomById.get(connection.from)!;
    const b = roomById.get(connection.to)!;
    const path = route(a, b, occupied, canvas);
    if (!path) {
      errors.push(
        `connection ${connection.from}-${connection.to}: every route crosses another location's cell; ` +
          "move one of them, or connect through the location in between",
      );
      continue;
    }
    drawCorridor(canvas, path, connection.type === "secret");
    routes.push({ path, type: connection.type });
  }
  if (errors.length > 0) return { ok: false, errors };

  // Markers go on after every corridor, so later crossings can't overwrite them.
  for (const { path, type } of routes) drawMarker(canvas, path, type);
  for (const room of rooms) drawRoom(canvas, room);

  const used = CONNECTION_TYPES.filter((type) => spec.connections.some((c) => c.type === type));
  const legend = used.length > 0 ? `Legend:  ${used.map((type) => LEGEND[type]).join("  ")}` : "";
  const rule = `+${"-".repeat(PAGE_WIDTH - 2)}+`;

  const page = [
    rule,
    frameLine(centered(spec.title.toUpperCase())),
    rule,
    ...canvas.lines().map(frameLine),
    rule,
    frameLine(legend),
    ...keyLines.map(frameLine),
    rule,
  ];
  return { ok: true, value: page.join("\n") };
}
