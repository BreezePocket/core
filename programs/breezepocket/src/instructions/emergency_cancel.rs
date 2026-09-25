use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token as TokenProgram, TokenAccount};

use super::payout::load_vault;

use super::payout::{self, PayoutAccounts};
use crate::errors::ErrorCode;
use crate::state::*;

/// Governance signers are passed as `remaining_accounts`; at least 3 of the 5
/// `GlobalConfig.governance_keys` must have signed.
#[derive(Accounts)]
pub struct EmergencyCancel<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        mut,
        seeds = [
            POSITION_SEED,
            position.user.as_ref(),
            position.market_maker.as_ref(),
            &position.fixed_price.to_le_bytes(),
            &position.expiry_ts.to_le_bytes(),
            &position.nonce.to_le_bytes(),
        ],
        bump = position.bump,
        constraint = !position.settled @ ErrorCode::AlreadySettled,
    )]
    pub position: Account<'info, PositionAccount>,

    /// CHECK: must equal `position.user`; only receives lamports.
    #[account(mut, address = position.user @ ErrorCode::InvalidCounterparty)]
    pub user: UncheckedAccount<'info>,

    /// CHECK: must equal `position.market_maker`; only receives lamports.
    #[account(mut, address = position.market_maker @ ErrorCode::InvalidCounterparty)]
    pub market_maker: UncheckedAccount<'info>,

    #[account(address = config.usdc_mint @ ErrorCode::InvalidUsdcMint)]
    pub usdc_mint: Account<'info, Mint>,

    /// CHECK: validated in the handler (after the `settled` guard) as the position's
    /// USDC associated token account, so a settled position whose vault was closed
    /// reports `AlreadySettled` rather than a deserialization error.
    #[account(mut)]
    pub position_usdc_vault: UncheckedAccount<'info>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
    )]
    pub user_usdc_ata: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = usdc_mint,
        associated_token::authority = market_maker,
    )]
    pub mm_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, TokenProgram>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_emergency_cancel(ctx: Context<EmergencyCancel>) -> Result<()> {
    let position = &ctx.accounts.position;
    require!(!position.settled, ErrorCode::AlreadySettled);
    let vault_amount = load_vault(
        &ctx.accounts.position_usdc_vault.to_account_info(),
        &position.key(),
        &ctx.accounts.usdc_mint.key(),
    )?;
    count_governance_signers(&ctx.accounts.config, ctx.remaining_accounts)?;

    let dist = payout::kept(position);
    payout::distribute(
        &PayoutAccounts {
            position,
            user: &ctx.accounts.user.to_account_info(),
            market_maker: &ctx.accounts.market_maker.to_account_info(),
            vault: &ctx.accounts.position_usdc_vault.to_account_info(),
            vault_amount,
            user_usdc_ata: &ctx.accounts.user_usdc_ata,
            mm_usdc_ata: &ctx.accounts.mm_usdc_ata,
            token_program: &ctx.accounts.token_program,
        },
        &dist,
    )?;

    ctx.accounts.position.settled = true;
    Ok(())
}
