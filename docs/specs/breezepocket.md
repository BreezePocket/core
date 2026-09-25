# Spec: breezepocket

## Objective

Build a Solana-native DeFi yield product where retail users earn yield by committing to sell SOL at a fixed price, or buy SOL at a fixed price, by a chosen expiry. Users are yield-seeking, comfortable selecting a fixed price and expiry date, but not experienced traders.

**User story:**
> As a retail user holding SOL or USDC, I want to commit to selling or buying SOL at a fixed price and receive yield upfront, so that my idle assets generate yield without requiring trading expertise.

**Two outcomes per product (no loss framing):**
- **Sell SOL:** Keep yield + SOL returned (settlement price below fixed price) / Keep yield + SOL sold at the agreed fixed price (settlement price at or above fixed price)
- **Buy SOL:** Keep yield + USDC returned (settlement price above fixed price) / Keep yield + SOL bought at the fixed price, below market (settlement price at or below fixed price)

Outcome names used throughout this spec: **kept** (collateral returned to user), **sold** (Sell SOL executed), **bought** (Buy SOL executed).

**System overview:**

```
User (Frontend)
    │ pick token, product, fixed price, expiry, amount
    ▼
Aggregator Server (Rust)
    │ broadcast RFQ to private MMs via /ws/rfq (fallover: REST)
    │ collect quotes, select best yield
    │ return unsigned tx + quote details to frontend
    ▼
Frontend
    │ display yield amount + % yield
    │ user signs tx (user-signed tx sent back to aggregator)
    ▼
Aggregator Server (Rust)
    │ forward user-signed tx to winning MM via /ws/sign (fallover: REST)
    │ MM reviews — accepts (co-signs + returns tx) or rejects (stale quote)
    │   if rejected: notify frontend → show rejection message →
    │                wait 10s → auto re-broadcast RFQ for fresh quote
    ▼
Solana Program (Anchor)
    │ MM broadcasts fully-signed tx (user sig + MM sig)
    │ MM pays transaction fee + PDA rent
    │ atomic in single tx:
    │   - user collateral transferred to PDA
    │   - MM collateral drawn from MM wallet to PDA
    │   - yield transferred from MM wallet to user upfront
    │ position lives until expiry
    ▼
Settlement price posting (aggregator job, 08:00 UTC on expiry)
    │ fetch Deribit SOL delivery price for the expiry
    │ post on-chain via post_settlement_price (price poster key)
    │ 30-minute dispute window (governance may override)
    ▼
Auto-settlement (permissionless settle ix)
    │ reads posted settlement price for token + expiry
    │ distributes collateral per outcome
    ▼
User + MM wallets receive funds
```

**Transaction signing flow:**
1. Frontend sends quote request to aggregator (user pubkey + position params)
2. Aggregator broadcasts RFQ to MMs via `/ws/rfq`, collects quotes, selects best yield
3. Aggregator builds unsigned `open_position` transaction, returns it with quote details to frontend
4. User reviews yield + % yield, signs the transaction, sends signed tx back to aggregator
5. Aggregator forwards user-signed tx to winning MM via `/ws/sign` for final confirmation
6. MM accepts → co-signs → returns co-signed tx to aggregator → aggregator broadcasts; MM pays tx fee + PDA rent
7. MM rejects (stale quote) → aggregator notifies frontend → user sees rejection message → 10s wait → aggregator auto-re-broadcasts RFQ
8. MM no response within 10s → treated same as rejection; aggregator notifies frontend → 10s wait → auto-re-broadcasts RFQ

**Settlement flow:**
1. Expiries are restricted to Deribit-listed SOL expiries, which settle at 08:00 UTC. The aggregator serves the allowed list via `GET /expiries`.
2. At 08:00 UTC on an expiry date, Deribit publishes the SOL delivery price (30-minute TWAP of the Deribit SOL index, 07:30–08:00 UTC).
3. The aggregator settlement job fetches it from `public/get_delivery_prices` (index `sol_usdc`) and submits `post_settlement_price`, signed by the price poster key held in `GlobalConfig`.
4. A 30-minute dispute window starts at posting. During the window, 3/5 governance may call `override_settlement_price`.
5. After the window, the settlement job calls `settle` for every position at that expiry. `settle` is permissionless, so anyone may call it.
6. The settlement price source is published to users and MMs: "Settled at the Deribit SOL delivery price for this expiry."

---

## Tech Stack

