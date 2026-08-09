# Rainfall — pitch

*EMI rails for autonomous agents. Spend now, settle as it falls.*

---

## The four-minute script

Two windows open: the storefront (`/shop`) and the agent portal (`/`).

### 1. The ceiling (30s)

> Every agentic payment stack shipping today is prepaid and spend-capped. Rain's
> Agent Control Layer bounds a card by merchant, MCC, amount, expiry. x402
> settles per-request from a funded wallet. AP2 binds a mandate to an
> authorization. All of them assume the money already exists in a pot somebody
> pre-funded.
>
> So an agent can spend. It cannot **owe**. There is no credit primitive for
> agents — nobody underwrites one, and an agent that has repaid a hundred
> obligations flawlessly carries none of that standing to the next merchant.

### 2. The baseline (45s) — *shop → checkout → buy the phone*

Storefront, Nimbus 9a at $499, **Buy with installments**. Checkout shows the
live credit decision and four plan options. Take 4 × $134.73. The agent pays.

> Approved — but 100% collateral. Its owner has to lock the full amount.
> **This step is what agentic commerce can already do today.** Economically
> this is a debit card wearing a credit card's clothes.

Point at the merchant ledger: **Voltmart received $499.00 instantly.** Point at
the order: **buyer owes $538.92 over four.** That split is the whole product.

### 3. Earning it (60s) — *keeper on, watch the ladder*

Start the keeper. Installments pay themselves on schedule.

> Nobody is clicking anything now. The obligation services itself.

Watch collateral fall **100% → 50% → 0%**, limit rise **$500 → $750 → $1,500**,
and — this is the part that is real on Rain — **the card's spend limit rise with
it**, on Rain's own infrastructure.

> The agent's good behavior just widened what its card is allowed to authorize.

### 4. The delta (45s) — *try the e-bike, before and after*

Earlier the $1,200 e-bike checkout read *Declined — exceeds credit limit*, with
the line: *choosing a longer plan will not change this.* Now it clears.

> Same agent. Same code. Same item. Different standing. Credit was earned,
> live, on stage.

### 5. Consequence (45s) — *autopay off, let it lapse*

> Late, still in grace — servicing sees it, enforcement doesn't.

Then past grace. The keeper enforces on its own: collateral claimed, score
slashed, **the Rain card locked** within a second of the Monad event.

> And when the agent had climbed to zero collateral, there's nothing to seize —
> the pool eats the loss. That's the honest economics of uncollateralized
> lending, and we print it rather than hide it.

### 6. Close (30s)

> Rain moved the money. Monad remembered the promise.
>
> An onchain credit check has to finish inside the card authorization window.
> Monad is 0.3s blocks, 0.6s finality — it fits. At twelve seconds it doesn't — you move underwriting
> off-chain and the ledger stops being a control and becomes a receipt. Monad
> isn't where we parked the data. It's the reason the check can be onchain.

---

## Questions you should want

**"Couldn't an agent pay everything off instantly and jump the ladder?"**
It could — we found that and closed it. Repayments have a **seasoning window**:
four repayments in one block are four repayments, but one day's worth of
standing. Live: an instant full payoff books `onTime=4, seasoned=1`, and the
agent stays at 100% collateral. Creditworthiness measures reliability *over
time*, so time is part of the measurement. Test: `test_PayoffCannotBuyTheLadder`.

**"Can't I just pick a longer plan to afford something?"** No, and that's the
distinction the product is built on. The buyer picks the *term*; the underwriter
decides whether credit is extended *at all*. Test:
`test_PlanChoiceDoesNotBypassUnderwriting`.

**"What stops a defaulting agent from rotating keys?"** Nothing yet, and it's
the sharpest open question. Credit attaches to the (agent, principal) pair in
`AgentRegistry`, so rotation loses the standing — but a principal can mint a
fresh agent. The real answer is staking or KYC at the principal layer; Rain's
approved user record is the hook.

**"How do users log in?"** Not a password. Three layers: SIWE proves the
principal owns an address, Rain's KYC'd user record establishes who is legally
liable, `AgentRegistry` delegates to a session key. We built the bottom two;
SIWE is ~30 lines and not the interesting part.

**"Why not just a spend cap?"** A cap can't express "this agent has been good
for six months." Caps are a ceiling on *trust you already have*. Credit is the
mechanism for *acquiring* it.

---

## Ledger — what is real, and what is not

Read this before you demo. Every "built" row was run and observed; every
"not built" row is something a judge could catch you on.

### Built and verified

