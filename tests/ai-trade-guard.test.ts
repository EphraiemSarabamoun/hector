/** Public trade-history and bounded-generosity regressions, including saved exact maxima. */
import { describe, expect, it } from 'vitest';
import maxima from './fixtures/trade-guard-maxima.json' with { type: 'json' };
import {
  apply,
  Card,
  cloneState,
  createGame,
  deserializeState,
  Good,
  GOOD_COUNT,
  isLegal,
  serializeState,
  stateHash,
  type Action,
  type Board,
  type GameState,
} from '../src/engine/index.js';
import {
  acceptsTrade,
  assessTrade,
  createAIBot,
  evaluate,
  FEATURE_NAMES,
  tierByName,
  tradeDeclineReason,
  W0,
  type SearchConfig,
} from '../src/ai/index.js';
import { applyWithTradeHistory, hasAcceptedTrade } from '../src/ai/trade-history.js';

type Offer = Extract<Action, { type: 'proposeTrade' }>;
type Position = { board: Board; state: GameState };
const guarded = ['Aeneas', 'Sarpedon', 'Hector'] as const;
const generous = ['Astyanax', 'Paris'] as const;
const first: Offer = {
  type: 'proposeTrade',
  to: 1,
  give: [1, 0, 0, 0, 0],
  get: [0, 0, 0, 0, 2],
};
const second: Offer = { ...first, to: 2, get: [0, 0, 0, 0, 1] };

/** Make an exchange whose recipient values Timber and is happy to shed Horses. */
function tradeWeights(): number[] {
  const weights = W0.map(() => 0);
  weights[FEATURE_NAMES.indexOf('handTimber')] = 0.8;
  weights[FEATURE_NAMES.indexOf('handHorses')] = -0.8;
  return weights;
}

/** Keep custom-value tests independent of the tuned model, retaining the tier's guard default. */
function settings(name = 'Aeneas', overrides: Partial<SearchConfig> = {}): SearchConfig {
  return {
    ...tierByName(name),
    weights: tradeWeights(),
    eps: 0.001,
    delta: 0.01,
    timeLimitMs: 0,
    ...overrides,
  };
}

/** Small hands and zero Renown leave the finishing guard provably inactive. */
function main(seed = 'trade-guard'): Position {
  const game = createGame(seed);
  Object.assign(game.state, { phase: 'main', active: 0, toAct: 0, turn: 1, turnIndex: 0 });
  game.state.turnOrder.set([0, 1, 2]);
  game.state.hands[Good.Timber] = 3;
  game.state.hands[GOOD_COUNT + Good.Horses] = 3;
  game.state.hands[2 * GOOD_COUNT + Good.Horses] = 3;
  return game;
}

/** Every simulated real acceptance uses the public integration boundary, including manual humans. */
function offer(position: Position, action = first): void {
  expect(isLegal(position.board, position.state, action)).toBe(true);
  applyWithTradeHistory(position.board, position.state, action);
}

function acceptFirst(position: Position): void {
  offer(position);
  applyWithTradeHistory(position.board, position.state, { type: 'respondTrade', accept: true });
}

/** A newly delivered worker request cannot rely on either Board or bot object identity. */
const copies: { name: string; copy: (position: Position) => Position }[] = [
  {
    name: 'engine cloneState',
    copy: ({ board, state }) => ({ board, state: cloneState(state) }),
  },
  {
    name: 'worker structuredClone of board and state',
    copy: (position) => structuredClone(position),
  },
  {
    name: 'serialized state and newly cloned board',
    copy: ({ board, state }) => ({
      board: structuredClone(board),
      state: deserializeState(serializeState(state)),
    }),
  },
];

