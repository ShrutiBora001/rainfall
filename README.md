# Rainfall

**EMI rails for autonomous agents.** *Spend now, settle as it falls.*

Built at the Raingentic Commerce Hackathon NYC (Rain × Monad Foundation).

---

## The gap

Every agentic payment stack shipping today is **prepaid and spend-capped**. Rain's Agent Control Layer bounds a scoped virtual card by merchant, MCC, amount, frequency, and expiry. x402 settles per-request from a funded wallet. AP2 binds a mandate to an authorization. All of them assume the money already exists in a pot someone pre-funded.

There is no **credit** primitive for agents. An agent cannot transact against future income, nobody underwrites an agent, and an agent that has repaid a hundred obligations flawlessly carries none of that standing to the next merchant.

Rainfall builds it. An agent buys a phone or a bike on a Rain-issued scoped card, the repayment obligation is minted on Monad, and repayment history progressively **releases the collateral backing its card**. Miss one installment and the collateral is claimed and the card freezes.

## How it composes with Rain

Rain's card is already an onchain credit card backed by a per-customer, self-custodied collateral contract — *spend against collateral you posted*. Rainfall adds the layer above: *spend against history you earned*.

The collateral contract stays Rain's. Rainfall never takes custody; it computes the required ratio on Monad and instructs Rain.

> Rain answers "is this agent covered?" Rainfall answers "does this agent still need to be?"

## The ladder

| Standing | Collateral required | Credit limit |
|---|---|---|
| Cold agent | 100% | $500 |
| 3+ on-time installments | 50% | $750 |
| 8+ on-time installments | **0%** | $1,500 |
| Any default | 100%, credit revoked | $0 |

A default is terminal, not merely expensive — eight clean installments do not survive one miss. Credit that survives non-payment is not credit.

## Why Monad

The credit decision has to land inside the card authorization window. At ~500ms blocks and ~1s finality, `Underwriter.assess` can be read *and* the agreement written while the terminal is still holding the line.

At 12-second blocks it cannot, and underwriting must move off-chain — at which point the ledger degrades from a control into a receipt. Monad is not where the data is parked; it is the reason the credit check can be onchain at all.

## Architecture

```
 Agent  ──wants: Pixel 9a, $499
   │
   ▼
 Underwriter.assess()  ──►  Monad   (score, limit, required collateral)
   │  approved: 4 × $134.73, 8% APR, 0% collateral
   ▼
 Rain: issueScopedCard(merchant, amount, MCC, +10min expiry)
   │
   ▼
 authorization ──► InstallmentAgreement.open()   [obligation NFT]
   │               LiquidityPool pays merchant in full at t0
   ▼
 Keeper ──► pay()  ──► CreditScore ──► collateral released via Rain
        └─► missed ──► markDelinquent() ──► collateral claimed
                                        └─► Rain freezeCard()
```

### Contracts (`contracts/src`)

| Contract | Role |
|---|---|
| `AgentRegistry` | Agent session key → liable principal |
| `CreditScore` | The ladder. Portable, publicly readable agent reputation |
| `Underwriter` | The credit decision, in one cheap view call |
| `InstallmentAgreement` | The obligation, as a transferable ERC-721 |
| `LiquidityPool` | Pays merchants at t0, collects installments, LPs earn the spread |
| `MockUSDC` | Test stablecoin (6 decimals) |

Zero external dependencies — minimal ERC-20 and ERC-721 are implemented inline.

### Off-chain (`src`)

- `rails/` — `CardRails` interface with `RainRails` (live) and `MockRails` (offline). Nothing else imports Rain directly.
- `portal/` — the demo portal: live credit line, obligations, collateral, activity log.
- `chain/` — viem clients and human-readable ABIs.

## Run it

```bash
npm install
anvil --block-time 1 &
cd contracts && forge install foundry-rs/forge-std && forge test -vv
DEPLOYER_PRIVATE_KEY=<anvil key 0> forge script script/Deploy.s.sol \
  --rpc-url http://127.0.0.1:8545 --private-key <anvil key 0> --broadcast
cd .. && npm run portal   # http://localhost:5173
```

Then in the portal: register the agent, buy the phone, pay it off, watch the collateral requirement fall, buy the bike uncollateralized, and force a miss.

`npm run preflight` checks whether live Rain rails are reachable.

## Status

- Contracts: **9/9 tests passing**, full lifecycle covered including the default path
- Portal: verified end-to-end against deployed contracts on anvil
- Rain: `api-dev.rain.xyz` reachable, auth header is `api-key`, `/v1/issuing/*` live. Collateral routes return 403 for our key — the ladder currently drives `MockRails`
- Monad testnet: RPC verified (`testnet-rpc.monad.xyz`, chain 10143); deploy pending faucet funds

## License

MIT
