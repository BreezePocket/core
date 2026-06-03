# Spec: Solana Options Yield

## Objective

Build a Solana-native DeFi options yield product where retail users earn premium income by writing covered calls (CC) and cash-secured puts (CSP). Users are yield-seeking, comfortable selecting strike price and expiry date, but not experienced options traders.

**User story:**
> As a retail user holding SOL or USDC, I want to write a covered call or cash-secured put to earn premium income, so that my idle assets generate yield without requiring options expertise.

**Two outcomes per strategy (no loss framing):**
- **Covered call:** Keep premium + SOL returned (OTM) / Keep premium + SOL called away at agreed strike (ITM)
- **Cash-secured put:** Keep premium + USDC returned (OTM) / Keep premium + buy SOL at discount below market (ITM)

**System overview:**

```
User (Frontend)
    │ pick token, strategy, strike, expiry, amount
    ▼
Aggregator Server (Rust)
    │ broadcast RFQ to private MMs via /ws/rfq (fallover: REST)
    │ collect quotes, select best premium
    │ return unsigned tx + quote details to frontend
    ▼
Frontend
    │ display premium amount + % ROE
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
    │   - premium transferred from MM wallet to user upfront
    │ position lives until expiry
    ▼
Auto-settlement (permissionless settle ix)
    │ reads Chainlink oracle price at expiry
    │ distributes collateral per outcome
    ▼
User + MM wallets receive funds
```

**Transaction signing flow:**
1. Frontend sends quote request to aggregator (user pubkey + position params)
2. Aggregator broadcasts RFQ to MMs via `/ws/rfq`, collects quotes, selects best premium
3. Aggregator builds unsigned `open_position` transaction, returns it with quote details to frontend
4. User reviews premium + ROE, signs the transaction, sends signed tx back to aggregator
5. Aggregator forwards user-signed tx to winning MM via `/ws/sign` for final confirmation
6. MM accepts → co-signs → returns co-signed tx to aggregator → aggregator broadcasts; MM pays tx fee + PDA rent
7. MM rejects (stale quote) → aggregator notifies frontend → user sees rejection message → 10s wait → aggregator auto-re-broadcasts RFQ
8. MM no response within 10s → treated same as rejection; aggregator notifies frontend → 10s wait → auto-re-broadcasts RFQ

---

## Tech Stack

| Component | Stack |
|---|---|
| Solana program | Anchor (Rust), Solana 1.18+ |
| Aggregator server | Rust (Axum), Tokio async runtime |
| Frontend | Vite + React + TypeScript |
| Wallet | @solana/wallet-adapter |
| Oracle | Chainlink on Solana (SOL/USD feed) |
| MM transport | Two WS connections per MM: `/ws/rfq` (quotes) + `/ws/sign` (co-signing); REST fallover per-connection |
| MM reference bot | Rust crate (`mm-bot/`) — MMs run this to connect to aggregator, respond to RFQs, and co-sign txs |
| Tokens v1 | SOL (CC collateral), USDC (CSP collateral) |
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
│   └── options-yield/          # Anchor program
│       ├── src/
│       │   ├── lib.rs           # Program entrypoint, instruction routing
│       │   ├── instructions/    # open_position, settle, emergency_cancel,
│       │   │                    # set_oracle_override, initialize_config
│       │   ├── state/           # PositionAccount, GlobalConfig, TokenOracleOverride
│       │   └── errors.rs        # Custom error codes
│       └── Cargo.toml
├── aggregator/                  # Rust aggregator server
│   ├── src/
│   │   ├── main.rs              # Axum server entrypoint
│   │   ├── routes/              # POST /quote, POST /confirm, GET /health
│   │   ├── mm/                  # MM connection manager
│   │   │   ├── mod.rs           # Per-MM state: two WS connections + REST fallover
│   │   │   ├── rfq_channel.rs   # /ws/rfq connection: broadcast RFQ, collect quotes
│   │   │   └── sign_channel.rs  # /ws/sign connection: forward user-signed tx, await co-sign
│   │   ├── rfq.rs               # RFQ broadcast + best-quote selection logic
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
│   │   ├── hooks/               # useQuote, usePosition, useWallet
│   │   ├── lib/                 # Solana program client, utils
│   │   ├── pages/               # Home, Earn, Positions
│   │   └── types.ts             # Shared TypeScript types
│   ├── index.html
│   └── package.json
├── tests/                       # Anchor integration tests (TypeScript)
├── docs/
│   ├── ideas/
│   └── specs/
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
    pub bump: u8,                       // 1
}

