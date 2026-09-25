# Implementation Plan: breezepocket

## Overview

Three deployables built in dependency order: Solana program first (produces the IDL that everything else depends on), then aggregator and frontend in parallel once the IDL exists. The highest-risk item — atomic dual-signature `open_position` with MM as fee payer — is the very first real code written.

## Architecture Decisions

- **Program-first:** Aggregator tx-builder and frontend client both depend on the Anchor IDL. Nothing upstream gets built until the program compiles and its IDL is stable.
- **Two WS connections per MM:** `/ws/rfq` handles RFQ quote broadcast; `/ws/sign` handles co-sign requests. Separate channels prevent sign requests from blocking or interleaving with live quote traffic.
- **MM reference bot (`mm-bot/`) built in Phase 0:** MMs run this Rust crate to connect to the aggregator, respond to RFQs, and co-sign transactions. It is a real deployable component, not a test stub — Phase 2 aggregator and integration tests run against it.
- **Deribit delivery price confirmed before Phase 1:** The public API for listed expiries and delivery prices is exercised end-to-end before any settle logic is written.
- **Settlement price posted, not read:** The program never reads an external feed. The aggregator posts the Deribit delivery price on-chain with the price poster key; `settle` reads that account after a dispute window.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Atomic dual-sig open_position fails cleanly | High — entire architecture depends on it | Spike in Task 1.2 before any downstream code |
| Deribit delivery price unavailable or late at 08:00 UTC | High — settlements stall | Task 0.3 confirms the API; settlement job retries for 60 min; governance override is the fallback |
| Price poster key compromised or posts a wrong price | High — wrong settlement | 30-minute dispute window before `settle`; 3/5 governance override; key kept off the aggregator host's public surface |
| MM co-sign latency exceeds 10s under load | Med — UX degrades | mm-bot `--slow` flag simulates delayed responses; timeout path tested in Task 2A.3 |
| Solana tx size limit hit (1232 bytes) with dual-sig + SPL transfers | Med — silent failure | Measure tx size in Task 1.2 spike |
| Nonce uniqueness not enforced if user reuses same params | Low — replay attack surface | PDA seed includes nonce; verify in test Task 1.5 |

---

## Phase 0: Workspace, Tooling & Contracts

*Goal: repo builds, mm-bot reference bot built, Deribit delivery price API confirmed, MM ↔ aggregator WS protocol defined.*

### Task 0.1: Initialize monorepo workspace

**Description:** Scaffold the Cargo workspace, Anchor program skeleton, aggregator crate, and Vite frontend. No logic yet — just the repo compiles and each component has a `hello world` entry point.

**Acceptance criteria:**
- [ ] `anchor build` succeeds with empty program
- [ ] `cargo build --release` succeeds in `aggregator/`
- [ ] `npm run build` succeeds in `app/`
- [ ] `Cargo.toml` workspace includes `programs/breezepocket`, `aggregator`, and `mm-bot`

**Verification:** Run all three build commands from repo root; all exit 0.

**Dependencies:** None

**Files:**
- `Cargo.toml` (workspace)
- `Anchor.toml`
- `programs/breezepocket/src/lib.rs`
- `aggregator/src/main.rs`
- `mm-bot/src/main.rs`, `mm-bot/Cargo.toml`
- `app/index.html`, `app/package.json`, `app/vite.config.ts`

**Scope:** M

---

### Task 0.2: Define MM ↔ aggregator WebSocket message protocol

**Description:** Write the typed message schema for all WS messages between MM and aggregator across both channels. `/ws/rfq` carries RFQ messages; `/ws/sign` carries sign messages. Types are defined in a shared location used by both `aggregator/` and `mm-bot/`.

**Acceptance criteria:**
- [ ] All message types defined as Rust structs with `serde` derive in `aggregator/src/types.rs`
- [ ] `/ws/rfq` channel types: `RfqRequest` (product, token, fixed price, expiry, amount, user pubkey, nonce), `RfqResponse` (yield amount, yield pct, mm pubkey)
- [ ] `/ws/sign` channel types: `SignRequest` (serialized user-signed tx as base64), `SignResponse` (serialized co-signed tx as base64), `SignRejection` (reason string)
- [ ] All types serialize/deserialize round-trip cleanly (unit test)
- [ ] Types re-exported or duplicated in `mm-bot/src/types.rs` so mm-bot compiles independently

