use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token as TokenProgram, TokenAccount};

use super::open_position::OpenParams;
use crate::errors::ErrorCode;
use crate::state::*;

/// Same flow as `open_position`, for a listed SPL asset instead of SOL: both legs
/// are token transfers into the position's asset and USDC vaults.
#[derive(Accounts)]
#[instruction(params: OpenParams)]
pub struct OpenAssetPosition<'info> {
    /// Fee payer, rent payer, co-signer, and source of MM collateral and yield.
    #[account(mut)]
    pub market_maker: Signer<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, GlobalConfig>>,

    #[account(seeds = [ASSET_SEED, asset_mint.key().as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, AssetConfig>>,

    #[account(address = asset.mint)]
    pub asset_mint: Box<Account<'info, Mint>>,

    #[account(address = config.usdc_mint @ ErrorCode::InvalidUsdcMint)]
    pub usdc_mint: Box<Account<'info, Mint>>,

    #[account(
        init,
        payer = market_maker,
        space = 8 + AssetPosition::INIT_SPACE,
        seeds = [
            ASSET_POSITION_SEED,
            user.key().as_ref(),
            market_maker.key().as_ref(),
            asset_mint.key().as_ref(),
            &params.fixed_price.to_le_bytes(),
            &params.expiry_ts.to_le_bytes(),
            &params.nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub position: Box<Account<'info, AssetPosition>>,

    /// Holds the asset leg until settlement.
    #[account(
        init,
        payer = market_maker,
        associated_token::mint = asset_mint,
        associated_token::authority = position,
    )]
    pub position_asset_vault: Box<Account<'info, TokenAccount>>,

    /// Holds the USDC leg until settlement.
    #[account(
        init,
        payer = market_maker,
        associated_token::mint = usdc_mint,
        associated_token::authority = position,
    )]
    pub position_usdc_vault: Box<Account<'info, TokenAccount>>,

    /// Created by the market maker if missing so both legs can always be paid out.
    #[account(
        init_if_needed,
        payer = market_maker,
        associated_token::mint = asset_mint,
        associated_token::authority = user,
    )]
    pub user_asset_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = market_maker,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
    )]
    pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        init_if_needed,
        payer = market_maker,
        associated_token::mint = asset_mint,
        associated_token::authority = market_maker,
    )]
    pub mm_asset_ata: Box<Account<'info, TokenAccount>>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = market_maker,
    )]
    pub mm_usdc_ata: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, TokenProgram>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_asset_position(
    ctx: Context<OpenAssetPosition>,
    params: OpenParams,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(params.expiry_ts > now, ErrorCode::ExpiryInPast);
    require!(
        is_aligned_expiry_at(params.expiry_ts, ctx.accounts.asset.expiry_time_of_day),
        ErrorCode::ExpiryNotAligned
    );
    require!(params.fixed_price > 0, ErrorCode::InvalidFixedPrice);
    require!(params.amount > 0, ErrorCode::InvalidAmount);
    require!(params.yield_amount > 0, ErrorCode::InvalidYield);
    require_keys_neq!(
        ctx.accounts.user.key(),
        ctx.accounts.market_maker.key(),
        ErrorCode::SameCounterparty
    );

    let mm_collateral = asset_mm_collateral_for(
        params.product,
        params.amount,
        params.fixed_price,
        ctx.accounts.asset.decimals,
    )
    .ok_or(ErrorCode::MathOverflow)?;
    require!(mm_collateral > 0, ErrorCode::InvalidAmount);

    let a = &ctx.accounts;
    // (user's collateral in, MM's counter-leg in, yield out) per product.
    let (user_from, user_to, mm_from, mm_to, yield_from, yield_to) = match params.product {
        Product::SellSol => (
            &a.user_asset_ata,
            &a.position_asset_vault,
            &a.mm_usdc_ata,
            &a.position_usdc_vault,
            &a.mm_asset_ata,
            &a.user_asset_ata,
        ),
        Product::BuySol => (
            &a.user_usdc_ata,
            &a.position_usdc_vault,
            &a.mm_asset_ata,
            &a.position_asset_vault,
            &a.mm_usdc_ata,
            &a.user_usdc_ata,
        ),
    };
    let token_program = a.token_program.to_account_info();
    spl_transfer(
        &token_program,
        user_from.to_account_info(),
        user_to.to_account_info(),
        a.user.to_account_info(),
        params.amount,
    )?;
    spl_transfer(
        &token_program,
        mm_from.to_account_info(),
        mm_to.to_account_info(),
        a.market_maker.to_account_info(),
        mm_collateral,
    )?;
    spl_transfer(
        &token_program,
        yield_from.to_account_info(),
        yield_to.to_account_info(),
        a.market_maker.to_account_info(),
        params.yield_amount,
    )?;

    let asset_mint = ctx.accounts.asset_mint.key();
    let position = &mut ctx.accounts.position;
    position.user = ctx.accounts.user.key();
    position.market_maker = ctx.accounts.market_maker.key();
    position.asset_mint = asset_mint;
    position.product = params.product;
    position.fixed_price = params.fixed_price;
    position.expiry_ts = params.expiry_ts;
    position.user_collateral = params.amount;
    position.mm_collateral = mm_collateral;
    position.yield_amount = params.yield_amount;
    position.nonce = params.nonce;
    position.settled = false;
    position.bump = ctx.bumps.position;
    Ok(())
}

fn spl_transfer<'info>(
    token_program: &AccountInfo<'info>,
    from: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    token::transfer(
        CpiContext::new(token_program.clone(), token::Transfer { from, to, authority }),
        amount,
    )
}
