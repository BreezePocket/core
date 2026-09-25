//! Settlement prices for listed assets: the poster's post (one per asset and
//! expiry, then the dispute window) and the 3/5 governance override.

use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::*;

#[derive(Accounts)]
#[instruction(expiry_ts: i64)]
pub struct PostAssetSettlementPrice<'info> {
    #[account(mut, address = config.price_poster @ ErrorCode::UnauthorizedPricePoster)]
    pub poster: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Account<'info, AssetConfig>,

    /// One price per (asset, expiry). `init` makes a second post fail.
    #[account(
        init,
        payer = poster,
        space = 8 + AssetSettlementPrice::INIT_SPACE,
        seeds = [ASSET_PRICE_SEED, asset.mint.as_ref(), &expiry_ts.to_le_bytes()],
        bump,
    )]
    pub settlement_price: Account<'info, AssetSettlementPrice>,

    pub system_program: Program<'info, System>,
}

pub fn handle_post_asset_settlement_price(
    ctx: Context<PostAssetSettlementPrice>,
    expiry_ts: i64,
    price: u64,
) -> Result<()> {
    let asset = &ctx.accounts.asset;
    require!(
        is_aligned_expiry_at(expiry_ts, asset.expiry_time_of_day),
        ErrorCode::ExpiryNotAligned
    );
    require!(price > 0, ErrorCode::InvalidFixedPrice);
    let mint = asset.mint;

    let sp = &mut ctx.accounts.settlement_price;
    sp.asset_mint = mint;
    sp.expiry_ts = expiry_ts;
    sp.price = price;
    sp.posted_ts = Clock::get()?.unix_timestamp;
    sp.source = PriceSource::Poster;
    sp.approvals = [false; GOVERNANCE_KEYS];
    sp.bump = ctx.bumps.settlement_price;
    Ok(())
}

#[derive(Accounts)]
#[instruction(expiry_ts: i64)]
pub struct OverrideAssetSettlementPrice<'info> {
    /// Pays rent if the poster never posted. Governance signers go in `remaining_accounts`.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Account<'info, AssetConfig>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + AssetSettlementPrice::INIT_SPACE,
        seeds = [ASSET_PRICE_SEED, asset.mint.as_ref(), &expiry_ts.to_le_bytes()],
        bump,
    )]
    pub settlement_price: Account<'info, AssetSettlementPrice>,

    pub system_program: Program<'info, System>,
}

pub fn handle_override_asset_settlement_price(
    ctx: Context<OverrideAssetSettlementPrice>,
    expiry_ts: i64,
    price: u64,
) -> Result<()> {
    let asset = &ctx.accounts.asset;
    require!(
        is_aligned_expiry_at(expiry_ts, asset.expiry_time_of_day),
        ErrorCode::ExpiryNotAligned
    );
    require!(price > 0, ErrorCode::InvalidFixedPrice);
    let approvals = count_governance_signers(&ctx.accounts.config, ctx.remaining_accounts)?;
    let mint = asset.mint;

    let sp = &mut ctx.accounts.settlement_price;
    sp.asset_mint = mint;
    sp.expiry_ts = expiry_ts;
    sp.price = price;
    sp.posted_ts = Clock::get()?.unix_timestamp;
    sp.source = PriceSource::Governance;
    sp.approvals = approvals;
    sp.bump = ctx.bumps.settlement_price;
    Ok(())
}