describe('maximum trade witnesses', () => {
  it.each(maxima.witnesses)('preserves the exact legacy $tier maximum', (witness) => {
    const position = {
      board: createGame(witness.seed).board,
      state: deserializeState(witness.serializedState),
    };
    expect(stateHash(position.state)).toBe(witness.stateHash);
    expect(position.state.active).toBe(witness.proposer);
    const config = {
      ...tierByName(witness.tier),
      humanPlayers: [witness.proposer],
      tradeGuards: false,
    };
    for (const action of witness.offers) {
      offer(position, action as Offer);
      expect(
        acceptsTrade(
          position.board,
          position.state,
          action.to,
          config,
          991 + witness.positionIndex,
        ),
      ).toBe(true);
      applyWithTradeHistory(position.board, position.state, { type: 'respondTrade', accept: true });
    }
    const finalHand = Array.from(
      position.state.hands.subarray(
        witness.proposer * GOOD_COUNT,
        (witness.proposer + 1) * GOOD_COUNT,
      ),
    );
    expect(finalHand).toEqual(witness.finalHand);
    expect(finalHand.reduce((sum, count, g) => sum + count - witness.baseHand[g], 0)).toBe(
      witness.maxTwoLegNetGoods,
    );
  });

  it.each(guarded)(
    '%s rejects the exact maximum first leg by G2 for human and bot proposers',
    (name) => {
      const witness = maxima.witnesses.find((row) => row.tier === name)!;
      expect(witness.maxTwoLegNetGoods).toBe(4);
      expect(witness.offers[0].give.reduce((n, count) => n + count, 0)).toBe(1);
      expect(witness.offers[0].get.reduce((n, count) => n + count, 0)).toBe(3);
      for (const humanPlayers of [[], [witness.proposer]]) {
        const position = {
          board: createGame(witness.seed).board,
          state: deserializeState(witness.serializedState),
        };
        offer(position, witness.offers[0] as Offer);
        const before = serializeState(position.state);
        const config = { ...tierByName(name), humanPlayers };
        expect(
          assessTrade(
            position.board,
            position.state,
            position.state.toAct,
            config,
            991 + witness.positionIndex,
          ),
        ).toEqual({
          accept: false,
          reason: 'too many goods for too few',
        });
        expect(
          acceptsTrade(
            position.board,
            position.state,
            position.state.toAct,
            config,
            991 + witness.positionIndex,
          ),
        ).toBe(false);
        expect(serializeState(position.state)).toBe(before);
      }
    },
  );

  it.each(generous)(
    '%s still accepts both exact maximum legs with its default guard setting',
    (name) => {
      const witness = maxima.witnesses.find((row) => row.tier === name)!;
      const position = {
        board: createGame(witness.seed).board,
        state: deserializeState(witness.serializedState),
      };
      const config = { ...tierByName(name), humanPlayers: [witness.proposer] };
      for (const action of witness.offers) {
        offer(position, action as Offer);
        expect(
          assessTrade(
            position.board,
            position.state,
            action.to,
            config,
            991 + witness.positionIndex,
          ),
        ).toEqual({ accept: true });
        applyWithTradeHistory(position.board, position.state, {
          type: 'respondTrade',
          accept: true,
        });
      }
      expect(
        Array.from(
          position.state.hands.subarray(
            witness.proposer * GOOD_COUNT,
            (witness.proposer + 1) * GOOD_COUNT,
          ),
        ),
      ).toEqual(witness.finalHand);
    },
  );
});

