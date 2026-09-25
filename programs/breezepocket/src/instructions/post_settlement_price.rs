use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::*;

#[derive(Accounts)]
#[instruction(token: Token, expiry_ts: i64)]
pub struct PostSettlementPrice<'info> {
    #[account(mut, address = config.price_poster @ ErrorCode::UnauthorizedPricePoster)]
    pub poster: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    /// One price per (token, expiry). `init` makes a second post fail.
    #[account(
        init,
        payer = poster,
        space = 8 + SettlementPrice::INIT_SPACE,
        seeds = [SETTLEMENT_PRICE_SEED, &[token.seed_byte()], &expiry_ts.to_le_bytes()],
        bump,
    )]
    pub settlement_price: Account<'info, SettlementPrice>,

    pub system_program: Program<'info, System>,
}

pub fn handle_post_settlement_price(
    ctx: Context<PostSettlementPrice>,
    token: Token,
    expiry_ts: i64,
    price: u64,
) -> Result<()> {
    require!(is_aligned_expiry(expiry_ts), ErrorCode::ExpiryNotAligned);
    require!(price > 0, ErrorCode::InvalidFixedPrice);

    let sp = &mut ctx.accounts.settlement_price;
    sp.token = token;
    sp.expiry_ts = expiry_ts;
    sp.price = price;
    sp.posted_ts = Clock::get()?.unix_timestamp;
    sp.source = PriceSource::Poster;
    sp.approvals = [false; GOVERNANCE_KEYS];
    sp.bump = ctx.bumps.settlement_price;
    Ok(())
}