#[account]
pub struct TokenOracleOverride {
    pub token: Token,                   // 1
    pub override_price: u64,            // 8 — set by governance; 0 = use Chainlink
    pub override_ts: i64,               // 8 — timestamp when override was set
    pub approvals: [bool; 5],           // 5 — tracks which governance keys have signed
    pub bump: u8,                       // 1
}

#[account]
pub struct PositionAccount {
    pub user: Pubkey,           // 32
    pub market_maker: Pubkey,   // 32
    pub strategy: Strategy,     // 1 (enum)
    pub token: Token,           // 1 (enum)
    pub strike_price: u64,      // 8 — lamports or USDC base units
    pub expiry_ts: i64,         // 8 — unix timestamp
    pub user_collateral: u64,   // 8
    pub mm_collateral: u64,     // 8
    pub premium: u64,           // 8
    pub nonce: u64,             // 8 — replay protection
    pub settled: bool,          // 1
    pub bump: u8,               // 1
}

// Instructions return Result<()>, use require! for guards
pub fn open_position(ctx: Context<OpenPosition>, params: OpenParams) -> Result<()> {
    require!(params.expiry_ts > Clock::get()?.unix_timestamp, ErrorCode::ExpiryInPast);
    // ...
}
```

### TypeScript (frontend)
```typescript
// Named exports, no default exports except pages
export function useQuote(params: QuoteParams): UseQuoteResult { ... }

// Types over interfaces for unions; interfaces for objects
type Strategy = 'covered_call' | 'cash_secured_put';
interface QuoteResult { premium: BN; roe: number; mm: PublicKey; expiresAt: number; }

// No `any`. Unknown external data gets a Zod schema.
```

**Naming conventions:**
- Rust: `snake_case` everywhere, `SCREAMING_SNAKE_CASE` for constants
- TypeScript: `camelCase` variables/functions, `PascalCase` components/types
- Accounts: PDA seeds use descriptive prefixes — `b"position"`, `b"config"`

---

## Testing Strategy

### Solana Program (Anchor + TypeScript)
- Location: `tests/`
- Framework: Anchor's built-in test harness (Mocha + Chai)
- Coverage: All instructions × all outcomes
- Key scenarios:
  - Atomic lock: both user and MM collateral transfer in single tx or entire tx reverts
  - Settlement OTM: user gets collateral back, MM gets collateral back
  - Settlement ITM: MM gets user collateral, MM gets own collateral back
  - Settle before expiry: fails with `NotExpiredYet`
  - Double settle: fails with `AlreadySettled`
  - Nonce replay: submitting the same signed tx twice fails with account already exists
  - Governance emergency cancel: 3/5 signers succeeds; 2/5 fails with `InsufficientGovernanceSignatures`; non-governance signer fails with `UnauthorizedGovernanceSigner`
  - Oracle override: settle uses override price when set; uses Chainlink when not set
  - `initialize_config` called twice: second call fails

### Aggregator Server (Rust)
- Location: `aggregator/src/` (unit) + `aggregator/tests/` (integration)
- Framework: `#[cfg(test)]` unit tests, `tokio::test` for async
- Coverage: RFQ broadcast logic, best-quote selection, WS reconnect, REST fallover trigger

### Frontend (Vitest + Testing Library)
- Location: `app/src/__tests__/`
- Framework: Vitest, React Testing Library
- Coverage: quote display, form validation, transaction state machine (idle → quoting → confirming → locked → settled)
- No wallet interaction in unit tests — mock the wallet adapter

---

## Boundaries

**Always:**
- Run `anchor test` before any program change is considered done
- Run `cargo clippy -- -D warnings` before committing Rust code
- Validate all user inputs at the frontend boundary (amount > 0, expiry in future, strike > 0)
- Use `require!` guards in every instruction for all preconditions

**Ask first:**
- Adding any new on-chain account or changing account layout (breaks existing PDAs)
- Adding a new token beyond SOL/USDC
- Changing the aggregator's public API shape (breaks frontend integration)
- Adding new npm or Cargo dependencies

**Never:**
- Commit wallet keypairs, RPC URLs with API keys, or MM credentials
- Allow early exit or position closing (by design — "set and forget")
- Use `unwrap()` or `expect()` in production Rust paths; use `?` or explicit error handling
- Expose MM identity or collateral amounts to other users

---

## Success Criteria