describe('G1 table-wide accepted-trade history', () => {
  for (const { name: copyName, copy } of copies) {
    it.each(guarded)(
      `%s blocks a second rival after ${copyName}, with fresh controllers and either proposer type`,
      (name) => {
        for (const humanPlayers of [[], [0]]) {
          const position = main();
          offer(position);
          const config = settings(name, { humanPlayers });
          expect(assessTrade(position.board, position.state, 1, config, 7)).toEqual({
            accept: true,
          });
          applyWithTradeHistory(position.board, position.state, {
            type: 'respondTrade',
            accept: true,
          });
          const delivered = copy(position);
          expect(hasAcceptedTrade(delivered.board, delivered.state, 0)).toBe(true);
          expect(hasAcceptedTrade(delivered.board, delivered.state, 1)).toBe(false);
          expect(hasAcceptedTrade(delivered.board, delivered.state, 2)).toBe(false);
          offer(delivered, second);
          expect(
            assessTrade(delivered.board, delivered.state, 2, { ...config, tradeGuards: false }, 7),
          ).toEqual({ accept: true });
          expect(assessTrade(delivered.board, delivered.state, 2, config, 7)).toEqual({
            accept: false,
            reason: 'already traded this turn',
          });
          const before = serializeState(delivered.state);
          const boardBefore = JSON.stringify(delivered.board);
          expect(
            createAIBot(name, 7, config).chooseAction(delivered.board, delivered.state, 2),
          ).toEqual({ type: 'respondTrade', accept: false, reason: 'already traded this turn' });
          expect(
            createAIBot(name, 7, config).chooseAction(delivered.board, delivered.state, 2),
          ).toEqual({ type: 'respondTrade', accept: false, reason: 'already traded this turn' });
          expect(serializeState(delivered.state)).toBe(before);
          expect(JSON.stringify(delivered.board)).toBe(boardBefore);
        }
      },
    );
  }

  it.each(['manual human', 'unguarded Paris bot'])(
    'records acceptance by any recipient: %s',
    (recipient) => {
      const position = main();
      offer(position);
      const response =
        recipient === 'manual human'
          ? { type: 'respondTrade' as const, accept: true }
          : createAIBot('Paris', 17, settings('Paris')).chooseAction(
              position.board,
              position.state,
              1,
            );
      expect(response).toEqual({ type: 'respondTrade', accept: true });
      applyWithTradeHistory(position.board, position.state, response);
      offer(position, second);
      expect(assessTrade(position.board, position.state, 2, settings(), 17)).toEqual({
        accept: false,
        reason: 'already traded this turn',
      });
    },
  );

  it('proposals and declines do not consume the accepted-trade allowance', () => {
    const position = main();
    offer(position);
    expect(hasAcceptedTrade(position.board, position.state, 0)).toBe(false);
    applyWithTradeHistory(position.board, position.state, { type: 'respondTrade', accept: false });
    expect(hasAcceptedTrade(position.board, position.state, 0)).toBe(false);
    offer(position, second);
    expect(assessTrade(position.board, position.state, 2, settings(), 7)).toEqual({ accept: true });
  });

  it('a real next turn expires every proposer entry without mutating the previous record', () => {
    const position = main();
    acceptFirst(position);
    const history = Reflect.get(position.state, 'aiTradeHistory');
    const snapshot = JSON.stringify(history);
    expect(Object.isFrozen(history)).toBe(true);
    expect(hasAcceptedTrade(position.board, position.state, 0)).toBe(true);
    applyWithTradeHistory(position.board, position.state, { type: 'endTurn' });
    expect(position.state.turn).toBe(2);
    expect(hasAcceptedTrade(position.board, position.state, 0)).toBe(false);
    expect(JSON.stringify(history)).toBe(snapshot);
  });

  it('a new game on the same board/turn has no global history leakage', () => {
    const position = main('identical-reset');
    acceptFirst(position);
    const reset = main('identical-reset');
    expect(reset.state.turn).toBe(position.state.turn);
    expect(hasAcceptedTrade(reset.board, reset.state, 0)).toBe(false);
    expect(hasAcceptedTrade(position.board, position.state, 0)).toBe(true);
  });

  it('full board content, not seed or board-object identity, determines the history scope', () => {
    const position = main();
    acceptFirst(position);
    const identical = structuredClone(position.board);
    const different: Board = {
      ...identical,
      hexes: identical.hexes.map((hex, i) =>
        i ? hex : { ...hex, number: hex.number === 2 ? 3 : 2 },
      ),
    };
    expect(different.seed).toBe(position.board.seed);
    expect(hasAcceptedTrade(identical, position.state, 0)).toBe(true);
    expect(hasAcceptedTrade(different, position.state, 0)).toBe(false);
    expect(hasAcceptedTrade(createGame('different-history-board').board, position.state, 0)).toBe(
      false,
    );
  });

  it('G1 has priority over G2 and the finishing/value checks', () => {
    const position = main();
    acceptFirst(position);
    position.state.cards[Card.Monument] = 11;
    offer(position, { ...second, get: [0, 0, 0, 0, 3] });
    expect(assessTrade(position.board, position.state, 2, settings(), 3)).toEqual({
      accept: false,
      reason: 'already traded this turn',
    });
  });
});

