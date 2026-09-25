//! breezepocket: retail users commit to sell SOL or buy SOL at a fixed price by a
//! Deribit-aligned expiry and receive yield upfront from a market maker. Both legs
//! are locked in a per-position PDA in one dual-signed transaction and settled
//! permissionlessly against the posted Deribit SOL delivery price.

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
}
