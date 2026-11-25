/** Immutable map records shared by every dynamic state and search branch. */
export interface Hex {
  readonly id: number;
  readonly q: number;
  readonly r: number;
  readonly terrain: number;
  readonly good: number;
  readonly number: number;
  readonly pips: number;
  readonly vertices: readonly number[];
  readonly neighbours: readonly number[];
}
export interface Vertex {
  readonly id: number;
  readonly hexes: readonly number[];
  readonly neighbours: readonly number[];
  readonly edges: readonly number[];
  readonly coastal: boolean;
  readonly shrine: boolean;
  readonly harbour: boolean;
  readonly x: number;
  readonly y: number;
}
export interface Edge {
  readonly id: number;
  readonly vertices: readonly [number, number];
  readonly neighbours: readonly number[];
}
export interface GenerationStats {
  readonly restarts: number;
  readonly landAttempts: number;
  readonly terrainAttempts: number;
  readonly tokenAttempts: number;
  readonly shrineAttempts: number;
  readonly harbourAttempts: number;
}
export interface Board {
  readonly hexes: readonly Hex[];
  readonly vertices: readonly Vertex[];
  readonly edges: readonly Edge[];
  readonly distances: readonly (readonly number[])[];
  readonly initialWarband: number;
  readonly seed: number | string;
  readonly generation: GenerationStats;
}

/** Read the shortest number of board edges between two vertices from the shared table. */
export function graphDistance(board: Board, a: number, b: number): number {
  const distance = board.distances[a]?.[b];
  if (distance === undefined) throw new RangeError('Unknown board vertex');
  return distance;
}