### Solana Program
- [ ] A single `open_position` transaction, requiring both user and MM signatures, atomically: locks user collateral in PDA, draws MM collateral from MM wallet to PDA, and transfers premium from MM wallet to user — or reverts entirely with no partial state
- [ ] MM is the transaction fee payer and pays PDA rent for the position account
- [ ] `open_position` includes a `nonce` field; replaying the same signed tx fails because the PDA (seeded by user + MM + strike + expiry + nonce) already exists
- [ ] A permissionless `settle` instruction callable by anyone after `expiry_ts` correctly distributes collateral: OTM returns user collateral to user + MM collateral to MM; ITM transfers user collateral to MM + MM collateral to MM (user already received premium upfront)
- [ ] `settle` reads `TokenOracleOverride` first; uses override price if set, Chainlink feed otherwise
- [ ] `settle` called before `expiry_ts` fails with `NotExpiredYet`
- [ ] Calling `settle` twice fails with `AlreadySettled`
- [ ] `open_position` fails if the MM signature is absent
- [ ] **Governance — emergency cancel:** `emergency_cancel` requires 3 of 5 `GlobalConfig.governance_keys` to have signed; returns user collateral to user and MM collateral to MM immediately, regardless of expiry or strike; marks position as settled
- [ ] **Governance — oracle override:** `set_oracle_override` requires 3 of 5 governance keys; sets a manual price on `TokenOracleOverride` for a given token; all subsequent `settle` calls for that token use the override price instead of Chainlink
- [ ] Governance instructions fail with `InsufficientGovernanceSignatures` if fewer than 3 valid governance keys sign
- [ ] Non-governance pubkeys signing governance instructions fail with `UnauthorizedGovernanceSigner`
- [ ] `initialize_config` sets the 5 governance pubkeys and `required_signatures = 3`; can only be called once

### Aggregator Server
- [ ] Each MM maintains two separate WS connections: `/ws/rfq` for quote broadcast and `/ws/sign` for co-sign requests
- [ ] RFQ broadcast over `/ws/rfq` reaches all connected MMs; best premium selected; unsigned tx returned to frontend
- [ ] After receiving user-signed tx, forwards `SignRequest` to winning MM over `/ws/sign`
- [ ] MM accepts within 10s: aggregator receives co-signed tx, broadcasts it, returns tx signature to frontend
- [ ] MM rejects within 10s: aggregator notifies frontend with rejection reason; auto-re-broadcasts RFQ after 10s
- [ ] MM does not reply within 10s: treated as rejection — aggregator notifies frontend; auto-re-broadcasts RFQ after 10s
- [ ] Each WS connection (`/ws/rfq` and `/ws/sign`) reconnects automatically on disconnect
- [ ] Falls back to REST per-connection if WS cannot be established
- [ ] Returns HTTP 504 if no MM responds to initial RFQ within timeout

### Frontend
- [ ] User can select strategy (CC or CSP), token, strike, expiry, and amount in a single form
- [ ] Quote fetch is triggered automatically after all fields are filled; shows loading state
- [ ] Premium amount and % ROE are displayed clearly before confirmation
- [ ] User signs the unsigned tx via wallet adapter; signed tx sent back to aggregator
- [ ] While awaiting MM final confirmation, a pending state is shown
- [ ] MM rejection or timeout shows an explicit message ("Quote rejected by market maker"); auto-refetches after 10s
- [ ] On MM acceptance, transaction status shown (pending → confirmed → locked)
- [ ] After confirmation, position is shown as locked with expiry countdown
- [ ] Two-outcome display shown per strategy (no loss framing)
- [ ] Premium received upfront is shown immediately after tx confirms

---

## Resolved Decisions

| Decision | Resolution |
|---|---|
| MM collateral source | MM co-signs and broadcasts final tx; collateral drawn from MM wallet atomically |
| Signing order | User signs first (intent), MM signs last (final confirmation + broadcast) |
| MM gas responsibility | MM pays tx fee + PDA rent — MM is the broadcaster |
| Quote staleness protection | MM has final right to reject before co-signing; on stale rejection frontend shows message + auto-refetches after 10s |
| Premium timing | Upfront — transferred from MM to user in the `open_position` tx |
| Aggregator role | Single coordination point for both quote routing and tx forwarding; MM never talks directly to frontend |

## Resolved Decisions (continued)

| Decision | Resolution |
|---|---|
| MM ↔ aggregator broadcast | MM returns co-signed tx to aggregator; aggregator broadcasts. Keeps state machine and tx status tracking in one place. |
| Quote replay protection | Explicit `nonce` field in `open_position` + PDA seed includes nonce. Replayed tx fails with "account already exists." Included in v1. |
| Governance mechanism | Custom 3/5 authority list in `GlobalConfig` account — no external multisig dependency. |
| Emergency cancel | 3/5 governance signatures cancel any position; returns collateral to both parties ignoring expiry/strike. |
| Oracle override scope | Per-token global override via `TokenOracleOverride` account; affects all settling positions for that token. Chainlink used as default when no override is set. |

## Open Questions

- [ ] **Chainlink feed address** — confirm SOL/USD feed program ID for Solana devnet and mainnet