**Verification:** `cargo test -p aggregator` passes; `cargo build -p mm-bot` succeeds.

**Dependencies:** Task 0.1

**Files:**
- `aggregator/src/types.rs`
- `mm-bot/src/types.rs`

**Scope:** S

---

### Task 0.3: Confirm Deribit delivery price and expiry APIs

**Description:** Exercise the two Deribit public endpoints the settlement job depends on, with no auth: `public/get_instruments` for currency `SOL`, filtered to the USDC-settled dated instruments, to derive the listed expiry dates, and `public/get_delivery_prices` (index `sol_usdc`) for the delivery price. Write a standalone Rust test that fetches both from Deribit production and parses them. Document the exact request shapes, the expiry-to-08:00-UTC mapping, and how soon after 08:00 UTC a new delivery price appears.

*Note: the instruments endpoint is only used to derive the listed expiry dates; the aggregator never trades on Deribit.*

**Acceptance criteria:**
- [ ] Request and response shapes for both endpoints documented in `docs/deribit-settlement.md`
- [ ] `#[tokio::test]` fetches the current SOL expiry list and asserts every expiry is 08:00 UTC
- [ ] `#[tokio::test]` fetches the latest SOL delivery price and parses it to `u64` USDC base units
- [ ] Observed delay between 08:00 UTC and delivery price publication recorded in the doc (check on at least two expiry dates)
- [ ] `DERIBIT_API_BASE` and `SOL_INDEX_NAME` constants added to `aggregator/src/settlement/deribit.rs`

**Verification:** `cargo test -p aggregator deribit` passes against Deribit production.

**Dependencies:** Task 0.1

**Files:**
- `aggregator/src/settlement/deribit.rs`
- `docs/deribit-settlement.md`

**Scope:** S

---

### Task 0.4: Build MM reference bot (`mm-bot/`)

**Description:** A production-quality Rust binary that MMs run to connect to the aggregator. Opens two WS connections on startup: one to `/ws/rfq` (receives RFQ requests, responds with quotes) and one to `/ws/sign` (receives sign requests, co-signs tx with MM keypair and returns). Configurable via env/config: aggregator URL, MM keypair path, pricing parameters. Supports `--reject` and `--slow` flags for integration testing.

**Acceptance criteria:**
- [ ] mm-bot opens `/ws/rfq` connection to aggregator on startup
- [ ] mm-bot opens `/ws/sign` connection to aggregator on startup
- [ ] Responds to `RfqRequest` on `/ws/rfq` with a `RfqResponse` using configured pricing
- [ ] Responds to `SignRequest` on `/ws/sign` by co-signing the tx with MM keypair and returning `SignResponse`
- [ ] Both connections reconnect automatically on disconnect
- [ ] With `--reject` flag, returns `SignRejection` on sign requests (for testing rejection path)
- [ ] With `--slow` flag, delays sign response by 11s (for testing timeout path)
- [ ] MM keypair loaded from file path in config; never hardcoded
- [ ] `cargo build -p mm-bot --release` succeeds

**Verification:** Start aggregator + mm-bot; send test RFQ via curl to `POST /quote`; verify unsigned tx returned. Send user-signed tx to `POST /confirm`; verify co-signed tx broadcast.

**Dependencies:** Task 0.2

**Files:**
- `mm-bot/src/main.rs`
- `mm-bot/src/rfq.rs`
- `mm-bot/src/sign.rs`
- `mm-bot/src/config.rs`
- `mm-bot/Cargo.toml`
- `Cargo.toml` (add mm-bot to workspace)

**Scope:** M

---

### Checkpoint 0: Foundation

- [ ] `anchor build`, `cargo build --release`, `npm run build` all pass
- [ ] WS message protocol types compile and round-trip
- [ ] Deribit expiry list and delivery price fetched and parsed from production
- [ ] mm-bot connects to aggregator on both `/ws/rfq` and `/ws/sign` and responds to RFQ + sign requests
- [ ] **Human review before Phase 1**

---

## Phase 1: Solana Program

*Goal: all on-chain instructions implemented, tested, and producing a stable IDL.*

### Task 1.1: Program state accounts and error codes