describe('G2 bounded generosity and existing response reasons', () => {
  it.each(guarded)(
    '%s rejects paying two extra goods and retains the explicit legacy flag',
    (name) => {
      const position = main();
      offer(position, { ...first, get: [0, 0, 0, 0, 3] });
      const config = settings(name);
      expect(assessTrade(position.board, position.state, 1, config, 5)).toEqual({
        accept: false,
        reason: 'too many goods for too few',
      });
      expect(
        assessTrade(position.board, position.state, 1, { ...config, tradeGuards: false }, 5),
      ).toEqual({ accept: true });
      const before = serializeState(position.state);
      expect(
        createAIBot(name, 5, { ...config, tradeGuards: false }).chooseAction(
          position.board,
          position.state,
          1,
        ),
      ).toEqual({ type: 'respondTrade', accept: true });
      expect(createAIBot(name, 5, config).chooseAction(position.board, position.state, 1)).toEqual({
        type: 'respondTrade',
        accept: false,
        reason: 'too many goods for too few',
      });
      expect(serializeState(position.state)).toBe(before);
      expect(hasAcceptedTrade(position.board, position.state, 0)).toBe(false);
    },
  );

  it('paying exactly one extra good reaches the existing value test', () => {
    const position = main();
    offer(position);
    expect(assessTrade(position.board, position.state, 1, settings(), 5)).toEqual({ accept: true });
    expect(
      assessTrade(
        position.board,
        position.state,
        1,
        settings('Aeneas', { weights: W0.map(() => 0) }),
        5,
      ),
    ).toEqual({ accept: false, reason: 'does not help me' });
  });

  it('paying two extra goods rejects before an otherwise failing value test', () => {
    const position = main();
    offer(position, { ...first, get: [0, 0, 0, 0, 3] });
    expect(
      assessTrade(
        position.board,
        position.state,
        1,
        settings('Aeneas', { weights: W0.map(() => 0) }),
        5,
      ),
    ).toEqual({ accept: false, reason: 'too many goods for too few' });
  });

  it('the epsilon equality boundary remains accepted, and a larger required gain is declined', () => {
    const position = main();
    offer(position);
    const config = settings();
    const before = evaluate(position.board, position.state, config.weights);
    const after = cloneState(position.state);
    apply(position.board, after, { type: 'respondTrade', accept: true });
    const gain = evaluate(position.board, after, config.weights)[1] - before[1];
    expect(gain).toBeGreaterThan(0.001);
    expect(assessTrade(position.board, position.state, 1, { ...config, eps: gain }, 3)).toEqual({
      accept: true,
    });
    expect(
      assessTrade(position.board, position.state, 1, { ...config, eps: gain + 1e-8 }, 3),
    ).toEqual({ accept: false, reason: 'does not help me' });
  });

  it('still reports a value-improving exchange that could finish the proposer', () => {
    const position = main();
    position.state.cards[Card.Monument] = 11;
    position.state.row.fill(Card.Monument);
    position.state.hands.fill(0);
    position.state.hands.set([1, 0, 1, 1, 0]);
    position.state.hands[GOOD_COUNT + Good.Horses] = 1;
    offer(position, { ...first, get: [0, 0, 0, 0, 1] });
    expect(assessTrade(position.board, position.state, 1, settings(), 3)).toEqual({
      accept: false,
      reason: 'would let you win',
    });
    expect(acceptsTrade(position.board, position.state, 1, settings(), 3)).toBe(false);
  });

  it('G2 has priority over the finishing guard', () => {
    const position = main();
    position.state.cards[Card.Monument] = 11;
    offer(position, { ...first, get: [0, 0, 0, 0, 3] });
    expect(assessTrade(position.board, position.state, 1, settings(), 3)).toEqual({
      accept: false,
      reason: 'too many goods for too few',
    });
  });

  it('only the top three tier defaults enable the new guards', () => {
    for (const name of guarded) expect(createAIBot(name).config.tradeGuards).toBe(true);
    for (const name of generous) expect(Boolean(createAIBot(name).config.tradeGuards)).toBe(false);
  });
});

