/** Place descriptions must identify locations in prose, including otherwise identical coastal sites. */
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/engine/index.js';
import { edgeName, hexName, vertexName } from '../src/ui/places.js';

describe('human map descriptions', () => {
  it('names neighbouring terrain rather than engine IDs', () => {
    const { board } = createGame('places');
    expect(hexName(board, 0)).toBe('Pasture 9');
    expect(vertexName(board, 0)).toBe('the corner of Pasture 9, Clay Hills 10 and Forest 2');
    expect(edgeName(board, 0)).toBe('the track between Pasture 9 and Clay Hills 10');
  });

  it('distinguishes repeated terrain tokens and coastal positions', () => {
    const { board } = createGame('places');
    expect(hexName(board, 2)).toBe('western Mines 11');
    expect(hexName(board, 11)).toBe('eastern Mines 11');
    expect(vertexName(board, 2)).toContain('the sea');
    expect(vertexName(board, 2)).not.toBe(vertexName(board, 3));
    expect(edgeName(board, 1)).not.toBe(edgeName(board, 2));
  });

  it('keeps hex, corner and track names unique across varied maps', () => {
    for (let seed = 0; seed < 30; seed++) {
      const { board } = createGame(`places-${seed}`);
      expect(new Set(board.hexes.map((hex) => hexName(board, hex.id))).size).toBe(
        board.hexes.length,
      );
      expect(new Set(board.vertices.map((vertex) => vertexName(board, vertex.id))).size).toBe(
        board.vertices.length,
      );
      expect(new Set(board.edges.map((edge) => edgeName(board, edge.id))).size).toBe(
        board.edges.length,
      );
    }
  });

  it('handles a stale Chronicle location without throwing', () => {
    const { board } = createGame('places');
    expect(hexName(board, -1)).toBe('an unknown hex');
    expect(vertexName(board, 999)).toBe('an unknown corner');
    expect(edgeName(board, 999)).toBe('an unknown track');
  });
});
