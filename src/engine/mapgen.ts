/** Seeded land growth, constrained decoration, and immutable edge-graph construction. */
import { CONFIG, GOOD_COUNT } from './config.js';
import type { Board, Edge, GenerationStats, Hex, Vertex } from './board.js';
import { nextRandom, seedValue, shuffle, type RandomState } from './rng.js';

interface Cell {
  q: number;
  r: number;
}
interface MutableVertex {
  id: number;
  hexes: number[];
  neighbours: number[];
  edges: number[];
  coastal: boolean;
  shrine: boolean;
  harbour: boolean;
  x: number;
  y: number;
}
interface Topology {
  vertices: MutableVertex[];
  edges: Edge[];
  hexVertices: number[][];
  distances: number[][];
}
type MutableStats = { -readonly [K in keyof GenerationStats]: GenerationStats[K] };
// Axial directions and integral corner coordinates describe geometry, not game balance.
const DIRECTIONS = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
] as const;
const CORNERS = [
  [1, 1],
  [0, 2],
  [-1, 1],
  [-1, -1],
  [0, -2],
  [1, -1],
] as const;
const key = (q: number, r: number): string => `${q},${r}`;
const radius = (cell: Cell): number =>
  Math.max(Math.abs(cell.q), Math.abs(cell.r), Math.abs(cell.q + cell.r));

/** List the finite growth region and its neighbour graph in stable axial order. */
function region(): { cells: Cell[]; neighbours: number[][]; centre: number } {
  const cells: Cell[] = [];
  for (let q = -CONFIG.map.radius; q <= CONFIG.map.radius; q++) {
    for (let r = -CONFIG.map.radius; r <= CONFIG.map.radius; r++) {
      if (radius({ q, r }) <= CONFIG.map.radius) cells.push({ q, r });
    }
  }
  const ids = new Map(cells.map((cell, i) => [key(cell.q, cell.r), i]));
  const neighbours = cells.map((cell) =>
    DIRECTIONS.flatMap(([q, r]) => {
      const id = ids.get(key(cell.q + q, cell.r + r));
      return id === undefined ? [] : [id];
    }),
  );
  return { cells, neighbours, centre: ids.get(key(0, 0))! };
}

/** Grow with the prescribed frontier weights; reject thin land and every enclosed sea component. */
function growLand(rng: RandomState, area: ReturnType<typeof region>): number[] | undefined {
  const land = new Set([area.centre]);
  while (land.size < CONFIG.map.land) {
    const frontier: { id: number; weight: number }[] = [];
    let weightSum = 0;
    for (let id = 0; id < area.cells.length; id++) {
      if (land.has(id)) continue;
      const count = area.neighbours[id]!.filter((other) => land.has(other)).length;
      if (count) {
        const weight = 1 + CONFIG.map.neighbourWeight * count;
        frontier.push({ id, weight });
        weightSum += weight;
      }
    }
    let draw = nextRandom(rng) * weightSum;
    for (const candidate of frontier) {
      draw -= candidate.weight;
      if (draw < 0) {
        land.add(candidate.id);
        break;
      }
    }
  }
  if (
    [...land].some(
      (id) =>
        area.neighbours[id]!.filter((other) => land.has(other)).length < CONFIG.map.minNeighbours,
    )
  )
    return undefined;
  const exterior = new Set<number>();
  const queue: number[] = [];
  area.cells.forEach((cell, id) => {
    if (!land.has(id) && radius(cell) === CONFIG.map.radius) {
      exterior.add(id);
      queue.push(id);
    }
  });
  for (let i = 0; i < queue.length; i++) {
    for (const id of area.neighbours[queue[i]!]!)
      if (!land.has(id) && !exterior.has(id)) {
        exterior.add(id);
        queue.push(id);
      }
  }
  if (exterior.size + land.size !== area.cells.length) return undefined;
  return [...land].sort((a, b) => a - b);
}

