# breezepocket

Solana program for breezepocket: retail users commit to **sell SOL** or **buy SOL** at a
fixed price by a Deribit-aligned expiry and receive yield upfront from a market maker.
Both legs are locked in a per-position PDA in a single transaction signed by the user
and the market maker, and settled permissionlessly against the posted Deribit SOL
delivery price. Specification and plan live in `docs/`.

Program ID (all clusters): `BeytdpJYSGP1oFRxEiBLkSRGuW6HW3Pk9dqSZCuSteQ9`

## Layout

```
programs/breezepocket/src
  lib.rs                      instruction entrypoints
  state/mod.rs                GlobalConfig, PositionAccount, SettlementPrice, helpers
  errors.rs                   error codes
  instructions/
    initialize_config.rs      one-time governance list, price poster, USDC mint
    open_position.rs          dual-signed atomic lock + upfront yield (MM pays fee + rent)
    post_settlement_price.rs  price poster records the Deribit delivery price
    settle.rs                 permissionless settlement after the dispute window
    emergency_cancel.rs       3/5 governance returns both legs
    override_settlement_price.rs  3/5 governance sets the price, no dispute window
    payout.rs                 shared distribution logic
tests/                        LiteSVM test suite (in-process SVM with a movable clock)
scripts/                      create-test-usdc, initialize-config, post-settlement-price, settle
```

## Position economics

| | Sell SOL | Buy SOL |
|---|---|---|
| User locks | `amount` SOL | `amount` USDC |
| Market maker locks | `amount × fixed_price` USDC | `amount ÷ fixed_price` SOL |
| Yield paid upfront to user | SOL | USDC |
| kept (price below / above fixed) | SOL back to user, USDC back to MM | USDC back to user, SOL back to MM |
| sold / bought (price crosses fixed) | SOL to MM, USDC to user | USDC to MM, SOL to user |

Prices are USDC base units per SOL (6 decimals). SOL legs are held as lamports on the
position PDA; USDC legs in the position's associated token account, which is closed at
settlement and its rent refunded to the market maker. Any USDC sent to the vault beyond
the recorded leg goes to the market maker so a stray deposit can never block settlement.

## Build and test

The bundled Solana platform-tools (v1.51, cargo 1.84) cannot read the edition-2024
crates that Anchor 0.32 pulls in, so the SBF build pins platform-tools v1.53 and the IDL
is generated in a second step:

```bash
npm install
npm run build          # anchor build --no-idl -- --tools-version v1.53 && anchor idl build
npm test               # 51 LiteSVM tests: every instruction × every outcome and guard
cargo clippy -p breezepocket -- -D warnings
```

Plain `anchor build` / `anchor test` will fail on the toolchain error until the
platform-tools default catches up; use the npm scripts.

## Devnet deployment (2026-09-08)

| | |
|---|---|
| Program | `BeytdpJYSGP1oFRxEiBLkSRGuW6HW3Pk9dqSZCuSteQ9` (upgrade authority: the deploy wallet) |
| GlobalConfig | `BejjQ3MwvvFwaP3FxyDjj7Cu4gBMrH5Txr5xuCR32THp` |
| Test USDC mint | `GxSfF7CfT3C2Sr7RYFwXoRHmhFeH4DpUVQCDNiktxEFD` (6 decimals, mint authority: the deploy wallet) |
| Price poster | `HrWpKo9dzLTurZh14ArK5XPsZZ1CHQM1SDzpB4j2XdPY` (`keys/price-poster.json`) |
| Governance | `keys/governance-1..5.json` |

The public devnet RPC rate-limits program uploads; deploy through a keyed RPC and pass
`--use-rpc`. HTTP-only RPCs lack `signatureSubscribe`, so the scripts route
subscriptions to `SOLANA_WS` (default `wss://api.devnet.solana.com/`).

## Deploy to a cluster

The deploy wallet needs roughly 3 SOL for program rent. The CLI faucet is rate-limited
(`solana airdrop 1 -u testnet`); https://faucet.solana.com is the alternative.

```bash
anchor deploy --provider.cluster devnet          # or testnet
# if the upload stalls on rate limits, resume from the buffer it created:
solana program deploy target/deploy/breezepocket.so \
  --program-id target/deploy/breezepocket-keypair.json --buffer <BUFFER> --use-rpc -u <RPC_URL>
```

Then, once per deployment:

```bash
export SOLANA_RPC=<rpc url>

# 1. Testnet has no canonical USDC: create a 6-decimal test mint and fund the desk + a test user.
npm run create-test-usdc -- --mint-to <MM_PUBKEY>,<USER_PUBKEY> --amount 100000

# 2. Initialize GlobalConfig with 5 governance keys and the price poster (keys/ is gitignored).
npm run init-config -- --usdc-mint <MINT> --generate-keys keys/
#    or with existing public keys:
npm run init-config -- --usdc-mint <MINT> --poster <PK> --governance <PK1>,<PK2>,<PK3>,<PK4>,<PK5>
```

Point the market maker (`MM-system-breezepocket`) at the same RPC, program and mint,
and use its `simulate-user` script to open a position end to end.

## Listed assets

Besides SOL, governance (3 of 5) can list any SPL token as an asset with `list_asset`:
its mint, symbol and the UTC time of day its expiries land on. Its positions
(`open_asset_position` → `AssetPosition`) hold both legs as tokens in the position's two
associated token accounts, take their settlement price from `post_asset_settlement_price`
(or the governance override) keyed by mint and expiry, and settle or emergency-cancel
with the same rules as SOL. USDC itself cannot be listed.

```bash
# create 9-decimal test mints (WALLET is their mint authority), list them, and give the desk inventory
SOLANA_SCAN_RPC=https://api.devnet.solana.com \
  npm run list-assets -- --assets NVDAon@20:00,WBTC@08:00 --mint-to <MM_PUBKEY> --amount 1000000
# settlement for a listed asset
WALLET=keys/price-poster.json npm run post-price -- --asset NVDAon --expiry <unix_ts> --price 181.20
```

On devnet (2026-09-25) the 24 assets the desk prices are listed: WBTC, WETH and the
PreStocks tokens at 08:00 UTC, the Alpaca-priced equities and ETFs at 20:00 UTC.

## Settle a position manually

Until the aggregator's settlement job exists, the two steps it will automate are scripts:

```bash
# at or after 08:00 UTC on the expiry, with the Deribit SOL delivery price
WALLET=keys/price-poster.json npm run post-price -- --expiry <unix_ts> --price 212.35

# 30 minutes later (anyone can call settle)
npm run settle -- --expiry <unix_ts>          # every open position at that expiry, SOL and listed assets
npm run settle -- --position <pubkey>         # one position
```

`SOLANA_RPC` and `WALLET` select the cluster and signer for every script.

## Deviations from the spec worth knowing

- `GlobalConfig` carries a `usdc_mint` field so the program can validate the USDC
  accounts on every cluster (testnet has no canonical USDC).
- The spec's success criterion says sold/bought sends the MM's collateral back to the
  MM. That leaves the user with nothing for their SOL, contradicting the two-outcome
  promise, so the MM collateral is the counter-leg and goes to the user when the
  exchange happens (table above).
- Settlement prices are keyed by the priced asset (SOL) and expiry, not by the
  position's collateral token, so Sell SOL and Buy SOL positions at one expiry share
  one posted price.