**Description:** Define all on-chain account structs (`GlobalConfig`, `PositionAccount`, `SettlementPrice`) and all custom error codes. No instructions yet — just the state layer.

**Acceptance criteria:**
- [ ] `GlobalConfig` has `governance_keys: [Pubkey; 5]`, `required_signatures: u8`, `price_poster: Pubkey`, `bump: u8`
- [ ] `PositionAccount` has all fields from spec including `product`, `fixed_price`, `yield_amount`, `nonce: u64`
- [ ] `SettlementPrice` has `token`, `expiry_ts`, `price`, `posted_ts`, `source`, `approvals: [bool; 5]`, `bump`
- [ ] `Product`, `Token`, and `PriceSource` enums defined
- [ ] All error codes in `errors.rs` with descriptive names, including `ExpiryNotAligned`, `SettlementPriceMissing`, `DisputeWindowOpen`, `UnauthorizedPricePoster`
- [ ] `anchor build` produces valid IDL with all account types

**Verification:** `anchor build` succeeds; IDL contains all account types.

**Dependencies:** Task 0.1

**Files:**
- `programs/breezepocket/src/state/mod.rs`
- `programs/breezepocket/src/errors.rs`

**Scope:** S

---

### Task 1.2: `initialize_config` instruction + dual-sig spike

**Description:** Implement `initialize_config` to create the `GlobalConfig` PDA with 5 governance pubkeys and the price poster key. Also write a minimal spike test proving that a single Solana transaction can require two signers (user + MM) where MM is the fee payer — this is the highest architectural risk and must be proven before `open_position` is built.

**Acceptance criteria:**
- [ ] `initialize_config` creates `GlobalConfig` PDA seeded with `b"config"`, storing governance keys and `price_poster`
- [ ] Can only be called once (second call fails with account already exists)
- [ ] Spike test: a transaction with two required signers where signer B is the fee payer succeeds on localnet
- [ ] Spike test: same tx with signer B missing fails
- [ ] Spike test: tx size with dual-sig + 3 SPL token transfers is under 1232 bytes

**Verification:** `anchor test` — all spike and initialize_config tests pass.

**Dependencies:** Task 1.1

**Files:**
- `programs/breezepocket/src/instructions/initialize_config.rs`
- `tests/initialize_config.ts`
- `tests/dual_sig_spike.ts`

**Scope:** M

---

### Task 1.3: `open_position` — account validation and guards

**Description:** Implement the `open_position` instruction context (account validation, PDA derivation) and all `require!` guards. No token transfers yet — instruction can be called and validates correctly, then returns early.

**Acceptance criteria:**
- [ ] PDA seed: `b"position"` + user pubkey + mm pubkey + fixed price (le bytes) + expiry (le bytes) + nonce (le bytes)
- [ ] Guard: `expiry_ts > Clock::now`
- [ ] Guard: `expiry_ts % 86_400 == 28_800` (08:00 UTC), else `ExpiryNotAligned`
- [ ] Guard: `fixed_price > 0`
- [ ] Guard: `amount > 0`
- [ ] Guard: MM must be a signer
- [ ] Guard: user must be a signer
- [ ] Guard: correct token mint for product (SOL for Sell SOL, USDC for Buy SOL)
- [ ] Test: all guards reject correctly with expected error codes

**Verification:** `anchor test` — guard tests pass.

**Dependencies:** Task 1.2

**Files:**
- `programs/breezepocket/src/instructions/open_position.rs`
- `tests/open_position_guards.ts`

**Scope:** M

---

### Task 1.4: `open_position` — token transfers (collateral lock + yield)

**Description:** Add the three SPL/native SOL transfers to `open_position`: user collateral → PDA, MM collateral → PDA, MM yield → user. All three must succeed atomically or the tx reverts.

**Acceptance criteria:**
- [ ] User collateral (SOL lamports or USDC SPL) transferred to PDA
- [ ] MM collateral transferred from MM wallet to PDA
- [ ] Yield transferred from MM wallet to user wallet in same tx
- [ ] `PositionAccount` fields written correctly after transfers
- [ ] Full happy-path test: Sell SOL with SOL collateral succeeds
- [ ] Full happy-path test: Buy SOL with USDC collateral succeeds
- [ ] If any transfer fails, no state change (tx reverts)

