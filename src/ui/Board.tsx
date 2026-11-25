/** SVG rendering of the public map; highlighted choices come directly from the engine. */
import { useState } from 'react';
import { edgeName, hexName, vertexName } from './places.js';
import { Building, CONFIG, type Action, type Board, type GameState } from '../engine/index.js';

type Point = { x: number; y: number };
type BoardProps = {
  board: Board;
  state: GameState;
  actions: Action[];
  colours: string[];
  onAction: (action: Action) => void;
  highlighted?: { hexes?: number[]; vertices?: number[]; edges?: number[] };
  produced?: number[];
  productionKey?: number;
};

const SCALE = 64;
const TERRAIN_COLOURS = ['#77907b', '#c08b70', '#d8bd77', '#929b9b', '#a8b182', '#c6b398'];
const OWNER_DASHES = ['none', '5 2', '2 2', '7 2 2 2'];
const GLYPHS = [
  'M0 -16 L-10 -3 H-5 L-14 7 H-3 V16 H3 V7 H14 L5 -3 H10 Z',
  'M-17 13 L-10 1 L-3 4 L3 -10 L12 1 L18 13 Z M-9 9 L-4 4 M5 0 L10 8',
  'M0 17 V-17 M0 -8 Q-13 -18 -10 -4 Q-4 0 0 0 M0 1 Q13 -9 10 4 Q4 8 0 9 M0 10 Q-13 0 -10 13 Q-4 17 0 17 M0 -10 Q10 -20 7 -10 Q3 -6 0 -6',
  'M-17 -5 L-9 -13 H10 L18 -5 L11 12 H-11 Z M-17 -5 H18 M-9 -13 L-6 -5 L-11 12 M10 -13 L7 -5 L11 12',
  'M-12 16 L-6 1 L-11 -6 L-4 -14 L-1 -19 L4 -12 L11 -8 L16 1 L10 5 L3 1 L1 16 Z M-5 -10 L-12 0 L-14 12 M8 -6 L9 -6',
  'M-19 11 L-9 -7 L1 8 L9 -15 L20 11 M-9 -7 L-5 0 L-11 0 M9 -15 L14 -4 L7 -4',
];

/** Convert engine drawing coordinates to a comfortably sized SVG unit grid. */
function point(vertex: Point): Point {
  return { x: vertex.x * SCALE, y: vertex.y * SCALE };
}