| Component | Stack |
|---|---|
| Solana program | Anchor (Rust), Solana 1.18+ |
| Aggregator server | Rust (Axum), Tokio async runtime |
| Frontend | Vite + React + TypeScript |
| Wallet | @solana/wallet-adapter |
| Settlement price | Deribit SOL delivery price via public API, posted on-chain by the aggregator with the price poster key |
| MM transport | Two WS connections per MM: `/ws/rfq` (quotes) + `/ws/sign` (co-signing); REST fallover per-connection |
| MM reference bot | Rust crate (`mm-bot/`) — MMs run this to connect to aggregator, respond to RFQs, and co-sign txs |
| Tokens v1 | SOL (Sell SOL collateral), USDC (Buy SOL collateral) |
| Governance | Custom 3/5 multisig authority list in `GlobalConfig` account |

---

## Commands

### Solana Program
```
Build:   anchor build
Test:    anchor test
Deploy:  anchor deploy --provider.cluster devnet
Clean:   cargo clean
```

### Aggregator Server
```
Build:   cargo build --release
Dev:     cargo run
Test:    cargo test
Lint:    cargo clippy -- -D warnings
Format:  cargo fmt
Settle:  cargo run -- settle --expiry <unix_ts>   # run the settlement job once, manually
```

### MM Reference Bot
```
Build:   cargo build -p mm-bot --release
Run:     cargo run -p mm-bot
Reject:  cargo run -p mm-bot -- --reject
Slow:    cargo run -p mm-bot -- --slow
```

### Frontend
```
Dev:     npm run dev
Build:   npm run build
Test:    npm run test
Lint:    npm run lint
Preview: npm run preview
```

---

## Project Structure

```
core/
├── programs/
│   └── breezepocket/            # Anchor program
│       ├── src/
│       │   ├── lib.rs           # Program entrypoint, instruction routing
│       │   ├── instructions/    # open_position, settle, emergency_cancel,
│       │   │                    # post_settlement_price, override_settlement_price,
│       │   │                    # initialize_config
│       │   ├── state/           # PositionAccount, GlobalConfig, SettlementPrice
│       │   └── errors.rs        # Custom error codes
│       └── Cargo.toml
├── aggregator/                  # Rust aggregator server
│   ├── src/
│   │   ├── main.rs              # Axum server entrypoint + settlement job scheduler
│   │   ├── routes/              # POST /quote, POST /confirm, GET /expiries, GET /health
│   │   ├── mm/                  # MM connection manager
│   │   │   ├── mod.rs           # Per-MM state: two WS connections + REST fallover
│   │   │   ├── rfq_channel.rs   # /ws/rfq connection: broadcast RFQ, collect quotes
│   │   │   └── sign_channel.rs  # /ws/sign connection: forward user-signed tx, await co-sign
│   │   ├── rfq.rs               # RFQ broadcast + best-quote selection logic
│   │   ├── settlement/          # Settlement job
│   │   │   ├── deribit.rs       # Fetch listed expiries + delivery price from Deribit public API
│   │   │   └── job.rs           # 08:00 UTC schedule: post price, wait window, settle positions
│   │   └── types.rs             # Shared protocol types (RfqRequest, SignRequest, etc.)
│   └── Cargo.toml
├── mm-bot/                      # MM reference quoting bot (Rust)
│   ├── src/
│   │   ├── main.rs              # Bot entrypoint — connects to aggregator, runs quote + sign loops
│   │   ├── rfq.rs               # Handles incoming RFQ requests, generates quotes
│   │   ├── sign.rs              # Handles incoming sign requests, co-signs tx with MM keypair
│   │   └── config.rs            # MM keypair, aggregator URL, pricing config
│   └── Cargo.toml
├── app/                         # Vite + React frontend
│   ├── src/
│   │   ├── components/          # UI components
│   │   ├── hooks/               # useQuote, usePosition, useWallet, useExpiries
│   │   ├── lib/                 # Solana program client, utils
│   │   ├── pages/               # Home, Earn, Positions
│   │   └── types.ts             # Shared TypeScript types
│   ├── index.html
│   └── package.json
├── tests/                       # Anchor integration tests (TypeScript)
├── docs/
│   ├── ideas/
│   ├── specs/
│   └── plans/
├── Anchor.toml
└── Cargo.toml                   # Workspace
```

---

## Code Style

