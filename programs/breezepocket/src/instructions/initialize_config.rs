use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::ErrorCode;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeConfigParams {
    pub governance_keys: [Pubkey; GOVERNANCE_KEYS],
    pub price_poster: Pubkey,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, GlobalConfig>,

    /// USDC mint used by every position on this deployment.
    pub usdc_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(
    ctx: Context<InitializeConfig>,
    params: InitializeConfigParams,
) -> Result<()> {
    let keys = &params.governance_keys;
    for (i, key) in keys.iter().enumerate() {
        require!(!keys[..i].contains(key), ErrorCode::DuplicateGovernanceKey);
    }

    let config = &mut ctx.accounts.config;
    config.governance_keys = params.governance_keys;
    config.required_signatures = REQUIRED_SIGNATURES;
    config.price_poster = params.price_poster;
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.bump = ctx.bumps.config;
    Ok(())
}
