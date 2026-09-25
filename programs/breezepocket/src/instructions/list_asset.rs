use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

use crate::errors::ErrorCode;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ListAssetParams {
    pub symbol: String,
    /// Seconds after 00:00 UTC that every expiry of this asset lands on.
    pub expiry_time_of_day: i64,
}

/// Governance signers are passed as `remaining_accounts`; at least 3 of the 5
/// `GlobalConfig.governance_keys` must have signed. A listing is permanent.
#[derive(Accounts)]
pub struct ListAsset<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    pub asset_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = payer,
        space = 8 + AssetConfig::INIT_SPACE,
        seeds = [ASSET_SEED, asset_mint.key().as_ref()],
        bump,
    )]
    pub asset: Account<'info, AssetConfig>,

    pub system_program: Program<'info, System>,
}

pub fn handle_list_asset(ctx: Context<ListAsset>, params: ListAssetParams) -> Result<()> {
    count_governance_signers(&ctx.accounts.config, ctx.remaining_accounts)?;
    // The asset and USDC legs live in the position's two associated token accounts,
    // which would be the same account if the asset were USDC.
    require_keys_neq!(
        ctx.accounts.asset_mint.key(),
        ctx.accounts.config.usdc_mint,
        ErrorCode::AssetIsUsdc
    );
    let symbol = params.symbol;
    require!(
        !symbol.is_empty()
            && symbol.len() <= MAX_SYMBOL_LEN
            && symbol.bytes().all(|b| b.is_ascii_graphic()),
        ErrorCode::InvalidSymbol
    );
    require!(
        (0..SECONDS_PER_DAY).contains(&params.expiry_time_of_day),
        ErrorCode::InvalidExpiryTimeOfDay
    );

    let asset = &mut ctx.accounts.asset;
    asset.mint = ctx.accounts.asset_mint.key();
    asset.symbol = symbol;
    asset.decimals = ctx.accounts.asset_mint.decimals;
    asset.expiry_time_of_day = params.expiry_time_of_day;
    asset.bump = ctx.bumps.asset;
    Ok(())
}
