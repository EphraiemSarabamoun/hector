/** Proxy-controller checks isolate offer bookkeeping from the exhaustive trade evaluator's own tests. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGame,
  apply,
  serializeState,
  legalActions,
  Card,
  CARD_COUNT,
  type Action,
} from '../src/engine/index.js';
import { AIBot, tierByName, type SearchConfig } from '../src/ai/index.js';
import { proposeBestTrade, tradeOfferKey } from '../src/ai/trade.js';
import { TraderBot } from '../tools/trader.js';
import {
  entrantOptions,
  makeBot,
  resolvedEntrant,
  resolvedTierConfig,
  playGame,
} from '../tools/ai-common.js';
import { arenaEntrants } from '../tools/arena.js';

vi.mock('../src/ai/trade.js', async (original) => ({
  ...(await original<typeof import('../src/ai/trade.js')>()),
  proposeBestTrade: vi.fn(),
}));
const propose = vi.mocked(proposeBestTrade);
function position() {
  const game = createGame('trader-proxy');
  game.state.phase = 'main';
  game.state.turn = 1;
  game.state.active = 0;
  game.state.toAct = 0;
  game.state.hands.fill(10);
  return game;
}
const offers = [1, 2, 3].map((units) => ({
  type: 'proposeTrade' as const,
  to: 1,
  give: [units, 0, 0, 0, 0],
  get: [0, 1, 0, 0, 0],
}));
offers.push({ ...offers[0], to: 2 });
beforeEach(() => {
  propose.mockReset();
  propose.mockReturnValue(null);
  vi.spyOn(AIBot.prototype, 'chooseAction').mockReturnValue({ type: 'endTurn' });
});
afterEach(() => vi.restoreAllMocks());

describe('Trader exhaustive proxy wrapper', () => {
  it('tries four distinct proposals, suppresses repeats within a turn, and resets next turn', () => {
    const { board, state } = position();
    const partner = { ...tierByName('Hector'), humanPlayers: [0] };
    propose.mockImplementation((_board, _state, _player, config, _seed, options) => {
      expect(config.tradeProposals).toBe(4);
      expect(config.activeTrading).toBe(true);
      expect(options!.partnerConfig!(1)).toBe(partner);
      return offers.find((offer) => !options!.excludedOfferKeys!.has(tradeOfferKey(offer))) ?? null;
    });
    const bot = new TraderBot(
      'Aeneas',
      5,
      { activeTrading: false, tradeProposals: 1 },
      () => partner,
    );
    expect(bot.config).toMatchObject({ activeTrading: false, tradeProposals: 0 });
    for (const offer of offers) {
      expect(bot.chooseAction(board, state, 0)).toEqual(offer);
      apply(board, state, offer);
      apply(board, state, { type: 'respondTrade', accept: false });
    }
    expect(state.proposals).toBe(4);
    expect(bot.chooseAction(board, state, 0)).toEqual({ type: 'endTurn' });
    expect(propose).toHaveBeenCalledTimes(4);
    state.turn++;
    state.proposals = 0;
    expect(bot.chooseAction(board, state, 0)).toEqual(offers[0]);
  });
  it('uses an independent reproducible stream and canonical private samples without changing real state', () => {
    const { board, state } = position();
    const seeds: number[] = [];
    const samples: string[] = [];
    propose.mockImplementation((_board, sample, _player, _config, seed) => {
      seeds.push(seed);
      samples.push(serializeState(sample));
      return offers[0];
    });
    const other = { ...state, deck: state.deck.slice() };
    other.deck.subarray(0, other.deckCount).reverse();
    const before = serializeState(state);
    const a = new TraderBot('Aeneas', 'same', {}, () => tierByName('Hector'));
    const b = new TraderBot('Aeneas', 'same', {}, () => tierByName('Hector'));
    expect(a.chooseAction(board, state, 0)).toEqual(b.chooseAction(board, other, 0));
    expect(seeds[0]).toBe(seeds[1]);
    expect(samples[0]).toBe(samples[1]);
    expect(serializeState(state)).toBe(before);
  });
  it('delegates responses and absent offers to the normal configured tier', () => {
    const { board, state } = position();
    const bot = new TraderBot('Paris', 1, { budget: 1 }, () => tierByName('Hector'));
    expect(bot.normalBase).toBe('Paris');
    expect(bot.config.budget).toBe(1);
    expect(bot.chooseAction(board, state, 0)).toEqual({ type: 'endTurn' });
    state.phase = 'tradeResponse';
    vi.mocked(AIBot.prototype.chooseAction).mockReturnValue({
      type: 'respondTrade',
      accept: false,
    });
    expect(bot.chooseAction(board, state, 0)).toEqual({ type: 'respondTrade', accept: false });
    expect(propose).toHaveBeenCalledTimes(1);
  });
  it('passes actual resolved partner policies without constructing or consulting their controllers', () => {
    const { board, state } = position();
    const partner = resolvedTierConfig({
      name: 'Hector',
      overrides: { budget: 3, delta: 0, humanPlayers: [0] },
    })!;
    const callback = vi.fn(() => partner);
    propose.mockImplementation((_b, _s, _p, _c, _seed, options) => {
      expect(options!.partnerConfig!(2)).toBe(partner);
      return null;
    });
    const bot = makeBot(
      { name: 'Trader', normalBase: 'Paris', overrides: { budget: 2 } },
      7,
      callback,
    );
    bot.chooseAction(board, state, 0);
    expect(callback).toHaveBeenCalledExactlyOnceWith(2);
    expect(vi.mocked(AIBot.prototype.chooseAction)).toHaveBeenCalledTimes(1);
    expect(
      resolvedEntrant({ name: 'Trader', normalBase: 'Paris', overrides: { budget: 2 } }),
    ).toMatchObject({
      name: 'Trader',
      normalBase: 'Paris',
      baseConfig: { budget: 2, humanPlayers: [] },
      trader: { exhaustive: true, maxProposals: 4, maxUnitsPerSide: 3 },
    });
  });
  it('wires each actual opponent policy through the game runner in one terminal fixture turn', () => {
    vi.mocked(AIBot.prototype.chooseAction).mockImplementation(
      (board, state) => legalActions(board, state)[0],
    );
    let checked = false;
    propose.mockImplementation((_board, _state, _player, _config, _seed, options) => {
      expect(options!.partnerConfig!(1)).toMatchObject({ budget: 3, delta: 0, humanPlayers: [0] });
      expect(options!.partnerConfig!(2)).toMatchObject({ budget: 4, humanPlayers: [0] });
      checked = true;
      return null;
    });
    const result = playGame(
      0,
      101,
      [
        { name: 'Trader', normalBase: 'Aeneas' },
        { name: 'Hector', overrides: { budget: 3, delta: 0, humanPlayers: [0] } },
        { name: 'Paris', overrides: { budget: 4, humanPlayers: [0] } },
      ],
      (_board, state) => {
        // Stop after setup and one ordinary action; this test checks wiring, not playing strength.
        state.active = 0;
        state.toAct = 0;
        state.turnIndex = state.turnOrder.indexOf(0);
        state.phase = 'main';
        state.hands.fill(20);
        state.cards[Card.Monument] = 12;
      },
    );
    expect(checked).toBe(true);
    expect(result.winner).toBe(0);
    expect(result.turns).toBe(1);
  });
});

describe('matched human context and explicit arena policies', () => {
  it('rotates identical rival human contexts for Trader and its plain matched base', () => {
    for (let game = 0; game < 3; game++) {
      const plain = arenaEntrants(game, {
        challenger: { name: 'Aeneas' },
        opponent: { name: 'Hector' },
        humanChallenger: true,
      });
      const proxy = arenaEntrants(game, {
        challenger: { name: 'Trader', normalBase: 'Aeneas' },
        opponent: { name: 'Hector' },
        humanChallenger: true,
      });
      for (let p = 0; p < 3; p++) {
        expect(plain[p].overrides!.humanPlayers).toEqual(p === game ? [] : [game]);
        expect(proxy[p].overrides!.humanPlayers).toEqual(plain[p].overrides!.humanPlayers);
      }
    }
    expect(
      arenaEntrants(1, { challenger: { name: 'Aeneas' }, opponent: { name: 'Hector' } }).every(
        (e) => e.overrides!.humanPlayers!.length === 0,
      ),
    ).toBe(true);
    expect(resolvedTierConfig({ name: 'Aeneas' })!.humanPlayers).toEqual([]);
  });
  it('parses fixed activity, proposal and fair-split overrides without changing tier defaults', async () => {
    const defaults = JSON.stringify(tierByName('Hector'));
    expect(
      await entrantOptions(
        [
          '--opponent-active-trading',
          'false',
          '--opponent-trade-proposals',
          '4',
          '--opponent-delta',
          '0',
        ],
        'opponent',
      ),
    ).toEqual({ activeTrading: false, tradeProposals: 4, delta: 0 });
    for (const [flag, value] of [
      ['active-trading', 'yes'],
      ['trade-proposals', '0'],
      ['trade-proposals', '5'],
      ['trade-proposals', '1.5'],
      ['delta', '-1'],
      ['delta', 'Infinity'],
      ['delta', 'NaN'],
    ])
      await expect(entrantOptions([`--opponent-${flag}`, value], 'opponent')).rejects.toThrow();
    expect(JSON.stringify(tierByName('Hector'))).toBe(defaults);
  });
});