### Rust (program + aggregator)
```rust
// State structs use snake_case fields, explicit sizes for on-chain accounts
#[account]
pub struct GlobalConfig {
    pub governance_keys: [Pubkey; 5],   // 160 — 3/5 multisig authority list
    pub required_signatures: u8,        // 1  — always 3
    pub price_poster: Pubkey,           // 32 — key allowed to post Deribit delivery prices
    pub bump: u8,                       // 1
}

#[account]
pub struct SettlementPrice {
    pub token: Token,                   // 1
    pub expiry_ts: i64,                 // 8 — 08:00 UTC on the expiry date
    pub price: u64,                     // 8 — USDC base units per token; Deribit delivery price
    pub posted_ts: i64,                 // 8 — when the price was posted; dispute window starts here
    pub source: PriceSource,            // 1 — Poster | Governance
    pub approvals: [bool; 5],           // 5 — governance override approvals
    pub bump: u8,                       // 1
}

#[account]
pub struct PositionAccount {
    pub user: Pubkey,           // 32
    pub market_maker: Pubkey,   // 32
    pub product: Product,       // 1 (enum: SellSol | BuySol)
    pub token: Token,           // 1 (enum)
    pub fixed_price: u64,       // 8 — USDC base units per SOL
    pub expiry_ts: i64,         // 8 — unix timestamp, must be 08:00 UTC
    pub user_collateral: u64,   // 8
    pub mm_collateral: u64,     // 8
    pub yield_amount: u64,      // 8 — paid to user upfront
    pub nonce: u64,             // 8 — replay protection
    pub settled: bool,          // 1
    pub bump: u8,               // 1
}

// Instructions return Result<()>, use require! for guards
pub fn open_position(ctx: Context<OpenPosition>, params: OpenParams) -> Result<()> {
    require!(params.expiry_ts > Clock::get()?.unix_timestamp, ErrorCode::ExpiryInPast);
    require!(params.expiry_ts % 86_400 == 28_800, ErrorCode::ExpiryNotAligned); // 08:00 UTC
    // ...
}
```

### TypeScript (frontend)
```typescript
// Named exports, no default exports except pages
export function useQuote(params: QuoteParams): UseQuoteResult { ... }

// Types over interfaces for unions; interfaces for objects
type Product = 'sell_sol' | 'buy_sol';
interface QuoteResult { yieldAmount: BN; yieldPct: number; mm: PublicKey; expiresAt: number; }

// No `any`. Unknown external data gets a Zod schema.
```

**Naming conventions:**
- Rust: `snake_case` everywhere, `SCREAMING_SNAKE_CASE` for constants
- TypeScript: `camelCase` variables/functions, `PascalCase` components/types
- Accounts: PDA seeds use descriptive prefixes — `b"position"`, `b"config"`, `b"settlement_price"`

---

## Testing Strategy

### Solana Program (Anchor + TypeScript)
- Location: `tests/`
- Framework: Anchor's built-in test harness (Mocha + Chai)
- Coverage: All instructions × all outcomes
- Key scenarios:
  - Atomic lock: both user and MM collateral transfer in single tx or entire tx reverts
  - Settlement kept: user gets collateral back, MM gets collateral back
  - Settlement sold / bought: MM gets user collateral, MM gets own collateral back
  - Settle before expiry: fails with `NotExpiredYet`
  - Settle with no posted price: fails with `SettlementPriceMissing`
  - Settle inside dispute window: fails with `DisputeWindowOpen`
  - Double settle: fails with `AlreadySettled`
  - Nonce replay: submitting the same signed tx twice fails with account already exists
  - Expiry not at 08:00 UTC: fails with `ExpiryNotAligned`
  - Governance emergency cancel: 3/5 signers succeeds; 2/5 fails with `InsufficientGovernanceSignatures`; non-governance signer fails with `UnauthorizedGovernanceSigner`
  - Price posting: poster key succeeds; any other key fails with `UnauthorizedPricePoster`; second post for same token + expiry fails
  - Governance override: replaces posted price, sets `source = Governance`, settle uses it immediately
  - `initialize_config` called twice: second call fails

### Aggregator Server (Rust)
- Location: `aggregator/src/` (unit) + `aggregator/tests/` (integration)
- Framework: `#[cfg(test)]` unit tests, `tokio::test` for async
- Coverage: RFQ broadcast logic, best-quote selection, WS reconnect, REST fallover trigger, Deribit delivery price parsing, settlement job retry and ordering