/** Construct corners once, merging shared integral coordinates before creating sides and distances. */
function topology(cells: Cell[]): Topology {
  const vertices: MutableVertex[] = [];
  const vertexIds = new Map<string, number>();
  const edgeIds = new Map<string, number>();
  const ends: [number, number][] = [];
  const hexVertices = cells.map((cell, hex) =>
    CORNERS.map(([dx, dy]) => {
      const x = 2 * cell.q + cell.r + dx;
      const y = 3 * cell.r + dy;
      const location = key(x, y);
      let id = vertexIds.get(location);
      if (id === undefined) {
        id = vertices.length;
        vertexIds.set(location, id);
        vertices.push({
          id,
          hexes: [],
          neighbours: [],
          edges: [],
          coastal: false,
          shrine: false,
          harbour: false,
          x: (x * Math.sqrt(3)) / 2,
          y: y / 2,
        });
      }
      vertices[id]!.hexes.push(hex);
      return id;
    }),
  );
  for (const corners of hexVertices) {
    for (let i = 0; i < CORNERS.length; i++) {
      const a = corners[i]!;
      const b = corners[(i + 1) % CORNERS.length]!;
      const location = key(Math.min(a, b), Math.max(a, b));
      if (edgeIds.has(location)) continue;
      const id = ends.length;
      edgeIds.set(location, id);
      ends.push([a, b]);
      vertices[a]!.neighbours.push(b);
      vertices[b]!.neighbours.push(a);
      vertices[a]!.edges.push(id);
      vertices[b]!.edges.push(id);
    }
  }
  for (const vertex of vertices) vertex.coastal = vertex.hexes.length < CONFIG.map.coastalHexes;
  const edges = ends.map((verticesOnEdge, id) => ({
    id,
    vertices: verticesOnEdge,
    neighbours: [...new Set(verticesOnEdge.flatMap((v) => vertices[v]!.edges))]
      .filter((e) => e !== id)
      .sort((a, b) => a - b),
  }));
  const distances = vertices.map((start) => {
    const result = vertices.map(() => Infinity);
    result[start.id] = 0;
    const queue = [start.id];
    for (let i = 0; i < queue.length; i++) {
      const v = queue[i]!;
      for (const neighbour of vertices[v]!.neighbours)
        if (!Number.isFinite(result[neighbour])) {
          result[neighbour] = result[v]! + 1;
          queue.push(neighbour);
        }
    }
    return result;
  });
  return { vertices, edges, hexVertices, distances };
}

/** Randomly ordered constraint search avoids spending most retries on known-invalid partial assignments. */
function terrainAssignment(rng: RandomState, neighbours: number[][]): number[] | undefined {
  const values = neighbours.map(() => -1);
  const remaining: number[] = CONFIG.terrain.map((_, terrain) =>
    terrain < GOOD_COUNT ? CONFIG.map.productivePerTerrain : CONFIG.map.barrens,
  );
  const order = shuffle(
    rng,
    values.map((_, id) => id),
  ).sort((a, b) => neighbours[b]!.length - neighbours[a]!.length);
  let visited = 0;
  const search = (depth: number): boolean => {
    if (depth === order.length) return true;
    // This is a computational search budget, unrelated to game rules.
    if (++visited > 20000) return false;
    const id = order[depth]!;
    for (const terrain of shuffle(
      rng,
      remaining.map((_, i) => i),
    )) {
      if (!remaining[terrain]) continue;
      const matches = neighbours[id]!.filter((other) => values[other] === terrain);
      if (
        matches.length > CONFIG.map.maxSameTerrainNeighbours ||
        matches.some(
          (other) =>
            neighbours[other]!.filter((next) => values[next] === terrain).length >=
            CONFIG.map.maxSameTerrainNeighbours,
        )
      )
        continue;
      values[id] = terrain;
      remaining[terrain]!--;
      if (search(depth + 1)) return true;
      values[id] = -1;
      remaining[terrain]!++;
    }
    return false;
  };
  return search(0) ? values : undefined;
}

/** Compute dice multiplicity from the configured dice rather than duplicating the token table. */
function pips(token: number): number {
  return token ? Math.max(0, CONFIG.dice.sides - Math.abs(CONFIG.dice.sides + 1 - token)) : 0;
}

/** Place token multiplicities with neighbour exclusions and attainable per-good pip bounds. */
function tokenAssignment(
  rng: RandomState,
  neighbours: number[][],
  terrain: number[],
): number[] | undefined {
  const values: number[] = terrain.map((t) => (t < GOOD_COUNT ? -1 : 0));
  const tokens = [...new Set<number>(CONFIG.map.tokens)];
  const remaining = tokens.map(
    (token) => CONFIG.map.tokens.filter((value) => value === token).length,
  );
  const sums = Array<number>(GOOD_COUNT).fill(0);
  const unfilled = Array<number>(GOOD_COUNT).fill(CONFIG.map.productivePerTerrain);
  const hot = new Set<number>(CONFIG.map.hotTokens);
  const tieOrder = shuffle(
    rng,
    values.map((_, id) => id),
  );
  let visited = 0;
  const candidates = (id: number): number[] =>
    tokens.flatMap((token, index) => {
      if (
        !remaining[index] ||
        neighbours[id]!.some(
          (other) => values[other] === token || (hot.has(token) && hot.has(values[other]!)),
        )
      )
        return [];
      const good = terrain[id]!;
      const sum = sums[good]! + pips(token);
      const slots = unfilled[good]! - 1;
      const available = tokens
        .flatMap((value, i) =>
          Array<number>(remaining[i]! - (i === index ? 1 : 0)).fill(pips(value)),
        )
        .sort((a, b) => a - b);
      const low = available.slice(0, slots).reduce((a, b) => a + b, 0);
      const high = slots ? available.slice(-slots).reduce((a, b) => a + b, 0) : 0;
      return sum + low > CONFIG.map.maxPips || sum + high < CONFIG.map.minPips ? [] : [index];
    });
  const search = (depth: number): boolean => {
    if (depth === CONFIG.map.tokens.length) return true;
    if (++visited > 20000) return false;
    let id = -1;
    let choices: number[] = [];
    for (const candidate of tieOrder) {
      if (values[candidate] !== -1) continue;
      const options = candidates(candidate);
      if (!options.length) return false;
      if (id === -1 || options.length < choices.length) {
        id = candidate;
        choices = options;
      }
    }
    const good = terrain[id]!;
    for (const index of shuffle(rng, choices)) {
      const token = tokens[index]!;
      values[id] = token;
      remaining[index]!--;
      sums[good]! += pips(token);
      unfilled[good]!--;
      if (search(depth + 1)) return true;
      values[id] = -1;
      remaining[index]!++;
      sums[good]! -= pips(token);
      unfilled[good]!++;
    }
    return false;
  };
  return search(0) ? values : undefined;
}

