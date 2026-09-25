//! breezepocket: retail users commit to sell SOL or buy SOL at a fixed price by a
//! Deribit-aligned expiry and receive yield upfront from a market maker. Both legs
//! are locked in a per-position PDA in one dual-signed transaction and settled
//! permissionlessly against the posted Deribit SOL delivery price.
//!
//! Governance can also list SPL tokens (tokenized equities, wrapped BTC/ETH, ...)
//! as assets. Their positions follow the same flow with both legs held as tokens,
//! each asset keeping its own expiry time of day and settlement prices.

use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::Token;

declare_id!("BeytdpJYSGP1oFRxEiBLkSRGuW6HW3Pk9dqSZCuSteQ9");

#[program]
pub mod breezepocket {
    use super::*;

    /// One-time setup of the governance list, price poster and USDC mint.
    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        params: InitializeConfigParams,
    ) -> Result<()> {
        handle_initialize_config(ctx, params)
    }

    /// Lock user collateral and the market maker's counter-leg atomically and pay
    /// the yield to the user upfront. Requires both the user and MM signatures;
    /// the MM is the fee payer.
    pub fn open_position(ctx: Context<OpenPosition>, params: OpenParams) -> Result<()> {
        handle_open_position(ctx, params)
    }

    /// Price poster records the Deribit delivery price for (token, expiry).
    pub fn post_settlement_price(
        ctx: Context<PostSettlementPrice>,
        token: Token,
        expiry_ts: i64,
        price: u64,
    ) -> Result<()> {
        handle_post_settlement_price(ctx, token, expiry_ts, price)
    }

    /// Permissionless settlement after expiry and the dispute window.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        handle_settle(ctx)
    }

    /// 3/5 governance: return all collateral immediately, ignoring expiry and price.
    pub fn emergency_cancel(ctx: Context<EmergencyCancel>) -> Result<()> {
        handle_emergency_cancel(ctx)
    }

    /// 3/5 governance: set or replace the settlement price with no dispute window.
    pub fn override_settlement_price(
        ctx: Context<OverrideSettlementPrice>,
        token: Token,
        expiry_ts: i64,
        price: u64,
    ) -> Result<()> {
        handle_override_settlement_price(ctx, token, expiry_ts, price)
    }

    /// 3/5 governance: make an SPL token tradable against USDC.
    pub fn list_asset(ctx: Context<ListAsset>, params: ListAssetParams) -> Result<()> {
        handle_list_asset(ctx, params)
    }

    /// `open_position` for a listed asset. Same params; `SellSol` sells the asset,
    /// `BuySol` buys it.
    pub fn open_asset_position(ctx: Context<OpenAssetPosition>, params: OpenParams) -> Result<()> {
        handle_open_asset_position(ctx, params)
    }

    /// Price poster records a listed asset's settlement price for an expiry.
    pub fn post_asset_settlement_price(
        ctx: Context<PostAssetSettlementPrice>,
        expiry_ts: i64,
        price: u64,
    ) -> Result<()> {
        handle_post_asset_settlement_price(ctx, expiry_ts, price)
    }

    /// 3/5 governance: set or replace a listed asset's settlement price.
    pub fn override_asset_settlement_price(
        ctx: Context<OverrideAssetSettlementPrice>,
        expiry_ts: i64,
        price: u64,
    ) -> Result<()> {
        handle_override_asset_settlement_price(ctx, expiry_ts, price)
    }

    /// Permissionless settlement of a listed-asset position.
    pub fn settle_asset_position(ctx: Context<SettleAssetPosition>) -> Result<()> {
        handle_settle_asset_position(ctx)
    }

    /// 3/5 governance: return both legs of a listed-asset position immediately.
    pub fn emergency_cancel_asset_position(ctx: Context<EmergencyCancelAssetPosition>) -> Result<()> {
        handle_emergency_cancel_asset_position(ctx)
    }
}
