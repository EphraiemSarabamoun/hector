/** Human map descriptions shared by board choices and the Chronicle. Engine IDs stay internal. */
import { CONFIG, type Board } from '../engine/index.js';

/** Name a terrain/token pair, distinguishing repeated pairs by their geographic order. */
export function hexName(board: Board, id: number): string {
  const hex = board.hexes[id];
  if (!hex) return 'an unknown hex';
  const name = `${CONFIG.terrain[hex.terrain]}${hex.number > 0 ? ` ${hex.number}` : ''}`;
  const matching = board.hexes.filter(
    (other) => other.terrain === hex.terrain && other.number === hex.number,
  );
  if (matching.length < 2) return name;
  const centre = (hexId: number) => {
    const vertices = board.hexes[hexId].vertices.map((v) => board.vertices[v]);
    return {
      x: vertices.reduce((sum, v) => sum + v.x, 0) / vertices.length,
      y: vertices.reduce((sum, v) => sum + v.y, 0) / vertices.length,
    };
  };
  const westToEast = matching
    .slice()
    .sort((a, b) => centre(a.id).x - centre(b.id).x || centre(a.id).y - centre(b.id).y);
  const index = westToEast.findIndex((other) => other.id === id);
  if (matching.length === 2) {
    const vertical = Math.abs(centre(westToEast[0].id).x - centre(westToEast[1].id).x) < 0.001;
    return `${vertical ? (index === 0 ? 'northern' : 'southern') : index === 0 ? 'western' : 'eastern'} ${name}`;
  }
  const position =
    index === 0
      ? 'westernmost'
      : index === matching.length - 1
        ? 'easternmost'
        : `${index + 1}${index === 1 ? 'nd' : index === 2 ? 'rd' : 'th'} from the west`;
  return `${name} (${position})`;
}

/** Join neighbouring places in readable prose without exposing vertex or edge IDs. */
function joinPlaces(names: string[]): string {
  return names.length < 3
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Locate a corner or coastal edge relative to its touching land, using ordinary compass words. */
function geographicSide(
  board: Board,
  vertices: readonly number[],
  hexes: readonly number[],
): string {
  const target = vertices.map((id) => board.vertices[id]);
  const land = hexes.flatMap((id) => board.hexes[id].vertices.map((v) => board.vertices[v]));
  const average = (points: typeof target, axis: 'x' | 'y') =>
    points.reduce((sum, p) => sum + p[axis], 0) / points.length;
  const angle = Math.atan2(
    average(target, 'y') - average(land, 'y'),
    average(target, 'x') - average(land, 'x'),
  );
  const sector = (Math.round(angle / (Math.PI / 4)) + 8) % 8;
  return [
    'eastern',
    'southeastern',
    'southern',
    'southwestern',
    'western',
    'northwestern',
    'northern',
    'northeastern',
  ][sector];
}

/** Describe a building corner by all touching land and whether it borders the sea. */
export function vertexName(board: Board, id: number): string {
  const vertex = board.vertices[id];
  if (!vertex) return 'an unknown corner';
  const neighbours = vertex.hexes.map((hex) => hexName(board, hex));
  if (vertex.coastal) neighbours.push('the sea');
  const repeated =
    board.vertices.filter(
      (other) =>
        other.hexes.length === vertex.hexes.length &&
        other.hexes.every((hex) => vertex.hexes.includes(hex)),
    ).length > 1;
  return `the ${repeated ? `${geographicSide(board, [id], vertex.hexes)} ` : ''}corner of ${joinPlaces(neighbours)}`;
}

/** Describe a track by the one or two land hexes sharing its endpoints. */
export function edgeName(board: Board, id: number): string {
  const edge = board.edges[id];
  if (!edge) return 'an unknown track';
  const [a, b] = edge.vertices.map((v) => board.vertices[v]);
  const touching = a.hexes.filter((hex) => b.hexes.includes(hex));
  const neighbours = touching.map((hex) => hexName(board, hex));
  const coastal = neighbours.length === 1;
  if (coastal) neighbours.push('the sea');
  return `the ${coastal ? `${geographicSide(board, edge.vertices, touching)} ` : ''}track between ${joinPlaces(neighbours)}`;
}
