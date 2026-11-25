/** Application screens and bot scheduling. All decisions cross the shared reducer boundary. */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Building,
  CARD_COUNT,
  CONFIG,
  GOOD_COUNT,
  isLegal,
  legalActions,
  pieceCount,
  renown,
  stateHash,
  storageLimit,
  handSize,
  type Action,
} from '../engine/index.js';
import { BoardView } from './Board.js';
import { PublicInfo } from './PublicInfo.js';
import { Chronicle, type Highlight } from './Chronicle.js';
import { rollFeedback, type RollFeedback } from './feedback.js';
import { createDriver, TIERS, type Tier } from './driver.js';
import {
  decodeSave,
  encodeSave,
  gameReducer,
  humanTradeOffered,
  newSession,
  SAVE_KEY,
  type Session,
  type Settings,
  type Speed,
} from './game.js';
import {
  actionLabel,
  CARD_HELP,
  CARD_NAMES,
  GOOD_MARKS,
  PALETTE,
  playerColours,
  playerNames,
  scoreBreakdown,
  tradeResponseLabel,
} from './presentation.js';
import rulesText from '../../docs/RULES.md?raw';
import { installTestBridge } from './testBridge.js';
const DELAYS: Record<Speed, number> = { slow: 1350, normal: 700, fast: 180, instant: 0 };
const SPATIAL = ['placeSteading', 'placeTrack', 'freeTrack', 'moveWarband'];
const PHASE_HELP: Record<string, string> = {
  setupSteading: 'Choose a glowing site for your Steading.',
  setupTrack: 'Choose a glowing path beside your new Steading.',
  roll: 'Roll to see what the land provides.',
  discard: 'Lean season. Discard one good at a time until you reach your storage limit.',
  moveWarband: 'Choose another hex for the Warband.',
  plunder: 'Take a good from an eligible rival, or skip.',
  surveyors: 'Choose up to two free Tracks, or finish.',
  tradeResponse: 'Consider the proposed exchange.',
  main: 'Build your house, trade and gather Renown.',
};
/** Read local storage defensively so a damaged or unavailable save never blocks a new game. */
function readSaved(): Session | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? decodeSave(raw) : null;
  } catch {
    return null;
  }
}
/** Difficulty names and descriptions come from the actual AI configuration table. */
function NewGame({
  saved,
  onStart,
  onResume,
}: {
  saved: Session | null;
  onStart: (settings: Settings) => void;
  onResume: () => void;
}) {
  const [name, setName] = useState(saved?.settings.name ?? 'Your house');
  const [colour, setColour] = useState(saved?.settings.colour ?? PALETTE[0]);
  const [seed, setSeed] = useState('');
  const [tiers, setTiers] = useState<[Tier, Tier]>(['Aeneas', 'Hector']);
  return (
    <main className="new-game">
      <div className="intro">
        <span className="eyebrow">HOUSES OF THE COAST</span>
        <h1>Dardania</h1>
        <p>
          Raise a house.
          <br />
          Command the coast.
        </p>
        <div className="intro-seal" aria-hidden="true">
          ✦
        </div>
        <p className="lede">
          An original game of settlements, shifting markets and rival houses. One coast. Three
          ambitions. Twelve Renown.
        </p>
      </div>
      <form
        className="setup-form"
        onSubmit={(e) => {
          e.preventDefault();
          onStart({
            name: name.trim().slice(0, 32) || 'Your house',
            colour,
            tiers,
            seed: seed.trim() || String(crypto.getRandomValues(new Uint32Array(1))[0]),
            speed: 'normal',
          });
        }}
      >
        <h2>Found your house</h2>
        <label>
          Your name
          <input maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <fieldset>
          <legend>Your colour</legend>
          <div className="colour-choices">
            {PALETTE.map((c, i) => (
              <label key={c} className={c === colour ? 'chosen' : ''}>
                <input
                  type="radio"
                  name="colour"
                  value={c}
                  checked={c === colour}
                  onChange={() => setColour(c)}
                />
                <span style={{ color: c }}>◆</span>
                {['Crimson', 'Saffron', 'Indigo'][i]}
              </label>
            ))}
          </div>
        </fieldset>
        {tiers.map((tier, i) => (
          <label key={i}>
            Opponent {i + 1}
            <select
              value={tier}
              onChange={(e) =>
                setTiers(
                  (old) =>
                    old.map((v, j) => (j === i ? (e.target.value as Tier) : v)) as [Tier, Tier],
                )
              }
            >
              {TIERS.map((t) => (
                <option key={t.name}>{t.name}</option>
              ))}
            </select>
            <small>{TIERS.find((t) => t.name === tier)?.description}</small>
          </label>
        ))}

        <label>
          Map seed <span className="muted">(optional)</span>
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="Leave blank for a new coast"
            maxLength={100}
          />
        </label>
        <button className="primary" type="submit">
          Start new game <span>→</span>
        </button>
        {saved && (
          <button type="button" onClick={onResume}>
            Resume saved game · turn {saved.state.turn}
          </button>
        )}
      </form>
    </main>
  );
}
/** Constant build reference remains visible in the player rail at every game phase. */
function Costs() {
  return (
    <section className="cost-card">
      <h3>Build costs</h3>
      {Object.entries(CONFIG.costs).map(([kind, cost]) => (
        <div key={kind}>
          <strong>{kind === 'card' ? 'Stratagem' : kind[0].toUpperCase() + kind.slice(1)}</strong>
          <span>
            {cost
              .map((n, g) => (n ? `${n} ${CONFIG.goods[g]}` : ''))
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      ))}
    </section>
  );
}
/** Public inventory panels follow shuffled turn order, retaining stable player identities. */
function Players({ session, feedback }: { session: Session; feedback: RollFeedback | null }) {
  const { state, board, settings } = session;
  const names = playerNames(settings);
  const colours = playerColours(settings);
  return (
    <aside className="player-rail">
      <div className="players" aria-label="Players in turn order">
        {Array.from(state.turnOrder).map((p, i) => (
          <section
            key={p}
            className={`player-card ${state.active === p ? 'active' : ''}`}
            style={{ '--house': colours[p] } as React.CSSProperties}
          >
            <div className="player-heading">
              <span className="house-marker">{['◆', '●', '■'][p]}</span>
              <h2>
                {names[p]} {p === 0 && <small>YOU</small>}
              </h2>
              <span className="order">{i + 1}</span>
            </div>
            <div className="score" title={scoreBreakdown(board, state, p)} tabIndex={0}>
              <strong>{renown(board, state, p)}</strong>
              <span>/ 12 Renown</span>
              <span className="turn-label">
                {state.active === p ? '● ACTIVE' : state.toAct === p ? 'DECIDING' : ''}
              </span>
              <div className="score-tooltip">{scoreBreakdown(board, state, p)}</div>
            </div>
            <div className="goods">
              {CONFIG.goods.map((good, g) => (
                <div key={good} title={good}>
                  <span aria-hidden="true">{GOOD_MARKS[g]}</span>
                  <strong>
                    {state.hands[p * GOOD_COUNT + g]}
                    {feedback && feedback.gains[p][g] > 0 && (
                      <em key={feedback.at} className="good-gain" data-testid="good-gain">
                        +{feedback.gains[p][g]}
                      </em>
                    )}
                  </strong>
                  <small>{good}</small>
                </div>
              ))}
            </div>
            <div className="player-meta">
              <span>
                Storage {handSize(state, p)}/{storageLimit(state, p)}
              </span>
              <span>Musters {state.musters[p]}</span>
              {state.warlord === p && <b className="warlord">⚑ Warlord +2</b>}
            </div>
            <p className="pieces" aria-label="Pieces left">
              <span title="Tracks left">
                Tr {CONFIG.pieces.track - pieceCount(state, p, 'track')}
              </span>{' '}
              ·{' '}
              <span title="Steadings left">
                S {CONFIG.pieces.steading - pieceCount(state, p, Building.Steading)}
              </span>{' '}
              ·{' '}
              <span title="Towns left">
                T {CONFIG.pieces.town - pieceCount(state, p, Building.Town)}
              </span>{' '}
              ·{' '}
              <span title="Citadels left">
                C {CONFIG.pieces.citadel - pieceCount(state, p, Building.Citadel)}
              </span>{' '}
              left
            </p>
            <p className="inventory">
              {CARD_NAMES.map((c, i) =>
                state.cards[p * CARD_COUNT + i] ? `${c} ×${state.cards[p * CARD_COUNT + i]}` : '',
              )
                .filter(Boolean)
                .join(' · ') || 'No Stratagems'}
            </p>
          </section>
        ))}
      </div>
    </aside>
  );
}
/** Compose a one-to-three unit offer. The engine alone validates availability and overlap. */
function Trade({ session, onAction }: { session: Session; onAction: (a: Action) => void }) {
  const [to, setTo] = useState(1);
  const [give, setGive] = useState([0, 0, 0, 0, 0]);
  const [get, setGet] = useState([0, 0, 0, 0, 0]);
  const proposal: Action = { type: 'proposeTrade', to, give, get };
  const names = playerNames(session.settings);
  return (
    <details>
      <summary>
        Trade with a rival <small>{session.state.proposals}/4 offers</small>
      </summary>
      <label>
        Rival
        <select value={to} onChange={(e) => setTo(Number(e.target.value))}>
          {[1, 2].map((p) => (
            <option key={p} value={p}>
              {names[p]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted">Offer 1–3 goods for 1–3 different goods.</p>
      <div className="trade-grid">
        <span>Good</span>
        <span>You give</span>
        <span>You get</span>
        {CONFIG.goods.map((g, i) => (
          <div className="trade-line" key={g}>
            <span>{g}</span>
            {[give, get].map((vector, side) => (
              <input
                key={side}
                aria-label={`${side ? 'Get' : 'Give'} ${g}`}
                type="number"
                min={0}
                max={3}
                value={vector[i]}
                onChange={(e) => {
                  const n = Math.max(0, Math.min(3, Math.floor(Number(e.target.value) || 0)));
                  (side ? setGet : setGive)((old) => old.map((v, j) => (j === i ? n : v)));
                }}
              />
            ))}
          </div>
        ))}
      </div>
      <button
        disabled={!isLegal(session.board, session.state, proposal)}
        onClick={() => onAction(proposal)}
      >
        Propose exchange
      </button>
    </details>
  );
}
/** Stratagem row contains only dealt public cards; the deck's future order is never inspected. */
function Cards({
  session,
  actions,
  onAction,
}: {
  session: Session;
  actions: Action[];
  onAction: (a: Action) => void;
}) {
  const [choice, setChoice] = useState('');
  const { state } = session;
  const plays = actions.filter((a) => a.type === 'playCard');
  return (
    <>
      <details>
        <summary>Your Stratagems</summary>
        {CARD_NAMES.map(
          (name, c) =>
            state.cards[c] > 0 && (
              <p className="owned-card" key={c} title={CARD_HELP[c]}>
                <b>
                  {name} ×{state.cards[c]}
                </b>
                <small>
                  {CARD_HELP[c]}{' '}
                  {state.freshCards[c]
                    ? `${state.freshCards[c]} newly bought; playable next turn.`
                    : ''}
                </small>
              </p>
            ),
        )}
        {!state.cards.slice(0, CARD_COUNT).some((n) => n > 0) && (
          <p className="muted">Buy cards from the row.</p>
        )}
        {plays.length > 0 && (
          <>
            <select
              aria-label="Choose Stratagem play"
              value={
                plays.some((a) => JSON.stringify(a) === choice) ? choice : JSON.stringify(plays[0])
              }
              onChange={(e) => setChoice(e.target.value)}
            >
              {plays.map((a) => (
                <option key={JSON.stringify(a)} value={JSON.stringify(a)}>
                  {actionLabel(a, [])}
                </option>
              ))}
            </select>
            <button
              data-testid="legal-action"
              onClick={() => onAction(plays.find((a) => JSON.stringify(a) === choice) ?? plays[0])}
            >
              Play chosen Stratagem
            </button>
          </>
        )}
      </details>
    </>
  );
}
/** Elapsed decision time stays live while a worker searches off the main thread. */
function ThinkingTime({ decision }: { decision: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed((performance.now() - started) / 1000), 100);
    return () => clearInterval(timer);
  }, [decision]);
  return <span data-testid="thinking-time">Thinking… {elapsed.toFixed(1)}s</span>;
}
/** Keep the latest rival answer visible even when the trade composer closes after a response. */
function TradeReply({ session }: { session: Session }) {
  const reply = session.log
    .filter((entry) => entry.turn === session.state.turn)
    .flatMap((entry) => entry.events)
    .reverse()
    .find((e) => e.type === 'tradeResponse' && e.player !== 0);
  if (!reply || session.state.active !== 0) return null;
  return (
    <p className="trade-result" role="status" data-testid="trade-result">
      {tradeResponseLabel(reply, playerNames(session.settings), 'your offer')}.
    </p>
  );
}
/** Human controls render legal actions for the current phase, including interrupt decisions. */
function Decisions({
  session,
  actions,
  mode,
  setMode,
  onAction,
  thinking,
}: {
  session: Session;
  actions: Action[];
  mode: string;
  setMode: (m: string) => void;
  onAction: (a: Action) => void;
  thinking: boolean;
}) {
  const { state } = session;
  const names = playerNames(session.settings);
  const human = state.toAct === 0 && state.phase !== 'gameOver';
  const actButton = (a: Action) => (
    <button
      key={JSON.stringify(a)}
      data-testid={a.type === 'endTurn' ? 'end-turn' : a.type === 'roll' ? 'roll' : 'legal-action'}
      className={a.type === 'roll' || a.type === 'endTurn' ? 'primary' : ''}
      onClick={() => onAction(a)}
    >
      {actionLabel(a, names)}
    </button>
  );
  const special = state.phase === 'discard' || state.phase === 'tradeResponse';
  const contents = (
    <>
      <span className="eyebrow">
        {state.phase === 'discard'
          ? 'LEAN SEASON'
          : state.phase === 'tradeResponse'
            ? 'A RIVAL’S OFFER'
            : 'YOUR DECISION'}
      </span>
      <h2>
        {state.phase === 'main'
          ? 'Make your move'
          : state.phase === 'discard'
            ? 'Storage is full'
            : state.phase === 'tradeResponse'
              ? `${names[state.active]} proposes`
              : 'Your coast awaits'}
      </h2>
      <p className="phase-help">{PHASE_HELP[state.phase]}</p>
      <TradeReply session={session} />
      {state.phase === 'discard' && (
        <p>
          Goods {handSize(state, 0)} / capacity {storageLimit(state, 0)}
        </p>
      )}
      {state.phase === 'tradeResponse' && (
        <p>
          You receive{' '}
          {Array.from(state.tradeGive)
            .map((n, g) => (n ? `${n} ${CONFIG.goods[g]}` : ''))
            .filter(Boolean)
            .join(', ')}
          .<br />
          You give{' '}
          {Array.from(state.tradeGet)
            .map((n, g) => (n ? `${n} ${CONFIG.goods[g]}` : ''))
            .filter(Boolean)
            .join(', ')}
          .
        </p>
      )}
      {state.phase === 'main' ? (
        <>
          <div className="build-choices">
            {[
              ['buildTrack', 'Track'],
              ['buildSteading', 'Steading'],
              ['upgrade', 'Upgrade'],
            ].map(([type, label]) => (
              <button
                data-testid={actions.some((a) => a.type === type) ? 'build-choice' : undefined}
                key={type}
                className={mode === type ? 'selected' : ''}
                disabled={!actions.some((a) => a.type === type)}
                onClick={() => setMode(mode === type ? '' : type)}
              >
                {label}
              </button>
            ))}
          </div>
          {mode && (
            <p className="placement-hint">
              Click a glowing {mode === 'buildTrack' ? 'path' : 'site'}.{' '}
              <button className="text-button" onClick={() => setMode('')}>
                Cancel (Esc)
              </button>
            </p>
          )}
          <Trade key={state.turn} session={session} onAction={onAction} />
          <Cards session={session} actions={actions} onAction={onAction} />
          <div className="button-stack">
            {actions.filter((a) => a.type === 'muster' || a.type === 'endTurn').map(actButton)}
          </div>
        </>
      ) : (
        <div className="button-stack">
          {actions.filter((a) => !SPATIAL.includes(a.type)).map(actButton)}
        </div>
      )}
    </>
  );
  return (
    <aside className="decisions" aria-label="Decision panel">
      {human ? (
        special ? (
          <>
            <p>Your decision is needed.</p>
            <div className="modal-backdrop">
              <section
                className="decision-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={state.phase === 'discard' ? 'Discard goods' : 'Trade offer'}
              >
                {contents}
              </section>
            </div>
          </>
        ) : (
          contents
        )
      ) : (
        <>
          <span className="eyebrow">
            {state.phase === 'gameOver' ? 'THE COAST IS SETTLED' : 'RIVAL HOUSE'}
          </span>
          <h2>{state.phase === 'gameOver' ? 'A new age' : names[state.toAct]}</h2>
          <p className="thinking" role="status">
            {state.phase !== 'gameOver' && <span className="thinking-dot" />}{' '}
            {thinking ? (
              <ThinkingTime decision={session.history.length} />
            ) : state.phase === 'gameOver' ? (
              'The game has ended.'
            ) : (
              'Preparing a move…'
            )}
          </p>
          <p className="muted">Each rival action appears on the map and in the chronicle below.</p>
        </>
      )}
    </aside>
  );
}
/** Full rule text is bundled locally and available during setup, play and the final score. */
function Rules({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="rules-dialog" role="dialog" aria-modal="true" aria-label="Dardania rules">
        <header>
          <h2>Rules of the coast</h2>
          <button onClick={onClose} autoFocus>
            Close rules
          </button>
        </header>
        <div className="rules-copy">
          {rulesText.split(/\n\n+/).map((block, i) => {
            if (block.startsWith('## ')) return <h3 key={i}>{block.replace(/^#+ /, '')}</h3>;
            if (block.startsWith('# ')) return <h2 key={i}>{block.slice(2)}</h2>;
            if (block.includes('|')) return <pre key={i}>{block}</pre>;
            return <p key={i}>{block.replace(/\*\*/g, '').replace(/\n/g, ' ')}</p>;
          })}
        </div>
      </section>
    </div>
  );
}
/** Winner screen uses the same public score breakdown as the player panels. */
function Finish({
  session,
  onRematch,
  onNew,
}: {
  session: Session;
  onRematch: () => void;
  onNew: () => void;
}) {
  const names = playerNames(session.settings);
  return (
    <div className="modal-backdrop">
      <section className="finish-dialog" role="dialog" aria-modal="true" aria-label="Game result">
        <span className="eyebrow">THE CHRONICLE IS WRITTEN</span>
        <h1>{names[session.state.winnerId]} prevails</h1>
        <p>
          {session.state.turn} turns played · map {session.settings.seed}
        </p>
        {Array.from(session.state.turnOrder).map((p) => (
          <section key={p}>
            <h3>
              {names[p]} · {renown(session.board, session.state, p)} Renown
            </h3>
            <p>{scoreBreakdown(session.board, session.state, p)}</p>
          </section>
        ))}
        <div className="button-stack">
          <button className="primary" onClick={onRematch}>
            Rematch on this map
          </button>
          <button onClick={onNew}>New game</button>
        </div>
      </section>
    </div>
  );
}
/** Own one session, save each transition, and cancel bot work whenever the position changes. */
export function App() {
  const [saved, setSaved] = useState<Session | null>(readSaved);
  const [session, setSession] = useState<Session | null>(null);
  const [rules, setRules] = useState(false);
  const [mode, setMode] = useState('');
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<RollFeedback | null>(null);
  const [inspect, setInspect] = useState<Highlight | undefined>();
  const driversRef = useRef<ReturnType<typeof createDriver>[]>([]);
  const sessionRef = useRef<Session | null>(session);
  sessionRef.current = session;
  const tierKey = session?.settings.tiers.join(',') ?? '';
  useEffect(() => {
    const drivers = [
      createDriver((tierKey.split(',')[0] || 'Aeneas') as Tier),
      createDriver((tierKey.split(',')[1] || 'Hector') as Tier),
    ];
    driversRef.current = drivers;
    return () => drivers.forEach((driver) => driver.dispose());
  }, [tierKey]);
  const actions = useMemo(
    () => (session ? legalActions(session.board, session.state) : []),
    [session],
  );
  /** Every interactive path, including bot responses, reaches this reducer. */
  function commit(action: Action) {
    setMode('');
    setError('');
    setSession((current) => (current ? gameReducer(current, action) : current));
  }
  useEffect(() => {
    if (!session) return;
    try {
      localStorage.setItem(SAVE_KEY, encodeSave(session));
      setSaved(session);
    } catch {
      setError('Autosave is unavailable. Keep this tab open to preserve your game.');
    }
  }, [session]);
  useEffect(() => {
    if (
      !session ||
      session.state.toAct === 0 ||
      session.state.phase === 'gameOver' ||
      session.notices.length > 0
    ) {
      setThinking(false);
      return;
    }
    const abort = new AbortController();
    const driver = driversRef.current[session.state.toAct - 1];
    let completed = false;
    setThinking(true);
    const delay =
      session.state.phase === 'tradeResponse' && session.state.active === 0
        ? 0
        : DELAYS[session.settings.speed];
    const timer = window.setTimeout(() => {
      driver
        .decide(session.board, session.state, session.state.toAct, abort.signal, {
          humanTradeOffered: humanTradeOffered(session, session.state.toAct),
        })
        .then((action) => {
          completed = true;
          if (!abort.signal.aborted) commit(action);
        })
        .catch((e: Error) => {
          if (e.name !== 'AbortError') {
            setError(`The rival could not decide: ${e.message}`);
            setThinking(false);
          }
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      abort.abort();
      if (!completed) driver.cancel();
    };
  }, [session, tierKey]);
  useEffect(() => {
    const last = session?.log[session.log.length - 1];
    if (!session || !last) {
      setFeedback(null);
      return;
    }
    const next = rollFeedback(session.board, session.state, last.events, session.history.length);
    if (next) setFeedback(next);
  }, [session?.history.length, session?.settings.seed]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 4200);
    return () => clearTimeout(timer);
  }, [feedback]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMode('');
        setRules(false);
        return;
      }
      const target = e.target as HTMLElement;
      if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(target.tagName)) return;
      if (
        e.code === 'Space' &&
        !rules &&
        session?.state.toAct === 0 &&
        actions.length === 1 &&
        ['roll', 'endTurn'].includes(actions[0].type)
      ) {
        e.preventDefault();
        commit(actions[0]);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [session, actions, rules]);
  const start = (settings: Settings) => {
    setSession(newSession(settings));
    setMode('');
    setError('');
    setFeedback(null);
    setInspect(undefined);
  };
  useEffect(
    () =>
      installTestBridge(
        window,
        () => sessionRef.current,
        (restored) => {
          // A loaded fixture is a save restore, so retire work and transient UI from the old position.
          driversRef.current.forEach((driver) => driver.cancel());
          setMode('');
          setRules(false);
          setError('');
          setFeedback(null);
          setInspect(undefined);
          setSession(restored);
        },
      ),
    [],
  );
  const highlighted =
    session?.state.toAct === 0 && !rules
      ? actions.filter((a) => SPATIAL.includes(a.type) || a.type === mode)
      : [];
  const names = session ? playerNames(session.settings) : [];
  return (
    <>
      <header className="topbar">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setSession(null);
            setMode('');
          }}
        >
          Dardania <span>HOUSES OF THE COAST</span>
        </a>
        {session && (
          <div className="header-game-info">
            <div>
              <span className="eyebrow">
                {session.state.turn === 0 ? 'FOUNDING THE HOUSES' : `TURN ${session.state.turn}`}
              </span>
              <h1>
                {session.state.toAct === 0 ? 'Your move' : `${names[session.state.toAct]}’s move`}
              </h1>
            </div>
            <div
              className="roll-token"
              aria-label={`Last roll ${session.state.lastRoll || 'none'}`}
            >
              <small>LAST ROLL</small>
              <strong>{session.state.lastRoll || '—'}</strong>
            </div>
          </div>
        )}
        <nav>
          {session && (
            <>
              <label className="speed">
                Rival pace
                <select
                  aria-label="Rival pace"
                  value={session.settings.speed}
                  onChange={(e) =>
                    setSession((old) =>
                      old
                        ? { ...old, settings: { ...old.settings, speed: e.target.value as Speed } }
                        : null,
                    )
                  }
                >
                  {Object.keys(DELAYS).map((speed) => (
                    <option key={speed}>{speed}</option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => {
                  setSession(null);
                  setMode('');
                }}
              >
                Menu
              </button>
            </>
          )}
          <button onClick={() => setRules(true)}>Rules</button>
        </nav>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {session && session.notices.length > 0 && (
        <section className="notice-strip" role="alert" data-testid="critical-notice">
          <strong>Pay attention to the coast</strong>
          <p>{session.notices[0].message}</p>
          <button
            data-testid="acknowledge-notice"
            onClick={() =>
              setSession((old) => (old ? { ...old, notices: old.notices.slice(1) } : null))
            }
          >
            Understood{session.notices.length > 1 ? ` (${session.notices.length} notices)` : ''}
          </button>
        </section>
      )}
      {session ? (
        <main
          className="game-layout"
          data-testid="game"
          data-phase={session.state.phase}
          data-actor={session.state.toAct}
          data-turn={session.state.turn}
          data-hash={stateHash(session.state)}
        >
          <Players session={session} feedback={feedback} />
          <section className="map-section">
            <div className="board-wrap">
              <BoardView
                board={session.board}
                state={session.state}
                actions={highlighted}
                colours={playerColours(session.settings)}
                onAction={commit}
                highlighted={inspect}
                produced={feedback?.produced ?? []}
                productionKey={feedback?.at}
              />
            </div>
            <div className="map-footer">
              <span>Map {session.settings.seed}</span>
            </div>
            <Chronicle session={session} onHighlight={setInspect} />
          </section>
          <aside className="right-rail">
            <PublicInfo
              session={session}
              actions={session.state.toAct === 0 ? actions : []}
              onAction={commit}
            />
            <Decisions
              session={session}
              actions={session.state.toAct === 0 ? actions : []}
              mode={mode}
              setMode={setMode}
              onAction={commit}
              thinking={thinking}
            />
          </aside>
          <Costs />
          {session.state.phase === 'gameOver' && !rules && (
            <Finish
              session={session}
              onRematch={() => start(session.settings)}
              onNew={() => setSession(null)}
            />
          )}
        </main>
      ) : (
        <NewGame
          saved={saved}
          onStart={start}
          onResume={() => {
            setSession(saved);
            setMode('');
          }}
        />
      )}
      {rules && <Rules onClose={() => setRules(false)} />}
    </>
  );
}
