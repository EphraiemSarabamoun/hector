# Dardania: rules (v1)

*Dardania* is a working title. It is an original hex settlement-and-trade game for three
players (the engine supports two to four). You are the head of a house settling the plain
below a great walled city. You found steadings, grow them into towns and citadels, hold
shrines, trade at the market, and send the warband against your rivals. The first house to
reach **12 Renown** on its own turn wins.

Every number in this document lives in one place in the code, `src/engine/config.ts`, so the
game can be tuned without touching the rules logic. Where this document and that file
disagree, the file is wrong.

## 1. What is public

Everything. Each player's goods, cards and pieces are visible to all. The only things no one
knows are the next dice roll and the order of the Stratagem deck.

## 2. The map

The map is generated fresh for each game from a seed.

- **Land.** 22 land hexes forming one connected landmass, chosen inside a hexagon of radius 3
  (37 cells). Start from the centre cell and repeatedly add a random cell bordering the land,
  weighted by `1 + 2 * (number of land neighbours)`, until there are 22. Reject and retry if
  any land hex has fewer than two land neighbours, or if a non-land cell is fully enclosed by
  land. Every other cell is sea.
- **Terrain.** Four hexes each of Forest, Clay Hills, Fields, Mines and Pasture, and two
  Barrens. Reject and retry if any hex borders more than one hex of its own terrain.

  | Terrain | Good |
  |---|---|
  | Forest | Timber |
  | Clay Hills | Clay |
  | Fields | Grain |
  | Mines | Bronze |
  | Pasture | Horses |
  | Barrens | nothing |

- **Number tokens.** The 20 productive hexes each get one token from this set:
  `2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 10, 11, 11, 12`. Reject and retry if two
  adjacent hexes share a number, if two adjacent hexes both carry a 6 or an 8, or if any
  good's four hexes total fewer than 10 or more than 16 pips. Pips are the number of ways two
  dice make the token: 2 and 12 have one, 3 and 11 two, 4 and 10 three, 5 and 9 four, 6 and 8
  five.
- **Vertices and edges.** A vertex is a corner of at least one land hex. An edge is a side of
  at least one land hex. A vertex is *coastal* if it touches fewer than three land hexes.
- **Shrines.** Three coastal vertices that each touch exactly two land hexes, every pair at
  least five edges apart along the edge graph.
- **Harbours.** Four coastal vertices, none of them a shrine or next to one, every pair at
  least four edges apart.
- **Warband.** Starts on one of the two Barrens, chosen at random.

If a constraint cannot be met after 200 attempts at a stage, restart map generation from the
land step with the next value from the seed's random stream. Generation must be deterministic
for a given seed.

## 3. Pieces and goods

Each player has 15 Tracks, 5 Steadings, 4 Towns and 2 Citadels. A piece limit counts pieces
on the board at once: upgrading a Steading returns it to your supply.

The five goods are Timber, Clay, Grain, Bronze and Horses. The bank never runs out.

| Build | Cost |
|---|---|
| Track | 1 Timber, 1 Clay |
| Steading | 1 Timber, 1 Clay, 1 Grain, 1 Horses |
| Town (upgrade a Steading) | 2 Grain, 2 Bronze, 1 Horses |
| Citadel (upgrade a Town) | 3 Bronze, 2 Clay, 1 Timber |
| Stratagem | 1 Grain, 1 Bronze, 1 Horses |
| Muster | 1 Horses, 1 Bronze |

## 4. Renown

| Source | Renown |
|---|---|
| Steading | 1 |
| Town | 2 |
| Citadel | 3 |
| Each shrine vertex you have a building on | +1 |
| Each Monument you own | +1 |
| Warlord title | 2 |

Renown is always recomputed from the board, never stored and adjusted.

## 5. Setup

1. Turn order is random.
2. Shuffle the Stratagem deck and deal three cards face up in a row. The row keeps its order:
   slot 0 is the oldest card.
3. Market stock starts at 3 for every good.
4. In turn order, each player places one Steading on any legal vertex, then one Track on an
   edge touching that Steading. Then, in reverse turn order, each player does the same again.
   A legal vertex is empty and has no building on any neighbouring vertex.
5. Each Steading, as it is placed, collects one good from every productive hex it touches.
6. The first player in turn order takes the first turn.

## 6. A turn

### 6.1 Roll

The active player rolls two dice. No action may come before the roll.

**Any total but 7: production.** Every hex with that number produces. Each Steading on it
yields 1 of its good to its owner; each Town or Citadel yields 2. The hex the Warband stands
on yields only to Citadels.

**A 7: lean season.** In this order:

1. Nothing is produced.
2. *Spoilage.* Starting with the active player and going in turn order, every player holding
   more goods than their storage limit discards goods of their choice down to the limit. The
   limit is 9, plus 3 for each Granary the player owns.
3. *Market drift.* Each good's market stock moves one step toward 3.
4. *Turnover.* The card in slot 0 of the Stratagem row goes to the bottom of the deck, the
   others slide down, and a new card is dealt from the top into the last slot. If the row has
   fewer than three cards and the deck is not empty, deal until it has three or the deck is
   empty.
5. *The Warband moves.* The active player must move the Warband to a different land hex and
   may plunder (6.3). This move is free and does not count as a muster.

### 6.2 Actions

After the roll, the active player takes any number of these, in any order, then ends the turn.

- **Build a Track** on an empty edge. One end of the edge must either hold one of your
  buildings, or hold no opponent's building and touch another of your Tracks. You cannot
  build through an opponent's building.
- **Build a Steading** on an empty vertex that touches one of your Tracks and has no building
  on any neighbouring vertex.
- **Upgrade** one of your Steadings to a Town, or one of your Towns to a Citadel.
- **Buy at the market** (6.4).
- **Propose a trade** to one opponent (6.5).
- **Buy a Stratagem** (6.6).
- **Play a Stratagem** (6.6). At most one per turn.
- **Muster.** Pay the cost, move the Warband to a different land hex, and you may plunder.
  At most one paid muster per turn. It counts as a muster.

### 6.3 The Warband

While the Warband stands on a hex, that hex yields only to Citadels.

*Plunder.* After moving the Warband, the mover may choose one opponent who has at least one
Steading or Town on that hex and holds at least one good, and takes one good of the mover's
choice from them. A player whose only buildings on the hex are Citadels cannot be chosen. If
nobody can be chosen, nothing is taken.

*Warlord.* The first player to reach 3 musters takes the Warlord title. After that, a player
takes the title by having strictly more musters than its holder. A muster is a paid Muster
action or a played Raid. The free move on a 7 is not one.

### 6.4 The market

To buy 1 unit of a good, pay some number of units of **one** other good.

| Market stock of the good you want | Price |
|---|---|
| 0 | cannot be bought |
| 1 or 2 | 4 |
| 3 or 4 | 3 |
| 5 or 6 | 2 |

If you have a building on a harbour vertex, every price is 1 lower, to a minimum of 2.

After the purchase, the stock of the good you bought drops by 1, and the stock of the good
you paid with rises by 1, to a maximum of 6.

### 6.5 Trading with another player

The active player names one opponent, a set of goods to give (1 to 3 units in total) and a
set to receive (1 to 3 units in total). No good may appear on both sides. Both players must
hold what they would give. The opponent accepts or declines. If they accept, the goods change
hands at once. The active player may make at most 4 proposals per turn, accepted or not.

### 6.6 Stratagems

To buy, pay the cost and take any one card from the face-up row. The cards after it slide
down and a new card is dealt into the last slot. If the deck is empty the row simply shrinks.

The deck has 24 cards.

| Card | Count | Kind | Effect |
|---|---|---|---|
| Caravan | 5 | play | Take any 2 goods from the bank. |
| Surveyors | 4 | play | Build up to 2 Tracks at no cost, under the normal placement rule. |
| Tithe | 3 | play | Name a good. Each opponent gives you up to 2 of it. |
| Raid | 5 | play | Move the Warband to a different land hex; you may plunder. Counts as a muster. |
| Monument | 4 | permanent | Worth 1 Renown from the moment you buy it. |
| Granary | 3 | permanent | Your storage limit is 3 higher. |

A *play* card cannot be played on the turn you buy it, and you may play at most one per turn.
A played card goes to the public discard pile and does not return. A *permanent* card takes
effect when bought and stays in front of you.

### 6.7 Winning

If the active player has 12 or more Renown at any point during their own turn, the game ends
at once and they win. Only the active player can win.

If a game somehow reaches 600 turns, it ends: the highest Renown wins, ties broken by most
goods in hand, then by earliest place in turn order.

## 7. Design notes

These explain why the rules are what they are. They are not rules.

- Open information is deliberate. It removes hidden-hand bookkeeping for the human, and it
  lets the AI search the real position instead of guessing at it.
- The market replaces a fixed bank rate. Buying a good makes it dearer for the next buyer and
  the good you paid with cheaper, and every lean season pulls prices back toward the middle.
- The Warband can be moved on purpose, at a price, not only when the dice say so. A Citadel
  is the answer to it.
- Shrines and harbours sit on the coast, where production is thin, so the best land for goods
  is not the best land for Renown and prices.