/** Find the centre of a hex from its engine-provided corners, independent of map orientation. */
function hexCentre(board: Board, vertices: readonly number[]): Point {
  const points = vertices.map((id) => point(board.vertices[id]));
  return {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
}

/** Keep larger coastal badges inside the tight frame while linking them to their real corner. */
function coastalMarker(
  p: Point,
  centre: Point,
  bounds: { x: number; y: number; width: number; height: number },
): Point {
  const length = Math.hypot(p.x - centre.x, p.y - centre.y) || 1;
  const candidate = {
    x: p.x + ((p.x - centre.x) / length) * 30,
    y: p.y + ((p.y - centre.y) / length) * 30,
  };
  const inset = 21;
  let x = Math.max(bounds.x + inset, Math.min(bounds.x + bounds.width - inset, candidate.x));
  let y = Math.max(bounds.y + inset, Math.min(bounds.y + bounds.height - inset, candidate.y));
  // At the map extrema the sea is too narrow; put the badge inland rather than over its building.
  if (Math.hypot(x - p.x, y - p.y) < 28) {
    x = p.x - ((p.x - centre.x) / length) * 36;
    y = p.y - ((p.y - centre.y) / length) * 36;
  }
  return { x, y };
}

/** Show the goods a setup Steading would collect and the summed production weight at its corner. */
function siteDetails(board: Board, vertex: number): string {
  const hexes = board.vertices[vertex].hexes.map((id) => board.hexes[id]);
  const goods = CONFIG.goods
    .map((name, good) => ({
      name,
      count:
        hexes.filter((hex) => hex.number > 0 && hex.good === good).length * CONFIG.setup.production,
    }))
    .filter(({ count }) => count > 0)
    .map(({ name, count }) => `${count} ${name}`);
  return `${vertexName(board, vertex)}. Setup goods: ${goods.length ? goods.join(', ') : 'none'}. Total pips: ${hexes.reduce((sum, hex) => sum + hex.pips, 0)}.`;
}

/** Draw three architecturally different building silhouettes, with owner-specific outlines. */
function BuildingPiece({ kind, colour, owner }: { kind: number; colour: string; owner: number }) {
  const outline = OWNER_DASHES[owner % OWNER_DASHES.length];
  const path =
    kind === Building.Steading
      ? 'M-12 -1 L0 -12 L12 -1 V12 H-12 Z M-14 -1 L0 -14 L14 -1 M-3 12 V4 H3 V12'
      : kind === Building.Town
        ? 'M-16 12 V-9 H-8 V-3 H8 V-9 H16 V12 Z M-16 -9 V-13 H-8 V-9 M8 -9 V-13 H16 V-9 M-4 12 V3 H4 V12'
        : 'M-17 12 V-13 H-11 V-7 H-5 V-13 H1 V-7 H7 V-13 H13 V-7 H17 V12 Z M-5 12 V2 Q0 -5 5 2 V12';
  return (
    <path
      d={path}
      fill={colour}
      stroke="#242d32"
      strokeWidth="2.2"
      strokeLinejoin="round"
      strokeDasharray={outline}
    />
  );
}

/** Render map terrain and pieces, then overlay only the legal spatial choices supplied by the screen. */
export function BoardView({
  board,
  state,
  actions,
  colours,
  onAction,
  highlighted = {},
  produced = [],
  productionKey = 0,
}: BoardProps) {
  const [hoverDetail, setHoverDetail] = useState('');
  const points = board.vertices.map(point);
  const minX = Math.min(...points.map((p) => p.x)) - 22;
  const minY = Math.min(...points.map((p) => p.y)) - 22;
  const width = Math.max(...points.map((p) => p.x)) - minX + 22;
  const height = Math.max(...points.map((p) => p.y)) - minY + 22;
  const centre = { x: minX + width / 2, y: minY + height / 2 };
  const ownerColour = (owner: number) => colours[owner] ?? '#ae6684';

  return (
    <figure className="board-figure">
      <svg
        className="board-svg"
        viewBox={`${minX} ${minY} ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        data-land-width={width - 44}
        data-land-height={height - 44}
        data-viewbox-width={width}
        data-viewbox-height={height}
        role="group"
        aria-label="Dardania map. Highlighted places are available actions."
      >
        <title>Dardania: the Aegean plain</title>
        <desc>
          Terrain tokens show production totals and probability pips. Coastal temples are shrines;
          anchors are harbours. Each house has a distinct piece outline.
        </desc>
        <rect x={minX} y={minY} width={width} height={height} rx="18" fill="#194d58" />
        <g
          className="board-terrain"
          data-testid="land-shape"
          data-land-width={width - 44}
          data-land-height={height - 44}
        >
          {board.hexes.map((hex) => {
            const p = hexCentre(board, hex.vertices);
            const hot = CONFIG.map.hotTokens.some((n) => n === hex.number);
            const label = `${hexName(board, hex.id)}${hex.number ? `, produces on ${hex.number}, ${hex.pips} probability pips` : ', no production'}${state.warband === hex.id ? ', occupied by the Warband' : ''}`;
            return (
              <g
                key={hex.id}
                className={`terrain terrain-${hex.terrain}${produced.includes(hex.id) ? ' produced-hex' : ''}`}
                onMouseEnter={() => setHoverDetail(label)}
                onMouseLeave={() => setHoverDetail('')}
              >
                <title>{label}</title>
                <polygon
                  key={produced.includes(hex.id) ? `roll-${productionKey}` : 'land'}
                  data-hex={hex.id}
                  points={hex.vertices.map((id) => `${points[id].x},${points[id].y}`).join(' ')}
                  fill={TERRAIN_COLOURS[hex.terrain]}
                  stroke="#e6d6af"
                  strokeWidth="2"
                  strokeLinejoin="round"
                />
                <path
                  d={GLYPHS[hex.terrain]}
                  transform={`translate(${p.x} ${p.y - 18}) scale(.78)`}
                  fill={hex.terrain === 2 || hex.terrain === 5 ? 'none' : '#35463e'}
                  stroke="#35463e"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity=".77"
                />
                {hex.number > 0 && (
                  <g
                    className={`number-token${hot ? ' hot-token' : ''}`}
                    transform={`translate(${p.x} ${p.y + 18})`}
                  >
                    <circle
                      r="24"
                      fill="#f6e9ca"
                      stroke={hot ? '#9b372e' : '#826b48'}
                      strokeWidth={hot ? 2.5 : 1.5}
                    />
                    <text
                      y="6"
                      textAnchor="middle"
                      fill={hot ? '#9b372e' : '#293638'}
                      fontSize="32"
                      fontWeight="750"
                      fontFamily="Georgia, serif"
                    >
                      {hex.number}
                    </text>
                    {Array.from({ length: hex.pips }, (_, i) => (
                      <circle
                        key={i}
                        cx={(i - (hex.pips - 1) / 2) * 6}
                        cy="15"
                        r="2"
                        fill={hot ? '#9b372e' : '#293638'}
                      />
                    ))}
                  </g>
                )}
                {state.warband === hex.id && (
                  <g
                    className="warband"
                    transform={`translate(${p.x + 27} ${p.y - 12})`}
                    aria-label="Warband"
                  >
                    <title>Warband: production blocked except for Citadels</title>
                    <circle r="17" fill="#272e35" stroke="#f0d492" strokeWidth="1.8" />
                    <path
                      d="M-7 11 L6 -12 M7 11 L-6 -12 M-9 -6 L-6 -12 L-3 -6 M3 -6 L6 -12 L9 -6 M-6 1 Q0 -7 6 1 V8 H-6 Z M0 -1 V9"
                      fill="none"
                      stroke="#f0d492"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </g>
                )}
              </g>
            );
          })}
        </g>
        <g className="board-landmarks">
          {board.vertices
            .filter((v) => v.shrine || v.harbour)
            .map((v) => {
              const p = points[v.id];
              const marker = coastalMarker(p, centre, { x: minX, y: minY, width, height });
              return (
                <g key={v.id} transform={`translate(${marker.x} ${marker.y})`}>
                  <title>
                    {v.shrine
                      ? 'Coastal shrine: +1 Renown with a building here'
                      : 'Harbour: market price discount with a building here'}
                    , {vertexName(board, v.id)}
                  </title>
                  <path
                    d={`M0 0 L${p.x - marker.x} ${p.y - marker.y}`}
                    stroke="#e7d9b7"
                    strokeWidth="1.5"
                    strokeDasharray="2 3"
                  />
                  <circle r="20" fill="#194d58" stroke="#e7d9b7" strokeWidth="1.8" />
                  {v.shrine ? (
                    <path
                      transform="scale(1.55)"
                      d="M-9 -3 L0 -9 L9 -3 Z M-6 -2 V7 M0 -2 V7 M6 -2 V7 M-9 9 H9"
                      fill="none"
                      stroke="#f6d896"
                      strokeWidth="2.2"
                      strokeLinejoin="round"
                    />
                  ) : (
                    <path
                      transform="scale(1.55)"
                      d="M0 -4 V9 M-6 0 H6 M-9 3 Q-8 10 0 10 Q8 10 9 3 M-9 3 L-9 7 M9 3 V7 M0 -10 A3 3 0 1 0 0 -4 A3 3 0 1 0 0 -10"
                      fill="none"
                      stroke="#d5ece5"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  )}
                </g>
              );
            })}
        </g>
        <g className="board-tracks">
          {board.edges
            .filter((e) => state.edgeOwner[e.id] >= 0)
            .map((edge) => {
              const owner = state.edgeOwner[edge.id];
              const a = points[edge.vertices[0]],
                b = points[edge.vertices[1]];
              const path = `M${a.x} ${a.y} L${b.x} ${b.y}`;
              return (
                <g key={edge.id} className={`player-piece owner-${owner}`}>
                  <title>
                    House {owner + 1}, {edgeName(board, edge.id)}
                  </title>
                  <path
                    d={path}
                    fill="none"
                    stroke="#242d32"
                    strokeWidth="10"
                    strokeLinecap="round"
                  />
                  <path
                    d={path}
                    fill="none"
                    stroke={ownerColour(owner)}
                    strokeWidth="7"
                    strokeLinecap="round"
                  />
                  {owner > 0 && (
                    <path
                      d={path}
                      fill="none"
                      stroke="#f5e9cc"
                      strokeWidth="1.7"
                      strokeDasharray={OWNER_DASHES[owner % OWNER_DASHES.length]}
                    />
                  )}
                </g>
              );
            })}
        </g>
        <g className="board-buildings">
          {board.vertices
            .filter((v) => state.vertexOwner[v.id] >= 0)
            .map((v) => {
              const owner = state.vertexOwner[v.id];
              return (
                <g
                  key={v.id}
                  transform={`translate(${points[v.id].x} ${points[v.id].y})`}
                  className={`player-piece owner-${owner}`}
                >
                  <title>
                    House {owner + 1} {Building[state.vertexKind[v.id]]}, {vertexName(board, v.id)}
                  </title>
                  <BuildingPiece
                    kind={state.vertexKind[v.id]}
                    colour={ownerColour(owner)}
                    owner={owner}
                  />
                </g>
              );
            })}
        </g>
        <g className="board-history-highlights" pointerEvents="none" aria-hidden="true">
          {(highlighted.hexes ?? []).map(
            (id) =>
              board.hexes[id] && (
                <polygon
                  key={`hex-${id}`}
                  className="highlighted-hex"
                  points={board.hexes[id].vertices
                    .map((v) => `${points[v].x},${points[v].y}`)
                    .join(' ')}
                  fill="#fff3aa"
                  fillOpacity=".2"
                  stroke="#fff29d"
                  strokeWidth="7"
                  strokeLinejoin="round"
                />
              ),
          )}
          {(highlighted.edges ?? []).map((id) => {
            const edge = board.edges[id];
            if (!edge) return null;
            const [a, b] = edge.vertices.map((v) => points[v]);
            return (
              <path
                key={`edge-${id}`}
                className="highlighted-edge"
                d={`M${a.x} ${a.y} L${b.x} ${b.y}`}
                fill="none"
                stroke="#fff29d"
                strokeWidth="15"
                strokeLinecap="round"
              />
            );
          })}
          {(highlighted.vertices ?? []).map(
            (id) =>
              points[id] && (
                <circle
                  key={`vertex-${id}`}
                  className="highlighted-vertex"
                  cx={points[id].x}
                  cy={points[id].y}
                  r="25"
                  fill="#fff3aa"
                  fillOpacity=".25"
                  stroke="#fff29d"
                  strokeWidth="6"
                />
              ),
          )}
        </g>
        <g className="board-choices">
          {actions.map((action) => {
            let label: string;
            let shape;
            let key: string;
            let detail: string;
            if (
              action.type === 'placeSteading' ||
              action.type === 'buildSteading' ||
              action.type === 'upgrade'
            ) {
              const p = points[action.v];
              label = `${action.type === 'upgrade' ? `Upgrade to ${state.vertexKind[action.v] === Building.Steading ? 'Town' : 'Citadel'}` : 'Place Steading'} at ${vertexName(board, action.v)}`;
              detail = siteDetails(board, action.v);
              key = `${action.type}-${action.v}`;
              shape = (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r="18"
                  fill="#fff6cd"
                  fillOpacity=".45"
                  stroke="#fff2a4"
                  strokeWidth="4"
                  strokeDasharray="4 2"
                />
              );
            } else if (
              action.type === 'placeTrack' ||
              action.type === 'buildTrack' ||
              action.type === 'freeTrack'
            ) {
              const edge = board.edges[action.e];
              const a = points[edge.vertices[0]],
                b = points[edge.vertices[1]];
              label = `${action.type === 'freeTrack' ? 'Place for free:' : 'Build'} ${edgeName(board, action.e)}`;
              detail = label;
              key = `${action.type}-${action.e}`;
              const trackPath = `M${a.x * 0.78 + b.x * 0.22} ${a.y * 0.78 + b.y * 0.22} L${a.x * 0.22 + b.x * 0.78} ${a.y * 0.22 + b.y * 0.78}`;
              shape = (
                <g>
                  {/* Nonzero geometry keeps vertical paths accessible to browser hit testing. */}
                  <circle
                    cx={(a.x + b.x) / 2}
                    cy={(a.y + b.y) / 2}
                    r="15"
                    fill="transparent"
                    pointerEvents="all"
                  />
                  {/* A continuous hit target prevents dashed gaps from swallowing a click. */}
                  <path
                    d={trackPath}
                    stroke="transparent"
                    strokeWidth="28"
                    strokeLinecap="round"
                    pointerEvents="stroke"
                  />
                  <path
                    d={trackPath}
                    stroke="#fff2a4"
                    strokeWidth="14"
                    strokeLinecap="round"
                    strokeDasharray="3 4"
                    pointerEvents="none"
                  />
                </g>
              );
            } else if (action.type === 'moveWarband') {
              const hex = board.hexes[action.hex];
              const p = hexCentre(board, hex.vertices);
              label = `Move Warband to ${hexName(board, hex.id)}`;
              detail = label;
              key = `${action.type}-${action.hex}`;
              shape = (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r="41"
                  fill="#fff6cd"
                  fillOpacity=".14"
                  stroke="#fff2a4"
                  strokeWidth="4"
                  strokeDasharray="6 4"
                />
              );
            } else return null;
            return (
              <g
                key={key}
                className="board-choice"
                data-testid="board-choice"
                data-action={action.type}
                data-target={
                  'v' in action
                    ? action.v
                    : 'e' in action
                      ? action.e
                      : 'hex' in action
                        ? action.hex
                        : undefined
                }
                role="button"
                tabIndex={0}
                aria-label={`${label}. ${detail}`}
                onMouseEnter={() => setHoverDetail(detail)}
                onMouseLeave={() => setHoverDetail('')}
                onFocus={() => setHoverDetail(detail)}
                onBlur={() => setHoverDetail('')}
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  setHoverDetail('');
                  onAction(action);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onAction(action);
                  }
                }}
              >
                <title>{detail}</title>
                {shape}
              </g>
            );
          })}
        </g>
      </svg>
      <figcaption className="board-caption">
        <span>
          Last roll: <strong>{state.lastRoll || '—'}</strong>
        </span>
        <span className="board-legend">
          <svg width="24" height="24" viewBox="-13 -13 26 26" aria-hidden="true">
            <path
              d="M-9 -3 L0 -9 L9 -3 Z M-6 -2 V7 M0 -2 V7 M6 -2 V7 M-9 9 H9"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>{' '}
          Shrine: +1 Renown{' '}
          <svg width="24" height="24" viewBox="-13 -13 26 26" aria-hidden="true">
            <path
              d="M0 -7 V9 M-6 0 H6 M-9 3 Q-8 10 0 10 Q8 10 9 3 M-9 3 V7 M9 3 V7 M0 -12 A2.5 2.5 0 1 0 0 -7 A2.5 2.5 0 1 0 0 -12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>{' '}
          Harbour: cheaper market · Dots: production chance
        </span>
        {actions.length > 0 && (
          <span className="board-instruction">
            Choose a highlighted place. Tab and Enter work too.
          </span>
        )}
        {hoverDetail && (
          <span className="board-hover-detail" role="status" style={{ fontSize: '14px' }}>
            {hoverDetail}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