/** Pick a random valid separated set, examining combinations only when greedy choices fail. */
function landmarks(
  rng: RandomState,
  candidates: number[],
  count: number,
  distance: number,
  distances: number[][],
): number[] | undefined {
  const order = shuffle(rng, candidates);
  const result: number[] = [];
  const search = (start: number): boolean => {
    if (result.length === count) return true;
    for (let i = start; i <= order.length - (count - result.length); i++) {
      const vertex = order[i]!;
      if (result.some((other) => distances[vertex]![other]! < distance)) continue;
      result.push(vertex);
      if (search(i + 1)) return true;
      result.pop();
    }
    return false;
  };
  return search(0) ? result : undefined;
}

/** Retry a decoration stage at most the configured limit, keeping cumulative diagnostics. */
function stage<T>(
  stats: MutableStats,
  field: Exclude<keyof GenerationStats, 'restarts'>,
  attempt: () => T | undefined,
): T | undefined {
  for (let i = 0; i < CONFIG.map.attempts; i++) {
    stats[field]++;
    const result = attempt();
    if (result !== undefined) return result;
  }
  return undefined;
}

/** Freeze every object and ordinary array; boards contain no mutable typed-array backing stores. */
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Generate a replayable map; failed stages restart land growth using the same advancing stream. */
export function generateBoard(seed: number | string): Board {
  const rng = { rng: seedValue(seed) };
  const area = region();
  const generation: MutableStats = {
    restarts: 0,
    landAttempts: 0,
    terrainAttempts: 0,
    tokenAttempts: 0,
    shrineAttempts: 0,
    harbourAttempts: 0,
  };
  for (;;) {
    const land = stage(generation, 'landAttempts', () => growLand(rng, area));
    if (!land) {
      generation.restarts++;
      continue;
    }
    const cells = land.map((id) => area.cells[id]!);
    const ids = new Map(land.map((id, local) => [id, local]));
    const neighbours = land.map((id) =>
      area.neighbours[id]!.flatMap((other) => (ids.has(other) ? [ids.get(other)!] : [])),
    );
    const terrain = stage(generation, 'terrainAttempts', () => terrainAssignment(rng, neighbours));
    if (!terrain) {
      generation.restarts++;
      continue;
    }
    const numbers = stage(generation, 'tokenAttempts', () =>
      tokenAssignment(rng, neighbours, terrain),
    );
    if (!numbers) {
      generation.restarts++;
      continue;
    }
    const graph = topology(cells);
    const shrines = stage(generation, 'shrineAttempts', () =>
      landmarks(
        rng,
        graph.vertices
          .filter((vertex) => vertex.coastal && vertex.hexes.length === CONFIG.map.shrineHexes)
          .map((vertex) => vertex.id),
        CONFIG.map.shrines,
        CONFIG.map.shrineDistance,
        graph.distances,
      ),
    );
    if (!shrines) {
      generation.restarts++;
      continue;
    }
    const harbours = stage(generation, 'harbourAttempts', () =>
      landmarks(
        rng,
        graph.vertices
          .filter(
            (vertex) =>
              vertex.coastal &&
              shrines.every(
                (shrine) =>
                  graph.distances[vertex.id]![shrine]! >= CONFIG.map.harbourShrineDistance,
              ),
          )
          .map((vertex) => vertex.id),
        CONFIG.map.harbours,
        CONFIG.map.harbourDistance,
        graph.distances,
      ),
    );
    if (!harbours) {
      generation.restarts++;
      continue;
    }
    for (const vertex of graph.vertices) {
      vertex.shrine = shrines.includes(vertex.id);
      vertex.harbour = harbours.includes(vertex.id);
    }
    const hexes: Hex[] = cells.map((cell, id) => ({
      ...cell,
      id,
      terrain: terrain[id]!,
      good: terrain[id]! < GOOD_COUNT ? terrain[id]! : -1,
      number: numbers[id]!,
      pips: pips(numbers[id]!),
      vertices: graph.hexVertices[id]!,
      neighbours: neighbours[id]!,
    }));
    const barrens = hexes.filter((hex) => hex.good === -1);
    return freeze({
      hexes,
      vertices: graph.vertices as Vertex[],
      edges: graph.edges,
      distances: graph.distances,
      initialWarband: barrens[Math.floor(nextRandom(rng) * barrens.length)]!.id,
      seed,
      generation,
    });
  }
}
