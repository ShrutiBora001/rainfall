# Rainfall — track submissions

*EMI rails for autonomous agents. Spend now, settle as it falls.*

Repo: https://github.com/ShrutiBora001/rainfall

---

## Best use of Rain

Rainfall uses Rain's scoped card as the settlement instrument for agent credit.
Every purchase issues a fresh card through `POST /v1/issuing/users/{userId}/cards/scoped`,
binding an amount, an expiry, and an MCC allowlist to that one transaction. The
endpoint requires an encrypted `sessionid` — a 32-character hex secret, base64'd,
RSA-OAEP sealed under Rain's published key, base64'd again — which we implement
directly (the OAEP hash is SHA-1; SHA-256 fails).

We rely on Rain to enforce it rather than checking after the fact, and verified
that it does: a card scoped to MCC 5732 authorizes an electronics purchase and
returns `scoped_card_mcc_not_allowed` for a bicycle shop, and a second
authorization on the same card is rejected. A card issued to buy a phone is
physically incapable of buying a bike, once.

We drive the full lifecycle live: issue, authorize, settle, lock on default. We
fund the collateral contract and observed Rain raise the account's own credit
limit by the deposited amount — Rain already models collateral-backed credit, and
Rainfall extends it with reputation. As the agent's standing rises on Monad, we
patch the card's spend limit to match.

Collateral read and claim return 403 for our key; that half is mirrored on Monad
and the UI says so.

---

## Best implementation of Monad for an Agentic Commerce use-case using Rain

Six Solidity contracts run on Monad testnet (chain 10143): an agent registry, a
credit score, an underwriter, the installment agreement as a transferable
ERC-721, a liquidity pool, and a test stablecoin. No external dependencies.

Monad is load-bearing, not a place to park data. A credit decision has to
complete inside the card authorization window. At 0.3s blocks and 0.6s finality,
`Underwriter.assess` can be read *and* the obligation written while the terminal
still holds the line. At twelve-second blocks you move underwriting off-chain and
the ledger stops being a control and becomes a receipt.

What lives on-chain is the part that must be portable: repayment history as
public state any contract can read, so an agent's standing follows it to the next
merchant instead of dying inside one provider's database. The ladder releases
collateral at 3 and 8 seasoned repayments — seasoned, because repayments inside
one window clear debt without buying standing, closing the obvious exploit where
an agent with cash instantly settles a plan and climbs.

Practical work matters too: reads are batched through Multicall3 and cached,
because the public RPC caps at 15 requests/sec and a naive dashboard rate-limits
itself. 20/20 tests, including the default path.

---

## General Track — agents that move money

Two agents, and the money is real.

A buyer agent (`claude-opus-5`, five tools) is given a goal in plain English, not
a product. It reads the catalog, checks its own credit, chooses an installment
term, and buys — or explains why it cannot. Asked for a $1,200 e-bike against a
$500 limit it called `check_credit` twice and `list_obligations`, then worked out
unprompted that it needed either repayment history to raise the limit or more
collateral from its owner, and declined to retry. That is an agent reasoning
about standing rather than balance. Runs cost ~$0.02 with prompt caching.

A merchandiser agent stocks the shelf when a shopper asks for something not
carried, choosing from real MCC codes because a hallucinated category produces a
card that declines at the terminal.

A keeper closes the loop with no human in it: it collects installments on
schedule and, past the grace window, marks the obligation delinquent, claims
collateral, and locks the Rain card. In testing it enforced a default and claimed
$404.19 unattended.

Money genuinely moves: the merchant is paid in full at authorization from a
liquidity pool, the buyer repays over time, and LPs earn the spread.

---

## Submission details

**What it is.** Every agentic payment stack shipping today is prepaid and
spend-capped. Rain's Agent Control Layer bounds a card by merchant, MCC and
amount; x402 settles from a funded wallet; AP2 binds a mandate to an
authorization. All of them assume the money already exists. An agent can spend;
it cannot owe, nobody underwrites it, and an agent that has repaid a hundred
obligations carries none of that standing to the next merchant. Rainfall builds
the missing primitive: an agent buys on a Rain scoped card, the obligation is
minted on Monad, and repayment history progressively releases the collateral
behind it. Miss one installment and the collateral is claimed and the card is
locked.

**What we built.** Six Solidity contracts on Monad testnet (chain 10143) — agent
registry, credit score, underwriter, installment agreement as a transferable
ERC-721, liquidity pool, test stablecoin — with no external dependencies. A
`CardRails` interface with a live Rain implementation and an offline mock. A
buyer agent (`claude-opus-5`, five tools) that is given a goal rather than a
product. A merchandiser agent that stocks the storefront on request. A keeper
that services obligations and enforces defaults unattended. A storefront,
checkout with plan selection, and an operator portal showing the lifecycle end
to end.

**Process.** Rain's documentation at `docs.rain.xyz` is access-code gated, so we
reverse-engineered the API from its own error bodies: a 401 named the required
`api-key` header, a 404 revealed that card creation is nested under the user
rather than at `/v1/issuing/cards`, and a `PATCH` that echoes its pre-update body
cost an hour before we re-read with `GET`. Monad's builder one-pager later
pointed at the real sandbox docs, which unlocked the scoped-card endpoint and its
encrypted `sessionid` (RSA-OAEP under Rain's published key — SHA-1, not SHA-256).
On the Monad side, the public RPC caps at 15 requests/sec and viem's multicall
batching is silently inert unless the chain object declares where Multicall3
lives; finding that is what made the dashboard stable.

**Key achievements.** Rain enforces our scoping, not us: a card scoped to MCC
5732 returns `scoped_card_mcc_not_allowed` for a bicycle shop and rejects a
second authorization. Funding the collateral contract raised Rain's own credit
limit by the deposited amount. The agent reasons rather than follows a script —
asked for a $1,200 e-bike against a $500 limit it checked credit twice, then
worked out unprompted that it needed either repayment history or more collateral,
and declined to retry. The keeper enforced a default and claimed $404.19 with no
human involved. Agent runs cost ~$0.02 with prompt caching. 20/20 contract tests.

We also found and closed our own exploit: paying a plan off instantly booked four
on-time repayments, so we gated the ladder on elapsed time. Standing is earned,
not bought.

**Known limits.** Rain's collateral read and claim routes return 403 for our
hackathon key, so that half is mirrored on Monad and the UI says so. In the
sandbox the scoped amount behaves as a buffered guide rather than a hard ceiling.
Interest is flat, not reducing-balance. Cadences are compressed for demo.
