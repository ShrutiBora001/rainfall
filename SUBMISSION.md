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