**Verification:** `anchor test` — happy-path tests pass; balances verified post-tx.

**Dependencies:** Task 1.3

**Files:**
- `programs/breezepocket/src/instructions/open_position.rs`
- `tests/open_position_happy.ts`

**Scope:** M

---

### Task 1.5: `open_position` — nonce replay protection test

**Description:** Verify that submitting the same `open_position` transaction twice (same user, MM, fixed price, expiry, nonce) fails because the PDA already exists.

**Acceptance criteria:**
- [ ] First call succeeds
- [ ] Second call with identical params fails (account already initialized)
- [ ] Call with same params but different nonce succeeds (new PDA)

**Verification:** `anchor test` — replay tests pass.

**Dependencies:** Task 1.4

**Files:**
- `tests/open_position_replay.ts`

**Scope:** S

---

### Task 1.6: `post_settlement_price` instruction

**Description:** Implement `post_settlement_price`: the `GlobalConfig.price_poster` key creates the `SettlementPrice` PDA for a token and expiry with the Deribit delivery price, `posted_ts = now`, and `source = Poster`. This is the only way a price enters the program outside governance.

**Acceptance criteria:**
- [ ] PDA seed: `b"settlement_price"` + token (u8) + expiry (le bytes)
- [ ] Signer must equal `GlobalConfig.price_poster`, else `UnauthorizedPricePoster`
- [ ] `expiry_ts` must be 08:00 UTC, else `ExpiryNotAligned`
- [ ] `price > 0`
- [ ] Second post for the same token + expiry fails (account already exists)
- [ ] `posted_ts` set from `Clock`, `source = Poster`

**Verification:** `anchor test` — post tests pass for poster and fail for any other key.

**Dependencies:** Task 1.2

**Files:**
- `programs/breezepocket/src/instructions/post_settlement_price.rs`
- `tests/post_settlement_price.ts`

**Scope:** S

---

### Task 1.7: `settle` instruction

**Description:** Implement `settle`: reads the `SettlementPrice` for the position's token and expiry, enforces the dispute window, compares the price to the fixed price, and distributes collateral for both outcomes of both products.

**Acceptance criteria:**
- [ ] Fails with `NotExpiredYet` if called before `expiry_ts`
- [ ] Fails with `SettlementPriceMissing` if no `SettlementPrice` exists for token + expiry
- [ ] Fails with `DisputeWindowOpen` if `source == Poster` and `now < posted_ts + 1800`
- [ ] No window check when `source == Governance`
- [ ] Sell SOL kept (price < fixed price): user collateral returned to user, MM collateral returned to MM
- [ ] Sell SOL sold (price >= fixed price): user collateral transferred to MM, MM collateral returned to MM
- [ ] Buy SOL kept (price > fixed price): USDC returned to user, MM collateral returned to MM
- [ ] Buy SOL bought (price <= fixed price): USDC transferred to MM, MM collateral returned to MM
- [ ] `position.settled = true` after settlement
- [ ] Fails with `AlreadySettled` on second call
- [ ] Permissionless: any pubkey can call it

**Verification:** `anchor test` — all four outcome × product settlement tests pass, plus the three guard tests.

**Dependencies:** Task 1.4, Task 1.6

**Files:**
- `programs/breezepocket/src/instructions/settle.rs`
- `tests/settle.ts`

**Scope:** L — break if needed

---

### Task 1.8: Governance — `emergency_cancel`

**Description:** Implement `emergency_cancel`: requires 3 of 5 governance signers, returns all collateral to user and MM immediately, marks position settled.

**Acceptance criteria:**
- [ ] 3 of 5 governance keys signed → position cancelled, collateral returned to both parties
- [ ] 2 of 5 signed → fails with `InsufficientGovernanceSignatures`
- [ ] Non-governance pubkey in signers → fails with `UnauthorizedGovernanceSigner`
- [ ] Already-settled position → fails with `AlreadySettled`
- [ ] Works at any time regardless of expiry

**Verification:** `anchor test` — all emergency_cancel tests pass.

**Dependencies:** Task 1.4

**Files:**
- `programs/breezepocket/src/instructions/emergency_cancel.rs`
- `tests/emergency_cancel.ts`

**Scope:** M

---

### Task 1.9: Governance — `override_settlement_price`

