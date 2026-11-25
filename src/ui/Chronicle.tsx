/** Group engine events into human-readable turns, with place-aware board inspection. */
import { useState } from 'react';
import type { GameEvent } from '../engine/index.js';
import type { Session, LogEntry } from './game.js';
import { eventLabel, playerNames } from './presentation.js';
export interface Highlight {
  hexes?: number[];
  vertices?: number[];
  edges?: number[];
}
export interface TurnEntry {
  key: string;
  turn: number;
  owner: number | undefined;
  events: GameEvent[];
}
/** Backward-compatible grouping for earlier local saves; new records carry explicit turn keys. */
export function groupChronicle(log: LogEntry[]): TurnEntry[] {
  const groups: TurnEntry[] = [];
  for (const entry of log) {
    const key = entry.group ?? `turn-${entry.turn}`;
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, turn: entry.turn, owner: entry.owner, events: [] };
      groups.push(group);
    }
    group.events.push(...entry.events);
  }
  return groups;
}
/** Extract only public map references, without relying on a particular event formatter. */
export function eventPlaces(events: GameEvent[]): Highlight {
  const collect = (key: string) => [
    ...new Set(events.filter((e) => typeof e[key] === 'number').map((e) => Number(e[key]))),
  ];
  return { hexes: collect('hex'), vertices: collect('v'), edges: collect('e') };
}
/** Last two turns are compact by default; expansion opens the full scrollable local chronicle. */
export function Chronicle({
  session,
  onHighlight,
}: {
  session: Session;
  onHighlight: (where: Highlight | undefined) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const names = playerNames(session.settings);
  const groups = groupChronicle(session.log);
  const shown = expanded ? groups : groups.slice(-2);
  return (
    <section className={`chronicle ${expanded ? 'expanded' : ''}`} aria-label="Chronicle">
      <header>
        <h2>Chronicle</h2>
        <button aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Collapse' : 'Expand'} · {groups.length} entries
        </button>
      </header>
      <div className="log" role="log" aria-label="Event chronicle">
        {!shown.length && <p>Three houses arrive on the coast. Choose your first site.</p>}
        {shown.map((group) => {
          const events = group.events.filter((e) => e.type !== 'turn');
          return (
            <p
              key={group.key}
              className="chronicle-entry"
              data-testid="chronicle-entry"
              tabIndex={0}
              onMouseEnter={() => onHighlight(eventPlaces(events))}
              onMouseLeave={() => onHighlight(undefined)}
              onFocus={() => onHighlight(eventPlaces(events))}
              onBlur={() => onHighlight(undefined)}
            >
              <b>
                {group.turn === 0 ? 'Founding' : `Turn ${group.turn}`}
                {group.owner !== undefined ? ` · ${names[group.owner]}` : ''}.{' '}
              </b>
              {events.map((e, i) => (
                <span
                  key={i}
                  className="chronicle-event"
                  onMouseEnter={() => onHighlight(eventPlaces([e]))}
                  onMouseLeave={() => onHighlight(eventPlaces(events))}
                >
                  {eventLabel(e, names, session.board)}
                  {i < events.length - 1 ? '; ' : '.'}
                </span>
              ))}
            </p>
          );
        })}
      </div>
    </section>
  );
}
