use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token as TokenProgram, TokenAccount};

use crate::errors::ErrorCode;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct OpenParams {
    pub product: Product,
    /// USDC base units per SOL.
    pub fixed_price: u64,
    /// Must be 08:00 UTC on a future date.
    pub expiry_ts: i64,
    /// User collateral in base units of the product's collateral token.
    pub amount: u64,
    /// Yield paid upfront to the user, in USDC base units for both products.
    pub yield_amount: u64,
    /// Random per-quote value; part of the PDA seed so a quote can only be used once.
    pub nonce: u64,
}

#[derive(Accounts)]
#[instruction(params: OpenParams)]
pub struct OpenPosition<'info> {
    /// Fee payer, rent payer, co-signer, and source of MM collateral and yield.
    #[account(mut)]
    pub market_maker: Signer<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        init,
        payer = market_maker,
        space = 8 + PositionAccount::INIT_SPACE,
        seeds = [
            POSITION_SEED,
            user.key().as_ref(),
            market_maker.key().as_ref(),
            &params.fixed_price.to_le_bytes(),
            &params.expiry_ts.to_le_bytes(),
            &params.nonce.to_le_bytes(),
        ],
        bump,
    )]
    pub position: Account<'info, PositionAccount>,

    #[account(address = config.usdc_mint @ ErrorCode::InvalidUsdcMint)]
    pub usdc_mint: Account<'info, Mint>,

    /// Holds the USDC leg of the position until settlement.
    #[account(
        init,
        payer = market_maker,
        associated_token::mint = usdc_mint,
        associated_token::authority = position,
    )]
    pub position_usdc_vault: Account<'info, TokenAccount>,

    /// Created by the market maker if the user has no USDC account yet, so that
    /// settlement can always pay the user in USDC.
    #[account(
        init_if_needed,
        payer = market_maker,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
    )]
    pub user_usdc_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = market_maker,
    )]
    pub mm_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, TokenProgram>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_position(ctx: Context<OpenPosition>, params: OpenParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(params.expiry_ts > now, ErrorCode::ExpiryInPast);
    require!(
        is_aligned_expiry(params.expiry_ts),
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

    let mm_collateral = mm_collateral_for(params.product, params.amount, params.fixed_price)
        .ok_or(ErrorCode::MathOverflow)?;
    require!(mm_collateral > 0, ErrorCode::InvalidAmount);

    let accounts = &ctx.accounts;
    match params.product {
        Product::SellSol => {
            // User SOL -> position PDA.
            system_program::transfer(
                CpiContext::new(
                    accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: accounts.user.to_account_info(),
                        to: accounts.position.to_account_info(),
                    },
                ),
                params.amount,
            )?;
            // MM USDC (payment leg) -> vault.
            token::transfer(
                CpiContext::new(
                    accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: accounts.mm_usdc_ata.to_account_info(),
                        to: accounts.position_usdc_vault.to_account_info(),
                        authority: accounts.market_maker.to_account_info(),
                    },
                ),
                mm_collateral,
            )?;
            // Yield in USDC: MM -> user, upfront. Both products pay the premium in USDC.
            token::transfer(
                CpiContext::new(
                    accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: accounts.mm_usdc_ata.to_account_info(),
                        to: accounts.user_usdc_ata.to_account_info(),
                        authority: accounts.market_maker.to_account_info(),
                    },
                ),
                params.yield_amount,
            )?;
        }
        Product::BuySol => {
            // User USDC -> vault.
            token::transfer(
                CpiContext::new(
                    accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: accounts.user_usdc_ata.to_account_info(),
                        to: accounts.position_usdc_vault.to_account_info(),
                        authority: accounts.user.to_account_info(),
                    },
                ),
                params.amount,
            )?;
            // MM SOL (delivery leg) -> position PDA.
            system_program::transfer(
                CpiContext::new(
                    accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: accounts.market_maker.to_account_info(),
                        to: accounts.position.to_account_info(),
                    },
                ),
                mm_collateral,
            )?;
            // Yield in USDC: MM -> user, upfront.
            token::transfer(
                CpiContext::new(
                    accounts.token_program.to_account_info(),
                    token::Transfer {
                        from: accounts.mm_usdc_ata.to_account_info(),
                        to: accounts.user_usdc_ata.to_account_info(),
                        authority: accounts.market_maker.to_account_info(),
                    },
                ),
                params.yield_amount,
            )?;
        }
    }

    let position = &mut ctx.accounts.position;
    position.user = ctx.accounts.user.key();
    position.market_maker = ctx.accounts.market_maker.key();
    position.product = params.product;
    position.token = params.product.collateral_token();
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
