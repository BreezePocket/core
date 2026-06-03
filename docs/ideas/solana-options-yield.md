# Solana Options Yield

## Problem Statement
How might we let yield-seeking Solana retail users earn premium income by writing covered calls and cash-secured puts, without needing options expertise, while ensuring fair quotes from private market makers?

## Recommended Direction
**Guided Picker with Private MM Aggregator (RFQ model)**

User flow: pick strategy (CC or CSP) → set strike + expiry → enter amount → aggregator broadcasts RFQ to private MMs via WebSocket → best quote returned (premium amount + % ROE) → user signs transaction → aggregator forwards to winning MM for final confirmation → MM co-signs and aggregator broadcasts → funds locked on-chain until auto-settlement at expiry.

Both user collateral and MM collateral are posted atomically into a single program-owned PDA in one transaction. MM pays the transaction fee and PDA rent. Premium is transferred from MM to user upfront in the same transaction. At expiry, the Solana program auto-settles and releases collateral based on outcome — no user action required.

The two-outcome framing for CSP (buy SOL at discount OR reclaim USDC) removes the "loss" mental model entirely. Covered call mirrors this: keep premium OR SOL gets called away at a price the user already agreed to.

Private MMs give quote quality control at launch — enforce minimum spreads and SLAs before opening to public protocols.

## On-Chain Architecture
- **Contract:** Custom Solana program (Anchor)
- **Settlement account:** Single PDA per position, holds both user and MM collateral atomically from confirmation to expiry
- **Collateral flow:** User signs intent → MM co-signs and broadcasts → user collateral + MM collateral locked in PDA atomically → premium transferred to user upfront → auto-settle at expiry
- **Token v1:** SOL (covered call collateral) + USDC (cash-secured put collateral)
- **Oracle:** Chainlink SOL/USD feed for settlement price
- **Governance:** Custom 3/5 multisig (5 designated pubkeys in `GlobalConfig`) with two powers: emergency cancel any position, and manual oracle price override per token

## Signing Flow
1. Aggregator broadcasts RFQ to MMs over `/ws/rfq`; best premium selected; unsigned tx returned to frontend
2. User signs tx; signed tx sent back to aggregator
3. Aggregator forwards signed tx to winning MM over `/ws/sign` for final confirmation
4. MM accepts → co-signs → aggregator broadcasts (MM pays fee + rent)
5. MM rejects (stale quote) → frontend shows rejection message → auto-refetches after 10s
6. MM no response within 10s → treated as rejection; same auto-refetch flow

## MM Reference Bot
MMs run `mm-bot/` — a Rust crate in this repo. It opens two WebSocket connections to the aggregator on startup: `/ws/rfq` (receives RFQs, responds with quotes) and `/ws/sign` (receives sign requests, co-signs tx with MM keypair). Both channels reconnect automatically on disconnect with REST fallover per-connection.

## Replay Protection
Each position includes a random `nonce` field in the `open_position` instruction. The PDA is seeded with user + MM + strike + expiry + nonce, making each quote unique on-chain. Replayed transactions fail because the PDA already exists.

## Key Assumptions to Validate
- [ ] Retail users understand strike/expiry well enough without guardrails — validate with 5 user interviews before locking UI
- [ ] Atomic dual-collateral locking (user + MM in same tx, MM as fee payer) is feasible on Solana — verify with a contract spike in Task 1.2
- [ ] MM co-sign latency is reliably under 10s — test with mm-bot `--slow` flag
- [ ] Users will trust locking funds until expiry without an early-exit option — biggest behavioral unknown

## MVP Scope
**In:**
- Covered call (SOL collateral) + cash-secured put (USDC collateral)
- SOL and USDC only, v1
- Strike + expiry picker → aggregator RFQ → premium + % ROE display → user signs → MM final confirmation → atomic lock
- Premium paid to user upfront at confirmation
- Auto-settlement at expiry via Solana program (permissionless `settle` instruction)
- Chainlink SOL/USD oracle for settlement price; governance can override per-token
- 1–3 private market makers running mm-bot
- 3/5 governance multisig: emergency cancel + oracle override
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
- **Yield Vault mode** — users are comfortable with strike/expiry; abstracting it adds complexity without value for this audience
- **Greeks / IV display** — adds noise and breaks the "simple yield" narrative for retail
- **Multi-chain** — Solana-first keeps contract and integration surface manageable
- **Selling / closing positions** — simplifies contract model; "set and forget" is the core promise
- **Public MM integration** — v2 after private MM quality is proven
- **External multisig (Squads)** — custom authority list in GlobalConfig is sufficient for v1 with no external dependency
