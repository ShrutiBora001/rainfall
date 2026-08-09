# Rainfall — 3 minute demo script

**Before you start.** Portal running on Monad with live Rain. Two tabs open:
portal `/` and storefront `/shop`. Click **Reset — new agent** so you open at
580 · Fair · $500 · 100% collateral. Confirm the header reads
`Monad testnet · 10143` and `rails: rain`.

---

## 0:00 – 0:30 · The pitch

> Every agentic payment stack shipping today is prepaid and spend-capped.
> Rain's Agent Control Layer bounds a card by merchant, category and amount.
> x402 settles from a funded wallet. AP2 binds a mandate to an authorization.
>
> All of them assume the money already exists in a pot somebody pre-funded.
>
> So an agent can spend. It cannot **owe**. Nobody underwrites an agent, and an
> agent that has repaid a hundred obligations carries none of that standing to
> the next merchant.
>
> Rainfall is the missing piece: credit for agents. It buys on a Rain scoped
> card, the obligation lives on Monad, and repayment history releases the
> collateral behind it.

---

## 0:30 – 1:30 · Implementation

> Six contracts on Monad testnet — registry, credit score, underwriter, the
> obligation as a transferable NFT, a liquidity pool.
>
> **Why Monad specifically.** A credit decision has to finish inside the card
> authorization window. At 0.3 second blocks and 0.6 second finality, we read
> the underwriter *and* write the obligation while the terminal still holds the
> line. At twelve seconds you move underwriting off-chain, and the ledger stops
> being a control and becomes a receipt.
>
> **Why Rain.** Every purchase issues a scoped card through their scoped-card
> endpoint — amount, expiry, and a category allowlist, enforced by Rain, not by
> us. We tested it: a card scoped to electronics returns
> `scoped_card_mcc_not_allowed` at a bike shop, and it can only be used once.
> The card that buys a phone is physically incapable of buying a bike.
>
> Funding the collateral contract raised Rain's own credit limit by the
> deposited amount — Rain already models collateral-backed credit. We add the
> layer above it: credit against *history*.
>
> Two agents and a keeper. A buyer agent on Claude that gets a goal, not a
> product. A merchandiser that stocks the shop on request. And a keeper that
> collects installments and enforces defaults with nobody watching.

---

## 1:30 – 3:00 · Portal walkthrough

**1:30 — the two numbers.** *Point at the top row.*

> Rain is funded to nine thousand dollars. This agent may borrow five hundred.
> Not because the money is short — because standing is earned per agent, and it
> lives on Monad where it stays portable.

**1:45 — run the agent.** *Click **Run agent**. Talk while it works, ~20s.*

> It isn't told what to buy. It reads the catalog, checks its own credit, picks
> a term, and decides. Two cents a run.

*When it lands:*

> There's the tool sequence, and there's the obligation — open on Monad, card
> issued and authorized on Rain, merchant paid in full already.

**2:05 — the schedule.** *Click the obligation.*

> Principal and interest per installment, due dates, and every row can be paid
> on its own, paid ahead, or settled early.

**2:20 — start the keeper.** *Click **Start keeper**.*

> Now nobody is clicking anything. It collects on schedule. Watch collateral
> fall from 100% to 50%, the limit rise, and the Rain card's spend limit move
> with it — on Rain's infrastructure.

**2:40 — the delta.** *Switch to `/shop`, point at the e-bike.*

> That e-bike was declined a minute ago — over the limit. Same agent, same code,
> different standing.

**2:50 — consequence.** *Back to portal. **Autopay: off**.*

> Miss one and the keeper marks it delinquent, claims the collateral, and locks
> the Rain card. And if the agent had climbed to zero collateral there is
> nothing to seize — the pool eats the loss. That's the honest economics, and we
> print it rather than hide it.

**3:00 — close.**

> Rain moved the money. Monad remembered the promise.

---

## If something breaks

- Agent shows `SCRIPTED` — it fell back; the reason is in the response. Say so
  and keep going; the decisions are the same, only the reasoning is canned.
- A run hangs — the button carries a timer and a 3-minute timeout. Talk over it.
- Anything odd after a restart — hard-reload the page; a stale tab runs the old
  script.
- Total reset — **Reset — new agent** is instant and costs ~0.03 MON.