**Description:** Implement `override_settlement_price`: requires 3 of 5 governance signers, writes a price to `SettlementPrice` for a given token and expiry (creating the account if the poster never posted), sets `source = Governance`. Verify `settle` uses it immediately with no dispute window.

**Acceptance criteria:**
- [ ] 3 of 5 governance keys signed → `SettlementPrice.price` set, `source = Governance`, `posted_ts` updated
- [ ] Works whether or not a poster price already exists
- [ ] `approvals` array updated correctly
- [ ] 2 of 5 signed → fails with `InsufficientGovernanceSignatures`
- [ ] `settle` immediately after override succeeds (no `DisputeWindowOpen`)
- [ ] `settle` uses the override price, not the earlier poster price

**Verification:** `anchor test` — override set test + settle-with-override test pass.

**Dependencies:** Task 1.7, Task 1.8

**Files:**
- `programs/breezepocket/src/instructions/override_settlement_price.rs`
- `tests/override_settlement_price.ts`

**Scope:** M

---

### Checkpoint 1: Program Complete

- [ ] `anchor test` — all tests pass (no skipped)
- [ ] `anchor build` produces stable IDL
- [ ] All six instructions implemented: `initialize_config`, `open_position`, `post_settlement_price`, `settle`, `emergency_cancel`, `override_settlement_price`
- [ ] Nonce replay, dual-sig, expiry alignment, dispute window, governance, and price override all tested
- [ ] **Human review before Phase 2**

---

## Phase 2: Aggregator + Frontend (parallelizable)

*These two streams depend on the Phase 1 IDL but not on each other. Build in parallel.*

---

### Stream A: Aggregator Server

### Task 2A.1: Axum server skeleton + MM connection manager (dual WS)

**Description:** Set up the Axum HTTP server with `POST /quote`, `POST /confirm`, `GET /expiries`, and `GET /health` routes (stubs). Implement the MM connection manager: each registered MM gets two WS connections — `/ws/rfq` for quote traffic and `/ws/sign` for co-sign requests. Both reconnect independently on disconnect; each falls back to REST if WS cannot be established.

**Acceptance criteria:**
- [ ] Server starts and `GET /health` returns 200
- [ ] Aggregator exposes `/ws/rfq` and `/ws/sign` WS upgrade endpoints
- [ ] MM connection manager opens both connections to mm-bot on startup
- [ ] `/ws/rfq` connection reconnects automatically after disconnect
- [ ] `/ws/sign` connection reconnects automatically after disconnect
- [ ] If either WS cannot connect, falls back to REST for that channel
- [ ] MM list configurable via env/config file

**Verification:** Start aggregator + mm-bot; kill mm-bot; restart mm-bot; verify both WS connections re-established within 5s.

**Dependencies:** Task 1.1 (IDL), Task 0.4 (mm-bot)

**Files:**
- `aggregator/src/main.rs`
- `aggregator/src/mm/mod.rs`
- `aggregator/src/mm/rfq_channel.rs`
- `aggregator/src/mm/sign_channel.rs`
- `aggregator/src/routes/health.rs`

**Scope:** M

---

### Task 2A.2: Expiry list + RFQ broadcast and best-quote selection

**Description:** Implement `GET /expiries` (Deribit-listed SOL expiries as 08:00 UTC timestamps, cached and refreshed hourly) and the `POST /quote` handler: validates the expiry against the list, broadcasts `RfqRequest` to all connected MMs over WS, collects responses, selects highest yield, builds and returns the unsigned `open_position` transaction.

**Acceptance criteria:**
- [ ] `GET /expiries` returns the current list from Task 0.3's fetcher; cached, refreshed at least hourly
- [ ] `POST /quote` accepts `{ product, token, fixed_price, expiry, amount, user_pubkey }`
- [ ] `POST /quote` returns HTTP 400 if `expiry` is not in the current list
- [ ] RFQ broadcast to all connected MMs simultaneously
- [ ] Best yield selected from all responses
- [ ] Unsigned `open_position` transaction built using Anchor IDL client
- [ ] Nonce generated (random u64) and included in tx + response
- [ ] Returns `{ tx_base64, yield_amount, yield_pct, mm_pubkey, nonce }` with HTTP 200
- [ ] Returns HTTP 504 if no MM responds within timeout
- [ ] Test with mm-bot returning a known quote; verify tx is well-formed