### Frontend (Vitest + Testing Library)
- Location: `app/src/__tests__/`
- Framework: Vitest, React Testing Library
- Coverage: quote display, form validation, expiry list from aggregator, transaction state machine (idle → quoting → confirming → locked → settled)
- No wallet interaction in unit tests — mock the wallet adapter

---

## Boundaries

**Always:**
- Run `anchor test` before any program change is considered done
- Run `cargo clippy -- -D warnings` before committing Rust code
- Validate all user inputs at the frontend boundary (amount > 0, expiry in the allowed list, fixed price > 0)
- Use `require!` guards in every instruction for all preconditions
- Show users the settlement price source ("Deribit SOL delivery price") before they confirm

**Ask first:**
- Adding any new on-chain account or changing account layout (breaks existing PDAs)
- Adding a new token beyond SOL/USDC
- Changing the aggregator's public API shape (breaks frontend integration)
- Adding new npm or Cargo dependencies
- Changing the dispute window length

**Never:**
- Commit wallet keypairs, RPC URLs with API keys, the price poster key, or MM credentials
- Allow early exit or position closing (by design — "set and forget")
- Use `unwrap()` or `expect()` in production Rust paths; use `?` or explicit error handling
- Expose MM identity or collateral amounts to other users
- Settle a position on any price other than the posted `SettlementPrice` for its token and expiry

---

## Success Criteria

### Solana Program
- [ ] A single `open_position` transaction, requiring both user and MM signatures, atomically: locks user collateral in PDA, draws MM collateral from MM wallet to PDA, and transfers yield from MM wallet to user — or reverts entirely with no partial state
- [ ] MM is the transaction fee payer and pays PDA rent for the position account
- [ ] `open_position` includes a `nonce` field; replaying the same signed tx fails because the PDA (seeded by user + MM + fixed price + expiry + nonce) already exists
- [ ] `open_position` rejects any `expiry_ts` that is not 08:00 UTC with `ExpiryNotAligned`
- [ ] `post_settlement_price` creates the `SettlementPrice` PDA for a token and expiry; only `GlobalConfig.price_poster` may call it; fails with `UnauthorizedPricePoster` otherwise; fails if the PDA already exists
- [ ] A permissionless `settle` instruction callable by anyone after `expiry_ts` correctly distributes collateral: kept returns user collateral to user + MM collateral to MM; sold / bought transfers user collateral to MM + MM collateral to MM (user already received yield upfront)
- [ ] `settle` reads `SettlementPrice` for the position's token and expiry; fails with `SettlementPriceMissing` if none is posted
- [ ] `settle` fails with `DisputeWindowOpen` if fewer than 30 minutes have passed since `posted_ts` and `source == Poster`; no wait applies when `source == Governance`
- [ ] `settle` called before `expiry_ts` fails with `NotExpiredYet`
- [ ] Calling `settle` twice fails with `AlreadySettled`
- [ ] `open_position` fails if the MM signature is absent
- [ ] **Governance — emergency cancel:** `emergency_cancel` requires 3 of 5 `GlobalConfig.governance_keys` to have signed; returns user collateral to user and MM collateral to MM immediately, regardless of expiry or fixed price; marks position as settled
- [ ] **Governance — settlement price override:** `override_settlement_price` requires 3 of 5 governance keys; writes a price to `SettlementPrice` for a given token and expiry (creating it if the poster never posted); sets `source = Governance`; all subsequent `settle` calls for that token and expiry use it
- [ ] Governance instructions fail with `InsufficientGovernanceSignatures` if fewer than 3 valid governance keys sign
- [ ] Non-governance pubkeys signing governance instructions fail with `UnauthorizedGovernanceSigner`
- [ ] `initialize_config` sets the 5 governance pubkeys, `required_signatures = 3`, and `price_poster`; can only be called once

