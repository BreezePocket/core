use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token as TokenProgram, TokenAccount};

use super::payout::{self, Distribution, TokenLeg};
use super::settle_asset_position::asset_payout_accounts;
use crate::errors::ErrorCode;
use crate::state::*;

// Governance signers are passed as `remaining_accounts`; at least 3 of the 5
// `GlobalConfig.governance_keys` must have signed.
asset_payout_accounts!(EmergencyCancelAssetPosition, payer,);

pub fn handle_emergency_cancel_asset_position(
    ctx: Context<EmergencyCancelAssetPosition>,
) -> Result<()> {
    require!(!ctx.accounts.position.settled, ErrorCode::AlreadySettled);
    count_governance_signers(&ctx.accounts.config, ctx.remaining_accounts)?;
    let p = &ctx.accounts.position;
    let dist = payout::kept_legs(p.product, p.user_collateral, p.mm_collateral);
    ctx.accounts.pay_out(dist)
}