**Verification:** `cargo test -p aggregator` — expiry and RFQ tests pass; integration test with mm-bot passes.

**Dependencies:** Task 2A.1, Task 0.3

**Files:**
- `aggregator/src/routes/expiries.rs`
- `aggregator/src/routes/quote.rs`
- `aggregator/src/rfq.rs`

**Scope:** M

---

### Task 2A.3: User-signed tx forwarding + MM co-sign flow

**Description:** Implement `POST /confirm`: receives user-signed tx from frontend, forwards as `SignRequest` to the winning MM over the dedicated `/ws/sign` channel, waits up to 10s for `SignResponse` or `SignRejection`, broadcasts fully co-signed tx if accepted.

**Acceptance criteria:**
- [ ] `POST /confirm` accepts `{ tx_base64, mm_pubkey }`
- [ ] Forwards `SignRequest` to correct MM over its `/ws/sign` channel (not `/ws/rfq`)
- [ ] On `SignResponse`: aggregator broadcasts tx to Solana RPC; returns tx signature with HTTP 200
- [ ] On `SignRejection`: returns HTTP 422 with rejection reason
- [ ] On timeout (10s no response): returns HTTP 504
- [ ] Test: mm-bot accepts → tx broadcast confirmed
- [ ] Test: mm-bot with `--reject` → HTTP 422 returned
- [ ] Test: mm-bot with `--slow` → HTTP 504 after 10s
- [ ] `/ws/rfq` channel is unaffected during a sign request (no cross-channel blocking)

**Verification:** `cargo test -p aggregator` — all three confirm paths tested.

**Dependencies:** Task 2A.2, Task 0.4

**Files:**
- `aggregator/src/routes/confirm.rs`
- `aggregator/src/mm/sign_channel.rs`

**Scope:** M

---

### Task 2A.4: Settlement job

**Description:** Implement the scheduled settlement job. At 08:00 UTC daily it finds every expiry with open positions, fetches the Deribit delivery price, posts it with `post_settlement_price` signed by the price poster key, waits for the dispute window, then calls `settle` for each open position at that expiry. Also exposed as a manual CLI subcommand for reruns.

**Acceptance criteria:**
- [ ] Scheduler fires at 08:00 UTC (configurable for tests)
- [ ] Discovers open positions per expiry by scanning `PositionAccount`s via RPC `getProgramAccounts`
- [ ] Fetches delivery price via Task 0.3's fetcher; retries every 60s for up to 60 minutes on failure; logs at error level if it gives up
- [ ] Skips posting if a `SettlementPrice` already exists for that token + expiry (idempotent)
- [ ] After `posted_ts + 1800`, calls `settle` for each unsettled position; skips already-settled ones; continues past individual failures and reports them
- [ ] `cargo run -- settle --expiry <unix_ts>` runs the same logic once for one expiry
- [ ] Poster keypair loaded from a file path in config; never hardcoded or logged
- [ ] Unit tests cover: price parse, idempotent skip, retry exhaustion, partial settle failure

**Verification:** `cargo test -p aggregator settlement` passes; manual run against localnet with a fake Deribit endpoint settles a seeded position.

**Dependencies:** Task 2A.1, Task 0.3, Checkpoint 1

**Files:**
- `aggregator/src/settlement/deribit.rs`
- `aggregator/src/settlement/job.rs`
- `aggregator/src/main.rs`

**Scope:** M

---

### Stream B: Frontend

### Task 2B.1: Vite + React scaffold + wallet connection

**Description:** Set up the Vite + React + TypeScript app with `@solana/wallet-adapter`. Landing page with wallet connect button. No other pages yet.

**Acceptance criteria:**
- [ ] `npm run dev` serves app locally
- [ ] Wallet connect button works with Phantom on devnet
- [ ] Connected wallet pubkey displayed
- [ ] `npm run build` produces production bundle without errors
- [ ] Zod installed for runtime validation of external data

**Verification:** Open browser, connect Phantom wallet, pubkey shown.

**Dependencies:** Task 0.1

**Files:**
- `app/src/main.tsx`
- `app/src/components/WalletButton.tsx`
- `app/package.json`

**Scope:** S

---

### Task 2B.2: Earn form — product, fixed price, expiry, amount inputs