### Aggregator Server
- [ ] Each MM maintains two separate WS connections: `/ws/rfq` for quote broadcast and `/ws/sign` for co-sign requests
- [ ] RFQ broadcast over `/ws/rfq` reaches all connected MMs; best yield selected; unsigned tx returned to frontend
- [ ] After receiving user-signed tx, forwards `SignRequest` to winning MM over `/ws/sign`
- [ ] MM accepts within 10s: aggregator receives co-signed tx, broadcasts it, returns tx signature to frontend
- [ ] MM rejects within 10s: aggregator notifies frontend with rejection reason; auto-re-broadcasts RFQ after 10s
- [ ] MM does not reply within 10s: treated as rejection — aggregator notifies frontend; auto-re-broadcasts RFQ after 10s
- [ ] Each WS connection (`/ws/rfq` and `/ws/sign`) reconnects automatically on disconnect
- [ ] Falls back to REST per-connection if WS cannot be established
- [ ] Returns HTTP 504 if no MM responds to initial RFQ within timeout
- [ ] `GET /expiries` returns the Deribit-listed SOL expiries as 08:00 UTC unix timestamps, refreshed at least hourly
- [ ] `POST /quote` rejects an expiry not in the current list with HTTP 400
- [ ] Settlement job runs at 08:00 UTC daily: fetches the Deribit delivery price for any expiry with open positions, posts it via `post_settlement_price`, retries every 60s for up to 60 minutes on fetch failure, then calls `settle` for every open position at that expiry once the dispute window has passed
- [ ] Settlement job is idempotent: re-running it never double-posts or double-settles
- [ ] Settlement job alerts (log at error level) if the price cannot be posted within 60 minutes, so governance can override

### Frontend
- [ ] User can select product (Sell SOL or Buy SOL), fixed price, expiry, and amount in a single form
- [ ] Expiry picker lists only expiries returned by `GET /expiries`
- [ ] Quote fetch is triggered automatically after all fields are filled; shows loading state
- [ ] Yield amount and % yield are displayed clearly before confirmation
- [ ] Settlement price source shown before confirmation: "Settles at the Deribit SOL delivery price on <date> 08:00 UTC"
- [ ] User signs the unsigned tx via wallet adapter; signed tx sent back to aggregator
- [ ] While awaiting MM final confirmation, a pending state is shown
- [ ] MM rejection or timeout shows an explicit message ("Quote rejected by market maker"); auto-refetches after 10s
- [ ] On MM acceptance, transaction status shown (pending → confirmed → locked)
- [ ] After confirmation, position is shown as locked with expiry countdown
- [ ] Two-outcome display shown per product (no loss framing)
- [ ] Yield received upfront is shown immediately after tx confirms

---

## Resolved Decisions

| Decision | Resolution |
|---|---|
| MM collateral source | MM co-signs and broadcasts final tx; collateral drawn from MM wallet atomically |
| Signing order | User signs first (intent), MM signs last (final confirmation + broadcast) |
| MM gas responsibility | MM pays tx fee + PDA rent — MM is the broadcaster |
| Quote staleness protection | MM has final right to reject before co-signing; on stale rejection frontend shows message + auto-refetches after 10s |
| Yield timing | Upfront — transferred from MM to user in the `open_position` tx |
| Aggregator role | Single coordination point for quote routing, tx forwarding, and settlement price posting; MM never talks directly to frontend |

## Resolved Decisions (continued)

| Decision | Resolution |
|---|---|
| MM ↔ aggregator broadcast | MM returns co-signed tx to aggregator; aggregator broadcasts. Keeps state machine and tx status tracking in one place. |
| Quote replay protection | Explicit `nonce` field in `open_position` + PDA seed includes nonce. Replayed tx fails with "account already exists." Included in v1. |
| Governance mechanism | Custom 3/5 authority list in `GlobalConfig` account — no external multisig dependency. |
| Emergency cancel | 3/5 governance signatures cancel any position; returns collateral to both parties ignoring expiry/fixed price. |
| Settlement price | Deribit SOL delivery price for the matching expiry. Not an on-chain price feed: MMs hedge on Deribit, so this is the price they and we already agree on and it removes basis risk. |
| Price posting | Single `price_poster` key held by the aggregator operator at launch, automated by the settlement job. Chosen over multisig posting so settlement never waits on humans. |
| Dispute window | 30 minutes after a poster post before `settle` is allowed. Governance override takes effect immediately. Protects against a wrong or compromised post without slowing routine settlement much. |
| Expiry alignment | Only Deribit-listed expiries at 08:00 UTC. Enforced on-chain (`ExpiryNotAligned`) and in the aggregator (`GET /expiries`). |

## Open Questions

- [ ] **Deribit API rate limits and availability** — confirm `public/get_delivery_prices` and the instruments endpoint are reachable without auth from the aggregator host and how soon after 08:00 UTC the delivery price appears
- [ ] **Poster key rotation** — v1 has no instruction to change `price_poster`; decide whether to add a governance-gated `set_price_poster` before mainnet
