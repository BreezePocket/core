# breezepocket

## Problem Statement
How might we let yield-seeking Solana retail users earn yield by committing to sell SOL at a fixed price, or buy SOL at a fixed price, without needing trading expertise, while ensuring fair quotes from private market makers?

## Recommended Direction
**Guided Picker with Private MM Aggregator (RFQ model)**

Two products, each with two outcomes:
- **Sell SOL:** lock SOL, receive yield now. At expiry, either SOL is returned or SOL is sold at the fixed price. Either way the yield is kept.
- **Buy SOL:** lock USDC, receive yield now. At expiry, either USDC is returned or SOL is bought at the fixed price. Either way the yield is kept.

User flow: pick product (Sell SOL or Buy SOL) → set fixed price + expiry → enter amount → aggregator broadcasts RFQ to private MMs via WebSocket → best quote returned (yield amount + % yield) → user signs transaction → aggregator forwards to winning MM for final confirmation → MM co-signs and aggregator broadcasts → funds locked on-chain until auto-settlement at expiry.

Both user collateral and MM collateral are posted atomically into a single program-owned PDA in one transaction. MM pays the transaction fee and PDA rent. Yield is transferred from MM to user upfront in the same transaction. At expiry, the Solana program auto-settles against the Deribit SOL delivery price for that expiry and releases collateral based on outcome — no user action required.

The two-outcome framing for Buy SOL (buy SOL at the fixed price OR reclaim USDC) removes the "loss" mental model entirely. Sell SOL mirrors this: keep the yield AND SOL is sold at a price the user already agreed to.

Private MMs give quote quality control at launch — enforce minimum spreads and SLAs before opening to public protocols.

## On-Chain Architecture
- **Contract:** Custom Solana program (Anchor)
- **Settlement account:** Single PDA per position, holds both user and MM collateral atomically from confirmation to expiry
- **Collateral flow:** User signs intent → MM co-signs and broadcasts → user collateral + MM collateral locked in PDA atomically → yield transferred to user upfront → auto-settle at expiry
- **Token v1:** SOL (Sell SOL collateral) + USDC (Buy SOL collateral)
- **Settlement price:** Deribit SOL delivery price for the matching expiry (30-minute TWAP of the Deribit SOL index from 07:30 to 08:00 UTC). The aggregator fetches it from Deribit's public API and posts it on-chain with the price poster key. Published openly to users and MMs as the settlement price.
- **Expiries:** Only Deribit-listed expiries at 08:00 UTC, so every position has a delivery price to settle against
- **Governance:** Custom 3/5 multisig (5 designated pubkeys in `GlobalConfig`) with two powers: emergency cancel any position, and override the settlement price for a token and expiry

## Signing Flow
1. Aggregator broadcasts RFQ to MMs over `/ws/rfq`; best yield selected; unsigned tx returned to frontend
2. User signs tx; signed tx sent back to aggregator
3. Aggregator forwards signed tx to winning MM over `/ws/sign` for final confirmation
4. MM accepts → co-signs → aggregator broadcasts (MM pays fee + rent)
5. MM rejects (stale quote) → frontend shows rejection message → auto-refetches after 10s
6. MM no response within 10s → treated as rejection; same auto-refetch flow

## Settlement Flow
1. At 08:00 UTC on the expiry date, Deribit publishes the SOL delivery price
2. The aggregator's settlement job fetches it via `public/get_delivery_prices` and posts it on-chain with `post_settlement_price`, signed by the price poster key
3. A 30-minute dispute window follows, during which 3/5 governance can override the posted price
4. After the window, the settlement job (or anyone) calls `settle` for every position at that expiry

## MM Reference Bot
MMs run `mm-bot/` — a Rust crate in this repo. It opens two WebSocket connections to the aggregator on startup: `/ws/rfq` (receives RFQs, responds with quotes) and `/ws/sign` (receives sign requests, co-signs tx with MM keypair). Both channels reconnect automatically on disconnect with REST fallover per-connection.

## Replay Protection
Each position includes a random `nonce` field in the `open_position` instruction. The PDA is seeded with user + MM + fixed price + expiry + nonce, making each quote unique on-chain. Replayed transactions fail because the PDA already exists.

## Key Assumptions to Validate
- [ ] Retail users understand fixed price/expiry well enough without guardrails — validate with 5 user interviews before locking UI
- [ ] Atomic dual-collateral locking (user + MM in same tx, MM as fee payer) is feasible on Solana — verify with a contract spike in Task 1.2
- [ ] MM co-sign latency is reliably under 10s — test with mm-bot `--slow` flag
- [ ] Users will trust locking funds until expiry without an early-exit feature — biggest behavioral unknown
- [ ] Deribit's delivery price API is available promptly after 08:00 UTC and users accept a single poster key at launch — validate by running the settlement job on devnet against live Deribit prices for two weeks

## MVP Scope
**In:**
- Sell SOL (SOL collateral) + Buy SOL (USDC collateral)
- SOL and USDC only, v1
- Fixed price + expiry picker → aggregator RFQ → yield amount + % yield display → user signs → MM final confirmation → atomic lock
- Yield paid to user upfront at confirmation
- Auto-settlement at expiry via Solana program (permissionless `settle` instruction)
- Deribit SOL delivery price as settlement price, posted on-chain automatically by the aggregator; governance can override per token and expiry
- Expiry picker limited to Deribit-listed expiries
- 1–3 private market makers running mm-bot
- 3/5 governance multisig: emergency cancel + settlement price override
- Nonce replay protection on every position
- Solana mainnet only

**Out:**
- Early exit / position closing
- Multiple simultaneous positions
- Portfolio view / position history
- Auto-roll / recurring yield
- Public MM / protocol integration
- Additional tokens beyond SOL and USDC

## Not Doing (and Why)
- **Yield Vault mode** — users are comfortable with fixed price/expiry; abstracting it adds complexity without value for this audience
- **Pricing internals display (volatility, sensitivities)** — adds noise and breaks the "simple yield" narrative for retail
- **Multi-chain** — Solana-first keeps contract and integration surface manageable
- **Selling / closing positions** — simplifies contract model; "set and forget" is the core promise
- **Public MM integration** — v2 after private MM quality is proven
- **External multisig (Squads)** — custom authority list in GlobalConfig is sufficient for v1 with no external dependency
- **On-chain price feed (Chainlink, Pyth)** — MMs hedge on Deribit, so settling on any other price adds basis risk for them and a dependency for us; the Deribit delivery price is the number everyone already agrees on