**Description:** Build the position entry form. All fields with validation. Expiry choices come from `GET /expiries` via a `useExpiries` hook. No quote fetching yet — form validates and shows field errors.

**Acceptance criteria:**
- [ ] Product selector: Sell SOL / Buy SOL
- [ ] Token display (SOL/USDC, derived from product — no picker needed)
- [ ] Fixed price input: numeric, > 0, required
- [ ] Expiry picker: lists only expiries from `GET /expiries`, shown as dates with "08:00 UTC"
- [ ] Amount input: numeric, > 0, required
- [ ] All fields show inline validation errors before submit
- [ ] Form disabled when wallet not connected or expiry list unavailable

**Verification:** `npm run test` — form validation tests pass with a mocked expiry list.

**Dependencies:** Task 2B.1

**Files:**
- `app/src/pages/Earn.tsx`
- `app/src/components/EarnForm.tsx`
- `app/src/hooks/useExpiries.ts`
- `app/src/__tests__/EarnForm.test.tsx`

**Scope:** M

---

### Task 2B.3: Quote fetch hook and display

**Description:** Implement `useQuote` hook: auto-triggers `POST /quote` when all form fields are valid, shows loading state, displays returned yield amount and % yield. Shows the two-outcome description per product and the settlement price source.

**Acceptance criteria:**
- [ ] `useQuote` triggers automatically when all fields are filled and valid
- [ ] Loading spinner shown while fetching
- [ ] Yield (e.g. "0.023 SOL") and % yield displayed on success
- [ ] Two-outcome panel shown per product (no loss framing)
- [ ] Settlement source line shown: "Settles at the Deribit SOL delivery price on <date> 08:00 UTC"
- [ ] If aggregator returns 504 ("no MM available"), error message shown
- [ ] Hook tested with mocked aggregator responses

**Verification:** `npm run test` — useQuote tests pass with mocked aggregator HTTP responses.

**Dependencies:** Task 2B.2

**Files:**
- `app/src/hooks/useQuote.ts`
- `app/src/components/QuoteDisplay.tsx`
- `app/src/__tests__/useQuote.test.ts`

**Scope:** M

---

### Task 2B.4: Transaction signing and confirm flow

**Description:** Implement the confirm flow: user clicks confirm → wallet signs unsigned tx → signed tx POSTed to aggregator `/confirm` → pending state shown while awaiting MM → success or rejection handled.

**Acceptance criteria:**
- [ ] Confirm button triggers wallet signing via `@solana/wallet-adapter`
- [ ] Signed tx sent to aggregator `POST /confirm`
- [ ] "Awaiting market maker confirmation" pending state shown
- [ ] On success: "Position locked" state shown with expiry countdown
- [ ] On MM rejection (422): "Quote rejected by market maker — refetching in 10s" shown; auto-refetches after 10s
- [ ] On timeout (504): same rejection message + auto-refetch
- [ ] Transaction state machine: `idle → quoting → confirming → awaiting_mm → locked | rejected`
- [ ] State machine tested with all transitions

**Verification:** `npm run test` — state machine tests pass.

**Dependencies:** Task 2B.3

**Files:**
- `app/src/hooks/usePosition.ts`
- `app/src/components/ConfirmButton.tsx`
- `app/src/components/PositionStatus.tsx`
- `app/src/__tests__/usePosition.test.ts`

**Scope:** M

---

### Checkpoint 2: Aggregator + Frontend Complete (independently)

- [ ] `cargo test -p aggregator` — all aggregator tests pass
- [ ] `npm run test` — all frontend tests pass
- [ ] Aggregator handles RFQ, co-sign accept, co-sign reject, timeout, and settlement job paths
- [ ] Frontend state machine covers all transitions
- [ ] **Human review before Phase 3**

---

## Phase 3: End-to-End Integration

*Connect all three components on devnet.*

### Task 3.1: Deploy program to devnet + initialize config

**Description:** Deploy the Anchor program to Solana devnet. Run `initialize_config` with 5 test governance keypairs and a test price poster keypair. Verify the program is live and `GlobalConfig` PDA exists.

