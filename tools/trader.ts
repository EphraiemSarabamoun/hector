/** Node-only exploit proxy: ordinary tier play with exhaustive, value-improving player trades. */
import {
  CONFIG,
  cloneState,
  nextRandom,
  randomizeHidden,
  seedValue,
  type Action,
  type Board,
  type GameState,
} from '../src/engine/index.js';
import {
  createAIBot,
  tierByName,
  proposeBestTrade,
  tradeOfferKey,
  type SearchConfig,
} from '../src/ai/index.js';
import type { Bot } from '../src/bots/index.js';
import { boardKey } from '../src/ai/board-key.js';

export const TRADER_POLICY = Object.freeze({
  exhaustive: true,
  maxProposals: CONFIG.trade.maxProposals,
  maxUnitsPerSide: CONFIG.trade.maxUnits,
  recipients: 'both rivals',
  repeatOffers: 'excluded within each turn',
  normalProposals: 'disabled; proxy owns all proposal generation',
});

/** Delegate accepts and ordinary play unchanged; one proxy alone owns offer history and generation. */
export function traderBaseConfig(
  normalBase = 'Aeneas',
  overrides: Partial<SearchConfig> = {},
): SearchConfig {
  return {
    ...tierByName(normalBase),
    humanPlayers: [],
    ...overrides,
    activeTrading: false,
    tradeProposals: 0,
  };
}

/** Wrap a normal tier without changing its answer policy or touching an opponent controller's RNG. */
export class TraderBot implements Bot {
  readonly name = 'Trader';
  readonly normalBase: string;
  readonly config: SearchConfig;
  private readonly normal: Bot;
  private readonly random: { rng: number };
  private readonly offers = new Set<string>();
  private lastBoard = '';
  private lastTurn = -1;
  private lastPlayer = -1;

  constructor(
    normalBase = 'Aeneas',
    seed: number | string = 0,
    overrides: Partial<SearchConfig> = {},
    private readonly partnerConfig: (to: number) => SearchConfig = () => {
      throw new Error('Trader requires resolved opponent tier configurations');
    },
  ) {
    const tier = tierByName(normalBase);
    this.normalBase = tier.name;
    this.config = traderBaseConfig(tier.name, overrides);
    // Keep the base controller's original seed for a matched plain-versus-proxy comparison.
    this.normal = createAIBot(tier.name, seed, this.config);
    this.random = { rng: seedValue(`${seed}:trader`) };
  }

  /** Offer the best predicted accepted trade before ordinary play, up to the rules' four-proposal limit. */
  chooseAction(board: Board, state: GameState, player: number): Action {
    const identity = boardKey(board);
    if (this.lastBoard !== identity || this.lastTurn !== state.turn || this.lastPlayer !== player) {
      this.offers.clear();
      this.lastBoard = identity;
      this.lastTurn = state.turn;
      this.lastPlayer = player;
    }
    if (
      state.phase === 'main' &&
      state.toAct === player &&
      state.proposals < CONFIG.trade.maxProposals
    ) {
      const seed = Math.floor(nextRandom(this.random) * 4294967296);
      const sample = cloneState(state);
      randomizeHidden(sample, seed);
      const offer = proposeBestTrade(
        board,
        sample,
        player,
        { ...this.config, activeTrading: true, tradeProposals: CONFIG.trade.maxProposals },
        seed,
        {
          partnerConfig: this.partnerConfig,
          excludedOfferKeys: this.offers,
        },
      );
      if (offer) {
        this.offers.add(tradeOfferKey(offer));
        return offer;
      }
    }
    return this.normal.chooseAction(board, state, player);
  }
}