| Piece | How it was verified |
|---|---|
| **Deployed on Monad testnet, chain 10143** | all six contracts live; addresses in `deployments/monad.json`; portal header reads `Monad testnet` |
| **The agent runs live on `claude-opus-5`** | real tool loop, ~$0.02/run with prompt caching; declines reasoned about, not scripted |
| 6 Solidity contracts, zero external deps | `forge test` — **18/18 passing** |
| Ladder 100→50→0%, limits $500/$750/$1,500 | tests + live on the portal |
| **Seasoning gate** (anti-gaming) | live: instant payoff → `onTime=4, seasoned=1`, tier unchanged |
| **Checkout plan selection**, 2–12 installments | live: 6-installment plan honoured, schedule renders 6 rows at $89.82 |
| Plan choice can't bypass underwriting | `test_PlanChoiceDoesNotBypassUnderwriting` |
| Amortization schedule (principal/interest per row) | `$499.00 + $39.92 @ 8% = $538.92`, 4 × `$124.75 + $9.98` |
| Early payoff | 1 payment + payoff → all rows cleared, outstanding $0.00 |
| Late vs delinquent (grace window) | sampled: on-time t+3–19 → late t+23–27 → past grace t+31 |
| Default path | collateral claimed, score slashed, limit → $0, card locked |
| Keeper, unattended | paid 1/4 on its own; with autopay off, enforced a default and claimed **$404.19** with no human input |
| Pool: merchant paid at t0, LPs earn spread | `test_PoolEarnsTheSpread`; storefront shows $499.00 received |
| Obligations as transferable ERC-721 | minted to the agent on open |
| Storefront + checkout + agent portal | run end to end repeatedly |
| Deploy script writes its own address book | `deployments/local.json` regenerated per deploy |

### Live against the real Rain API — the full card lifecycle

| Fact | Evidence |
|---|---|
| Sandbox base is `api-dev.rain.xyz` (**not** `api.rain.xyz`) | key rejected on prod, accepted on dev |
| Auth header is `api-key`, not `Authorization: Bearer` | the 401 body says so |
| **Card creation works** — `POST /v1/issuing/users/{userId}/cards` | real cards created; `POST /v1/issuing/cards` is **404** — creation is nested under the user |
| Body: `{type:"virtual", limit:{amount, frequency}}` | `frequency`: `perAuthorization` \| `allTime` |
| **Freeze / revoke work** — `PATCH /v1/issuing/cards/{id}` | `status`: `active` \| `locked` \| `canceled` |
| **Spend limit is patchable** — this is where the ladder executes on Rain | raised a live card 499 → 1500 and confirmed by GET |
| PATCH echoes the *pre-update* body | re-read with GET; cost us an hour |
| `/v1/issuing/users` — KYC'd record | `Team57 Approved`, `applicationStatus: "approved"` |
| `/v1/issuing/balances` | `creditLimit: 1000000` — **$10,000 sandbox headroom** |
| **Collateral funding works** — `POST /v1/simulate/collateral/fund` | funding $2,500 moved `creditLimit` 1000000 → 1250000: **Rain enforces the collateral/credit relationship itself** |
| **Real authorizations** — `POST /v1/simulate/transactions/authorize` | posts a pending spend against the card; settle moves it to `postedCharges` |
| **Rain declines independently of our underwriter** | over-limit auth → `account_credit_limit_exceeded` — two gates, as a real card program has |
| `settle`'s `amount` is documented optional; it is required | 400 without it |
| Collateral *read/claim* still unauthorized | `/v1/contracts/{id}` → **403, not 404** |

### NOT built — say these plainly if asked

| Gap | Consequence for the demo |
|---|---|
| **Collateral read/claim is mirrored, not executed.** | Funding works; `/v1/contracts/{id}` and `/v1/issuing/contracts` are still 403 for reads and claims. The authoritative ratio lives on Monad and the activity log says so. |
| No login / single hardcoded agent | Contracts are multi-agent; the service pins one address. |
| No rehearsal, no fallback video | Zero run-throughs as of writing. |
| Flat interest, not reducing-balance | Stated in the checkout UI. |
| Cadence 20s, grace 10s, seasoning 20s | Compressed for demo. Production is months/days. |
| `MockUSDC` is a test token | Not a real stablecoin. |
| ~7 stray test cards in the Rain sandbox | Created while reverse-engineering the API. Harmless, visible in `GET /v1/issuing/cards`. |

### The honest framing for the mirrored half

Don't describe mirrored collateral as live. This version is stronger anyway:

> *"Rain's collateral routes return 403 for our hackathon key, so that half is
> mirrored on Monad. What does execute on Rain is the card itself — we issue it,
> we lock it on default, and the ladder moves its spend limit. You can GET it
> from their API right now."*

---

## What is left

1. **Rehearse.** Everything is live and there have been zero run-throughs. This
   is now the biggest risk to the demo, by a distance.
2. **Record a fallback video** in case the venue network fails mid-pitch.
3. *(Optional)* Real testnet USDC via `faucet.circle.com` in place of
   `MockUSDC` — a credibility line, but it means a contract change and a
   redeploy. Do not attempt this before a clean rehearsal.

*(The Rain ask is now minor: collateral read/claim scope for team57 would close
the last mirrored piece. Cards, authorizations, settlement, freezing, spend
limits and collateral funding all work.)*
