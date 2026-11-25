/** Exhaustive seed sweeps and state invariants protect replay and random-play integration. */
import { describe, it, expect } from 'vitest';
import {
  CONFIG,
  Good,
  Card,
  Building,
  GOOD_COUNT,
  CARD_COUNT,
  createGame,
  generateBoard,
  createState,
  cloneState,
  serializeState,
  deserializeState,
  stateHash,
  legalActions,
  isLegal,
  apply,
  renown,
  pieceCount,
  nextRandom,
  seedValue,
  reseed,
  DICE_OUTCOMES,
  type Board,
  type GameState,
  type Action,
} from '../src/engine/index.js';
import { RandomBot } from '../src/bots/index.js';
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function mapChecks(board: Board) {
  assert(board.hexes.length === CONFIG.map.land, 'land count');
  const seen = new Set([0]),
    queue = [0];
  for (let i = 0; i < queue.length; i++)
    for (const h of board.hexes[queue[i]].neighbours)
      if (!seen.has(h)) {
        seen.add(h);
        queue.push(h);
      }
  assert(seen.size === board.hexes.length, 'land connected');
  const land = new Set(board.hexes.map((h) => `${h.q},${h.r}`));
  const dirs = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
  ];
  const sea: string[] = [];
  for (let q = -CONFIG.map.radius; q <= CONFIG.map.radius; q++)
    for (let r = -CONFIG.map.radius; r <= CONFIG.map.radius; r++)
      if (
        Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r)) <= CONFIG.map.radius &&
        !land.has(`${q},${r}`)
      )
        sea.push(`${q},${r}`);
  for (const position of sea) {
    const [q, r] = position.split(',').map(Number);
    assert(
      dirs.some(([dq, dr]) => !land.has(`${q + dq},${r + dr}`)),
      'enclosed sea cell',
    );
  }
  const tokens = board.hexes
    .filter((h) => h.good >= 0)
    .map((h) => h.number)
    .sort((a, b) => a - b);
  assert(
    JSON.stringify(tokens) === JSON.stringify([...CONFIG.map.tokens].sort((a, b) => a - b)),
    'token multiset',
  );
  for (let t = 0; t < CONFIG.terrain.length; t++)
    assert(
      board.hexes.filter((h) => h.terrain === t).length ===
        (t < GOOD_COUNT ? CONFIG.map.productivePerTerrain : CONFIG.map.barrens),
      'terrain count',
    );
  for (const h of board.hexes) {
    assert(
      Math.max(Math.abs(h.q), Math.abs(h.r), Math.abs(h.q + h.r)) <= CONFIG.map.radius,
      'radius',
    );
    assert(h.neighbours.length >= CONFIG.map.minNeighbours, 'thin land');
    assert(
      h.neighbours.filter((n) => board.hexes[n].terrain === h.terrain).length <=
        CONFIG.map.maxSameTerrainNeighbours,
      'terrain adjacency',
    );
    const pips = h.number ? CONFIG.dice.sides - Math.abs(CONFIG.dice.lean - h.number) : 0;
    assert(h.pips === pips, 'pips');
    assert(h.vertices.length === 6 && new Set(h.vertices).size === 6, 'hex vertices');
    for (const n of h.neighbours) {
      assert(board.hexes[n].neighbours.includes(h.id), 'hex symmetry');
      if (h.good >= 0 && board.hexes[n].good >= 0) {
        assert(board.hexes[n].number !== h.number, 'adjacent equal number');
        assert(
          !(
            CONFIG.map.hotTokens.includes(h.number as 6 | 8) &&
            CONFIG.map.hotTokens.includes(board.hexes[n].number as 6 | 8)
          ),
          'adjacent hot tokens',
        );
      }
    }
  }
  for (let g = 0; g < GOOD_COUNT; g++) {
    const total = board.hexes.filter((h) => h.good === g).reduce((n, h) => n + h.pips, 0);
    assert(total >= CONFIG.map.minPips && total <= CONFIG.map.maxPips, 'good pip sum');
  }
  const shrines = board.vertices.filter((v) => v.shrine),
    harbours = board.vertices.filter((v) => v.harbour);
  assert(
    shrines.length === CONFIG.map.shrines && harbours.length === CONFIG.map.harbours,
    'landmark counts',
  );
  for (const a of shrines) {
    assert(a.coastal && a.hexes.length === CONFIG.map.shrineHexes, 'shrine eligibility');
    for (const b of shrines)
      if (a !== b)
        assert(board.distances[a.id][b.id] >= CONFIG.map.shrineDistance, 'shrine separation');
  }
  for (const a of harbours) {
    assert(a.coastal, 'harbour coastal');
    for (const b of harbours)
      if (a !== b)
        assert(board.distances[a.id][b.id] >= CONFIG.map.harbourDistance, 'harbour separation');
    for (const s of shrines)
      assert(
        board.distances[a.id][s.id] >= CONFIG.map.harbourShrineDistance,
        'harbour shrine distance',
      );
  }
  assert(board.hexes[board.initialWarband].good < 0, 'warband starts barren');
  for (const v of board.vertices) {
    assert(v.coastal === v.hexes.length < CONFIG.map.coastalHexes, 'coastal');
    assert(Number.isFinite(v.x) && Number.isFinite(v.y), 'coordinates');
    for (const h of v.hexes) assert(board.hexes[h].vertices.includes(v.id), 'vertex hex symmetry');
    for (const n of v.neighbours)
      assert(
        board.vertices[n].neighbours.includes(v.id) && board.distances[v.id][n] === 1,
        'vertex neighbours',
      );
    const distance = board.vertices.map(() => Infinity);
    distance[v.id] = 0;
    const todo = [v.id];
    for (let i = 0; i < todo.length; i++)
      for (const n of board.vertices[todo[i]].neighbours)
        if (distance[n] === Infinity) {
          distance[n] = distance[todo[i]] + 1;
          todo.push(n);
        }
    assert(
      distance.every((d, n) => d === board.distances[v.id][n]),
      'shortest path',
    );
  }
  for (const e of board.edges) {
    for (const v of e.vertices)
      assert(board.vertices[v].edges.includes(e.id), 'edge vertex symmetry');
    for (const n of e.neighbours)
      assert(
        board.edges[n].neighbours.includes(e.id) &&
          board.edges[n].vertices.some((v) => e.vertices.includes(v)),
        'edge neighbours',
      );
  }
  assert(
    Object.isFrozen(board) &&
      Object.isFrozen(board.vertices) &&
      Object.isFrozen(board.vertices[0]) &&
      Object.isFrozen(board.vertices[0].edges),
    'immutable board',
  );
}
function stateChecks(board: Board, state: GameState) {
  assert(
    [...state.hands].every((n) => Number.isInteger(n) && n >= 0),
    'nonnegative hands',
  );
  for (const n of state.market) assert(n >= 0 && n <= CONFIG.market.max, 'market bounds');
  for (const v of board.vertices)
    if (state.vertexOwner[v.id] >= 0)
      assert(
        v.neighbours.every((n) => state.vertexOwner[n] < 0),
        'building spacing',
      );
  for (let p = 0; p < state.players; p++) {
    assert(pieceCount(state, p, 'track') <= CONFIG.pieces.track, 'track supply');
    assert(pieceCount(state, p, Building.Steading) <= CONFIG.pieces.steading, 'steading supply');
    assert(pieceCount(state, p, Building.Town) <= CONFIG.pieces.town, 'town supply');
    assert(pieceCount(state, p, Building.Citadel) <= CONFIG.pieces.citadel, 'citadel supply');
    let score = 0;
    for (let v = 0; v < state.vertexOwner.length; v++)
      if (state.vertexOwner[v] === p)
        score +=
          [0, CONFIG.renown.steading, CONFIG.renown.town, CONFIG.renown.citadel][
            state.vertexKind[v]
          ] + (board.vertices[v].shrine ? CONFIG.renown.shrine : 0);
    score += state.cards[p * CARD_COUNT + Card.Monument] * CONFIG.renown.monument;
    if (state.warlord === p) score += CONFIG.renown.warlord;
    assert(renown(board, state, p) === score, 'renown recount');
    for (let c = 0; c < CARD_COUNT; c++)
      assert(
        state.freshCards[p * CARD_COUNT + c] <= state.cards[p * CARD_COUNT + c],
        'fresh card subset',
      );
  }
  for (let c = 0; c < CARD_COUNT; c++) {
    let count = state.discarded[c];
    for (let p = 0; p < state.players; p++) count += state.cards[p * CARD_COUNT + c];
    for (let i = 0; i < state.deckCount; i++) count += Number(state.deck[i] === c);
    for (let i = 0; i < state.rowCount; i++) count += Number(state.row[i] === c);
    assert(count === CONFIG.cards.counts[c], 'card conservation');
  }
  const actions = legalActions(board, state);
  assert(actions.length > 0 || state.phase === 'gameOver', 'nonempty decisions');
  for (const action of actions) {
    assert(isLegal(board, state, action), 'enumerated legality');
    apply(board, cloneState(state), action);
  }
}
describe('section 2 map generation', () => {
  it('satisfies every map constraint and repeats identically across 2,000 seeds', () => {
    for (let seed = 0; seed < 2000; seed++) {
      const board = generateBoard(seed);
      mapChecks(board);
      assert(
        JSON.stringify(board) === JSON.stringify(generateBoard(seed)),
        `deterministic seed ${seed}`,
      );
    }
  }, 120000);
});
describe('integration and replay', () => {
  it('finishes 2,000 random-bot games; checks every listed action after every action in 200 games', async () => {
    for (let seed = 0; seed < 2000; seed++) {
      if (seed % 10 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const { board, state } = createGame(seed);
      const bots = Array.from({ length: state.players }, (_, p) => new RandomBot(`${seed}:${p}`));
      let steps = 0;
      if (seed < 200) stateChecks(board, state);
      while (state.phase !== 'gameOver') {
        apply(board, state, bots[state.toAct].chooseAction(board, state, state.toAct));
        steps++;
        if (seed < 200) stateChecks(board, state);
        assert(steps < 50000, `excessive decisions seed ${seed}`);
      }
      assert(state.winnerId >= 0 && state.turn <= CONFIG.turnCap, 'finished game');
    }
  }, 240000);
  it('replays actions and chance exactly, survives JSON, and shares no clone buffers', () => {
    const a = createGame('replay'),
      b = createGame('replay');
    const bot = new RandomBot('choices');
    for (let i = 0; i < 500 && a.state.phase !== 'gameOver'; i++) {
      const action = bot.chooseAction(a.board, a.state, a.state.toAct);
      apply(a.board, a.state, action);
      apply(b.board, b.state, action);
      expect(stateHash(a.state)).toBe(stateHash(b.state));
    }
    const restored = deserializeState(serializeState(a.state));
    expect(stateHash(restored)).toBe(stateHash(a.state));
    const copy = cloneState(a.state);
    expect(stateHash(copy)).toBe(stateHash(a.state));
    for (const key of Object.keys(a.state) as (keyof GameState)[]) {
      const value = a.state[key];
      if (ArrayBuffer.isView(value)) {
        const other = copy[key] as Uint8Array;
        expect(other.buffer).not.toBe((value as Uint8Array).buffer);
        other[0]++;
      }
    }
    expect(stateHash(a.state)).toBe(stateHash(restored));
  });
  it('enumerates exact chance probabilities and reseeds independent futures', () => {
    expect(DICE_OUTCOMES).toHaveLength(CONFIG.dice.sides * CONFIG.dice.count - 1);
    expect(DICE_OUTCOMES.reduce((n, o) => n + o.probability, 0)).toBeCloseTo(1);
    const { board, state } = createGame('chance');
    const bot = new RandomBot('setup');
    while (state.phase !== 'roll') apply(board, state, bot.chooseAction(board, state, state.toAct));
    const original = state.rng;
    for (const outcome of DICE_OUTCOMES) {
      const copy = cloneState(state);
      apply(board, copy, { type: 'roll' }, outcome.total);
      expect(copy.lastRoll).toBe(outcome.total);
      expect(copy.rng).toBe(original);
    }
    expect(() => apply(board, state, { type: 'roll' }, 1)).toThrow();
    expect(state.rng).toBe(original);
    const copy = cloneState(state);
    reseed(copy, 'new');
    expect(copy.rng).not.toBe(state.rng);
    const random = { rng: seedValue('new') };
    expect(copy.rng).toBe(random.rng);
    nextRandom(random);
  });
  it('supports two and four players through complete setup and a finished game', () => {
    for (const players of [CONFIG.players.min, CONFIG.players.max]) {
      const { board, state } = createGame(`players-${players}`, players);
      const bot = new RandomBot(players);
      while (state.phase !== 'gameOver')
        apply(board, state, bot.chooseAction(board, state, state.toAct));
      expect(state.winnerId).toBeGreaterThanOrEqual(0);
    }
  });
});
