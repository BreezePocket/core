use anchor_lang::prelude::*;

use crate::errors::ErrorCode;
use crate::state::*;

#[derive(Accounts)]
#[instruction(token: Token, expiry_ts: i64)]
pub struct OverrideSettlementPrice<'info> {
    /// Pays rent if the poster never posted. Governance signers go in `remaining_accounts`.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, GlobalConfig>,

    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + SettlementPrice::INIT_SPACE,
        seeds = [SETTLEMENT_PRICE_SEED, &[token.seed_byte()], &expiry_ts.to_le_bytes()],
        bump,
    )]
    pub settlement_price: Account<'info, SettlementPrice>,

    pub system_program: Program<'info, System>,
}

pub fn handle_override_settlement_price(
    ctx: Context<OverrideSettlementPrice>,
    token: Token,
    expiry_ts: i64,
    price: u64,
) -> Result<()> {
    require!(is_aligned_expiry(expiry_ts), ErrorCode::ExpiryNotAligned);
    require!(price > 0, ErrorCode::InvalidFixedPrice);
    let approvals = count_governance_signers(&ctx.accounts.config, ctx.remaining_accounts)?;

    let sp = &mut ctx.accounts.settlement_price;
    sp.token = token;
    sp.expiry_ts = expiry_ts;
    sp.price = price;
    sp.posted_ts = Clock::get()?.unix_timestamp;
    sp.source = PriceSource::Governance;
    sp.approvals = approvals;
    sp.bump = ctx.bumps.settlement_price;
    Ok(())
}