**Acceptance criteria:**
- [ ] `anchor deploy --provider.cluster devnet` succeeds
- [ ] Program ID saved to `Anchor.toml` and `app/src/lib/program.ts`
- [ ] `initialize_config` called; `GlobalConfig` PDA verified on-chain with governance keys and `price_poster`
- [ ] Governance and poster keypairs stored securely (not committed)

**Verification:** `solana account <GlobalConfig PDA>` shows correct data.

**Dependencies:** Checkpoint 1

**Files:**
- `Anchor.toml`
- `app/src/lib/program.ts`

**Scope:** S

---

### Task 3.2: Full RFQ → sign → confirm → on-chain end-to-end test

**Description:** Run the complete flow on devnet: frontend form → aggregator RFQ → mm-bot quote → user signs → aggregator forwards → mm-bot co-signs → aggregator broadcasts → position account verified on-chain.

**Acceptance criteria:**
- [ ] All components running: devnet program, local aggregator, mm-bot, local frontend
- [ ] Expiry picker shows live Deribit expiries
- [ ] User fills form, quote appears, user confirms via Phantom
- [ ] Position PDA exists on-chain with correct collateral amounts
- [ ] Yield shows in user wallet immediately after confirmation
- [ ] `settled = false` on position account

**Verification:** Manual end-to-end flow with Phantom on devnet.

**Dependencies:** Task 3.1, Checkpoint 2

**Files:** Configuration only

**Scope:** S

---

### Task 3.3: Settlement end-to-end test on devnet

**Description:** Two runs. First, a fast run: open a position at the next 08:00 UTC expiry, then use the manual `settle --expiry` subcommand with the job's fetcher pointed at a fake Deribit endpoint and the dispute window shortened by config, verifying the full post → wait → settle path. Second, a live run: leave a position open across a real Deribit expiry and confirm the scheduled job posts the real delivery price and settles without intervention.

**Acceptance criteria:**
- [ ] Fast run: `SettlementPrice` PDA created by the poster key with the fake price
- [ ] Fast run: `settle` before the window fails with `DisputeWindowOpen`; succeeds after
- [ ] Fast run: collateral distributed correctly per outcome
- [ ] Live run: scheduled job posts the real Deribit delivery price within 60 minutes of 08:00 UTC
- [ ] Live run: position settled with no manual action; `position.settled = true`
- [ ] Observed posting delay recorded in `docs/deribit-settlement.md`

**Verification:** On-chain account state verified post-settlement for both runs.

**Dependencies:** Task 3.2, Task 2A.4

**Files:** Test scripts and config only

**Scope:** M

---

### Task 3.4: Governance flows end-to-end test on devnet

**Description:** Test `emergency_cancel` and `override_settlement_price` on devnet with 3 of 5 real governance keypairs signing.

**Acceptance criteria:**
- [ ] `emergency_cancel` with 3 governance signers returns collateral to both parties
- [ ] `override_settlement_price` sets a price for an expiry the poster has not posted; subsequent `settle` uses it immediately
- [ ] `override_settlement_price` replaces an already-posted poster price
- [ ] Both instructions fail correctly with 2 governance signers
- [ ] `post_settlement_price` from a non-poster key fails with `UnauthorizedPricePoster`

**Verification:** On-chain account state verified after each governance action.

**Dependencies:** Task 3.3

**Files:** Test scripts only

**Scope:** S

---

### Checkpoint 3: End-to-End Complete

- [ ] Full user flow works on devnet with Phantom wallet
- [ ] Settlement job posts the Deribit delivery price and settles positions unattended
- [ ] Governance cancel and settlement price override verified on-chain
- [ ] mm-bot reject and timeout paths verified in UI
- [ ] **Human review — ready for mainnet prep**

---

## Parallel Work Summary

```
Phase 0 (sequential): 0.1 → 0.2 → 0.3 → 0.4
Phase 1 (sequential): 1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6 → 1.7 → 1.8 → 1.9
Phase 2 (parallel streams once Phase 1 IDL is stable):
    Stream A: 2A.1 → 2A.2 → 2A.3 → 2A.4
    Stream B: 2B.1 → 2B.2 → 2B.3 → 2B.4
Phase 3 (sequential): 3.1 → 3.2 → 3.3 → 3.4
```

**Total tasks:** 21 (4 Phase 0 + 9 Phase 1 + 8 Phase 2 + 4 Phase 3 — not counting checkpoints)
