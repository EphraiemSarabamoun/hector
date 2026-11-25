/** The planning reference stays visible through every phase; only engine-approved purchases enable. */
import { useState } from 'react';
import { CONFIG, marketPrice, type Action } from '../engine/index.js';
import type { Session } from './game.js';
import { CARD_HELP, CARD_NAMES } from './presentation.js';
/** Show the public market and dealt cards independently of whose decision is pending. */
export function PublicInfo({
  session,
  actions,
  onAction,
}: {
  session: Session;
  actions: Action[];
  onAction: (a: Action) => void;
}) {
  const [wanted, setWanted] = useState<number | null>(null);
  const { state, board } = session;
  const buys = actions.filter((a) => a.type === 'marketBuy' && a.get === wanted);
  const cardCost = CONFIG.costs.card
    .map((n, g) => (n ? `${n} ${CONFIG.goods[g]}` : ''))
    .filter(Boolean)
    .join(' · ');
  return (
    <section className="public-info" aria-label="Public market and Stratagems">
      <section className="public-market" data-testid="public-market">
        <header>
          <h2>Market</h2>
          <span>Stock · your price</span>
        </header>
        <div className="market-goods">
          {CONFIG.goods.map((g, i) => (
            <button
              key={g}
              className={wanted === i ? 'selected' : ''}
              disabled={!actions.some((a) => a.type === 'marketBuy' && a.get === i)}
              onClick={() => setWanted(wanted === i ? null : i)}
              aria-label={`Buy ${g}. Stock ${state.market[i]}, your price ${marketPrice(board, state, 0, i) || 'unavailable'}`}
            >
              <span>{g}</span>
              <strong>{state.market[i]}</strong>
              <span>
                {marketPrice(board, state, 0, i)
                  ? `${marketPrice(board, state, 0, i)} : 1`
                  : 'Empty'}
              </span>
            </button>
          ))}
        </div>
        {wanted !== null && buys.length > 0 && (
          <div className="market-payment">
            <span>Buy {CONFIG.goods[wanted]}, pay:</span>
            {buys.map(
              (a) =>
                a.type === 'marketBuy' && (
                  <button
                    data-testid="legal-action"
                    key={a.pay}
                    onClick={() => {
                      onAction(a);
                      setWanted(null);
                    }}
                  >
                    {marketPrice(board, state, 0, wanted)} {CONFIG.goods[a.pay]}
                  </button>
                ),
            )}
            <button onClick={() => setWanted(null)}>Cancel</button>
          </div>
        )}
      </section>
      <section className="public-stratagems" data-testid="public-stratagems">
        <header>
          <h2>Stratagems</h2>
          <span>{cardCost} each</span>
        </header>
        {Array.from(state.row.slice(0, state.rowCount)).map((card, slot) => {
          const buy = actions.find((a) => a.type === 'buyCard' && a.slot === slot);
          return (
            <article className="public-card" key={`${slot}-${card}`}>
              <div>
                <h3>{CARD_NAMES[card]}</h3>
                <p>{CARD_HELP[card]}</p>
                <span className="card-cost">Cost: {cardCost}</span>
              </div>
              <button
                data-testid={buy ? 'legal-action' : undefined}
                disabled={!buy}
                onClick={() => buy && onAction(buy)}
              >
                Buy
              </button>
            </article>
          );
        })}
        {!state.rowCount && <p>The public row is empty.</p>}
      </section>
    </section>
  );
}