describe('applyWithTradeHistory integration boundary', () => {
  it.each([
    'already traded this turn',
    'too many goods for too few',
    'does not help me',
    'would let you win',
  ] as const)('carries the public decline reason to the existing engine event: %s', (reason) => {
    const position = main();
    offer(position);
    const action = { type: 'respondTrade' as const, accept: false, reason };
    expect(tradeDeclineReason(action)).toBe(reason);
    const events = applyWithTradeHistory(position.board, position.state, action);
    expect(events).toContainEqual({ type: 'tradeResponse', player: 1, accept: false, reason });
    expect(hasAcceptedTrade(position.board, position.state, 0)).toBe(false);
  });

  it('ignores unrecognized or acceptance-side reason metadata', () => {
    expect(
      tradeDeclineReason({
        type: 'respondTrade',
        accept: true,
        reason: 'does not help me',
      } as Action),
    ).toBeUndefined();
    const position = main();
    offer(position);
    const action = { type: 'respondTrade' as const, accept: false, reason: 'invented policy' };
    expect(tradeDeclineReason(action)).toBeUndefined();
    const events = applyWithTradeHistory(position.board, position.state, action);
    expect(events).toContainEqual({ type: 'tradeResponse', player: 1, accept: false });
  });

  it('returns the unchanged engine event sequence while recording actual acceptance', () => {
    const position = main();
    const engine = cloneState(position.state);
    const proposed = apply(position.board, engine, first);
    expect(applyWithTradeHistory(position.board, position.state, first)).toEqual(proposed);
    const accepted = apply(position.board, engine, { type: 'respondTrade', accept: true });
    expect(
      applyWithTradeHistory(position.board, position.state, { type: 'respondTrade', accept: true }),
    ).toEqual(accepted);
    expect(position.state.hands).toEqual(engine.hands);
    expect(position.state.phase).toBe(engine.phase);
    expect(hasAcceptedTrade(position.board, position.state, 0)).toBe(true);
  });

  it('forwards a forced roll without inventing accepted trades', () => {
    const position = main();
    position.state.phase = 'roll';
    const engine = cloneState(position.state);
    const events = apply(position.board, engine, { type: 'roll' }, 8);
    expect(applyWithTradeHistory(position.board, position.state, { type: 'roll' }, 8)).toEqual(
      events,
    );
    expect(serializeState(position.state)).toBe(serializeState(engine));
    expect(hasAcceptedTrade(position.board, position.state, 0)).toBe(false);
  });

  it('an illegal acceptance cannot create history or alter its source', () => {
    const position = main();
    const before = serializeState(position.state);
    expect(() =>
      applyWithTradeHistory(position.board, position.state, { type: 'respondTrade', accept: true }),
    ).toThrow();
    expect(serializeState(position.state)).toBe(before);
    expect(hasAcceptedTrade(position.board, position.state, 0)).toBe(false);
  });
});
