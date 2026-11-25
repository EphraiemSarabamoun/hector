/** Public feedback must match actual goods events and scoring, including blocked production. */
import { describe, it, expect } from 'vitest';
import { Building, createGame, cloneState, renown } from '../src/engine/index.js';
import { rollFeedback, transitionNotices } from '../src/ui/feedback.js';
import { groupChronicle, eventPlaces } from '../src/ui/Chronicle.js';
import { eventLabel, tradeResponseLabel } from '../src/ui/presentation.js';
const settings = {
  name: 'Human',
  colour: '#b84448',
  tiers: ['Aeneas', 'Hector'] as ['Aeneas', 'Hector'],
  seed: 'feedback',
  speed: 'instant' as const,
};
describe('public change feedback', () => {
  it('keeps the four actual decline reasons beside answers and in saved Chronicle text', () => {
    const { board } = createGame('trade-answer-feedback');
    const names = ['Human', 'Aeneas', 'Hector'];
    for (const reason of [
      'already traded this turn',
      'too many goods for too few',
      'does not help me',
      'would let you win',
    ]) {
      const event = { type: 'tradeResponse', player: 2, accept: false, reason };
      expect(tradeResponseLabel(event, names, 'your offer')).toBe(
        `Hector declined your offer: ${reason}`,
      );
      expect(eventLabel(event, names, board)).toBe(`Hector declined the trade: ${reason}`);
    }
    // Old saves can contain no reason; arbitrary metadata and acceptances invent none.
    expect(tradeResponseLabel({ type: 'tradeResponse', player: 1, accept: false }, names)).toBe(
      'Aeneas declined the trade',
    );
    for (const [accept, reason] of [
      [false, 'unknown reason'],
      [true, 'does not help me'],
    ] as const)
      expect(tradeResponseLabel({ type: 'tradeResponse', player: 1, accept, reason }, names)).toBe(
        `Aeneas ${accept ? 'accepted' : 'declined'} the trade`,
      );
  });
  it('flashes only productive occupied hexes, exempting Citadels from Warband blockage', () => {
    const { board, state } = createGame('feedback');
    const hex = board.hexes.find((h) => h.number === 6)!;
    state.vertexOwner[hex.vertices[0]] = 0;
    state.vertexKind[hex.vertices[0]] = Building.Steading;
    state.warband = hex.id;
    expect(rollFeedback(board, state, [{ type: 'roll', total: 6 }], 1)!.produced).not.toContain(
      hex.id,
    );
    state.vertexKind[hex.vertices[0]] = Building.Citadel;
    const feedback = rollFeedback(
      board,
      state,
      [
        { type: 'roll', total: 6 },
        { type: 'goods', player: 0, good: hex.good, amount: 2 },
        { type: 'goods', player: 1, good: hex.good, amount: 1 },
      ],
      2,
    )!;
    expect(feedback.produced).toContain(hex.id);
    expect(feedback.gains[0][hex.good]).toBe(2);
    expect(feedback.gains[1][hex.good]).toBe(1);
    expect(rollFeedback(board, state, [{ type: 'roll', total: 7 }], 3)!.produced).toEqual([]);
    expect(
      rollFeedback(board, state, [{ type: 'paid', player: 0, goods: [1, 1, 0, 0, 0] }], 4),
    ).toBeNull();
  });
  it('keeps separate explicit notices for a plunder, trade offer, Warband and ten Renown', () => {
    const { board, state } = createGame('feedback');
    const before = cloneState(state);
    const after = cloneState(state);
    const hex = board.hexes[0];
    after.vertexOwner[hex.vertices[0]] = 0;
    after.vertexKind[hex.vertices[0]] = Building.Steading;
    const chosen: number[] = [];
    for (const v of board.vertices)
      if (
        !v.shrine &&
        v.id !== hex.vertices[0] &&
        !chosen.some((id) => board.vertices[id].neighbours.includes(v.id))
      ) {
        chosen.push(v.id);
        if (chosen.length === 4) break;
      }
    for (const [i, v] of chosen.entries()) {
      before.vertexOwner[v] = after.vertexOwner[v] = 1;
      before.vertexKind[v] = after.vertexKind[v] = i < 2 ? Building.Citadel : Building.Town;
    }
    before.vertexKind[chosen[0]] = Building.Town;
    expect(renown(board, before, 1)).toBe(9);
    expect(renown(board, after, 1)).toBe(10);
    const notices = transitionNotices(
      board,
      before,
      after,
      [
        { type: 'plunder', player: 1, victim: 0, good: 0 },
        { type: 'tradeProposed', player: 1, to: 0 },
        { type: 'warband', player: 1, hex: hex.id },
      ],
      settings,
      33,
    );
    expect(notices.map((n) => n.kind)).toEqual(['plunder', 'trade', 'warband', 'renown']);
    expect(new Set(notices.map((n) => n.id)).size).toBe(4);
    expect(notices[3].message).toContain('10 Renown');
    expect(transitionNotices(board, after, after, [], settings, 34)).toEqual([]);
  });
  it('groups a whole bot turn and makes its place references inspectable without raw IDs', () => {
    const { board } = createGame('feedback');
    const events = [
      { type: 'roll', player: 1, total: 6 },
      { type: 'goods', player: 0, amount: 1, good: 0 },
      { type: 'track', player: 1, e: 0 },
    ];
    const groups = groupChronicle([
      { turn: 3, group: 'turn-3', owner: 1, events: events.slice(0, 2) },
      { turn: 3, group: 'turn-3', owner: 1, events: events.slice(2) },
      { turn: 4, group: 'turn-4', owner: 2, events: [] },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].events).toHaveLength(3);
    expect(eventPlaces(groups[0].events).edges).toEqual([0]);
    const description = eventLabel(events[2], ['Human', 'Aeneas', 'Hector'], board);
    expect(description).toContain('track between');
    expect(description).not.toMatch(/path \d|site \d|hex \d/);
  });
});
