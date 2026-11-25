/** The browser test flag exposes snapshots/save restoration only, never a second action path. */
import { describe, expect, it } from 'vitest';
import { encodeSave, newSession, type Session } from '../src/ui/game.js';
import { installTestBridge, type TestBridge } from '../src/ui/testBridge.js';

/** A fake browser host keeps the bridge's URL gate testable without a DOM dependency. */
function host(search: string): { location: { search: string }; __DARDANIA_TEST__?: TestBridge } {
  return { location: { search } };
}
/** Use a real seeded session so fixture restoration exercises the normal save decoder. */
function session(): Session {
  return newSession({
    name: 'Test house',
    colour: '#b84448',
    seed: 'test-bridge',
    tiers: ['Aeneas', 'Hector'],
    speed: 'instant',
  });
}

describe('explicit browser test bridge', () => {
  it.each(['', '?test=0', '?testing=1', '?test=true'])(
    'installs nothing for normal URL %s',
    (query) => {
      const target = host(query);
      installTestBridge(
        target,
        () => null,
        () => {
          throw new Error('must not restore');
        },
      );
      expect(target.__DARDANIA_TEST__).toBeUndefined();
    },
  );
  it('returns detached public test snapshots and removes itself on cleanup', () => {
    const current = session();
    current.history.push({ type: 'placeSteading', v: 0 });
    const target = host('?test=1');
    const cleanup = installTestBridge(
      target,
      () => current,
      () => {},
    );
    expect(Object.keys(target.__DARDANIA_TEST__!).sort()).toEqual(['load', 'snapshot']);
    const snapshot = target.__DARDANIA_TEST__!.snapshot()!;
    snapshot.settings.tiers[0] = 'Paris';
    (snapshot.lastAction as { v: number }).v = 999;
    expect(current.settings.tiers[0]).toBe('Aeneas');
    expect(current.history[0]).toEqual({ type: 'placeSteading', v: 0 });
    cleanup();
    expect(target.__DARDANIA_TEST__).toBeUndefined();
  });
  it('restores only decoded saves and leaves the callback untouched on a corrupt load', () => {
    const target = host('?test=1');
    const restored: Session[] = [];
    installTestBridge(
      target,
      () => null,
      (value) => restored.push(value),
    );
    expect(target.__DARDANIA_TEST__!.snapshot()).toBeNull();
    expect(() => target.__DARDANIA_TEST__!.load('{bad')).toThrow();
    expect(restored).toEqual([]);
    target.__DARDANIA_TEST__!.load(encodeSave(session()));
    expect(restored).toHaveLength(1);
    expect(restored[0].state.hands).toBeInstanceOf(Uint16Array);
  });
});
