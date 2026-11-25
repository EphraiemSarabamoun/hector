/** Greedy preview implementation of the announced AI API; replaced through the aiPort barrel. */
import { GreedyBot, type Bot } from '../bots/index.js';
export const TIERS = [
  { name: 'Astyanax', description: 'A young house finding its feet.' },
  { name: 'Paris', description: 'An opportunist with an eye for trade.' },
  { name: 'Aeneas', description: 'A steady builder with a long view.' },
  { name: 'Sarpedon', description: 'A commander who contests every advantage.' },
  { name: 'Hector', description: 'The strongest rival. Built to challenge you.' },
] as const;
export type Tier = (typeof TIERS)[number]['name'];
/** Match the forthcoming search factory while keeping the current baseline honest in the UI. */
export function createAIBot(
  tierName: Tier,
  _seed: number | string,
  _overrides?: Record<string, unknown>,
): Bot {
  if (!TIERS.some((tier) => tier.name === tierName))
    throw new Error(`Unknown AI tier: ${tierName}`);
  const bot = new GreedyBot();
  return {
    name: `${tierName} (baseline)`,
    chooseAction: (board, state, player) => bot.chooseAction(board, state, player),
  };
}
