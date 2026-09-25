use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token as TokenProgram, TokenAccount};

use super::payout::load_vault;

use super::payout::{self, PayoutAccounts};
use crate::errors::ErrorCode;
use crate::state::*;

#[derive(Accounts)]
pub struct Settle<'info> {
    /// Anyone. Pays the fee and, if needed, rent for missing USDC accounts.
    #[account(mut)]
    pub caller: Signer<'info>,

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

    /// CHECK: validated in `load_settlement_price` so a missing account reports
    /// `SettlementPriceMissing` instead of a generic Anchor error.
    pub settlement_price: UncheckedAccount<'info>,

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
        payer = caller,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
    )]
    pub user_usdc_ata: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = usdc_mint,
        associated_token::authority = market_maker,
    )]
    pub mm_usdc_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, TokenProgram>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Reads the `SettlementPrice` PDA for (token, expiry) without letting Anchor
/// short-circuit on a missing account.
pub fn load_settlement_price(
    info: &AccountInfo,
    token: Token,
    expiry_ts: i64,
    program_id: &Pubkey,
) -> Result<SettlementPrice> {
    let (expected, _) = Pubkey::find_program_address(
        &[
            SETTLEMENT_PRICE_SEED,
            &[token.seed_byte()],
            &expiry_ts.to_le_bytes(),
        ],
        program_id,
    );
    require_keys_eq!(info.key(), expected, ErrorCode::SettlementPriceMismatch);
    if info.owner != program_id || info.data_is_empty() {
        return err!(ErrorCode::SettlementPriceMissing);
    }
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let price = SettlementPrice::try_deserialize(&mut slice)?;
    Ok(price)
}

pub fn handle_settle(ctx: Context<Settle>) -> Result<()> {
    let position = &ctx.accounts.position;
    require!(!position.settled, ErrorCode::AlreadySettled);
    let vault_amount = load_vault(
        &ctx.accounts.position_usdc_vault.to_account_info(),
        &position.key(),
        &ctx.accounts.usdc_mint.key(),
    )?;

    let now = Clock::get()?.unix_timestamp;
    require!(now >= position.expiry_ts, ErrorCode::NotExpiredYet);

    let settlement = load_settlement_price(
        &ctx.accounts.settlement_price,
        position.product.underlying(),
        position.expiry_ts,
        ctx.program_id,
    )?;
    if settlement.source == PriceSource::Poster {
        let window_end = settlement
            .posted_ts
            .checked_add(DISPUTE_WINDOW_SECS)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(now >= window_end, ErrorCode::DisputeWindowOpen);
    }

    let dist = if exchange_happens(position.product, settlement.price, position.fixed_price) {
        payout::exchanged(position)
    } else {
        payout::kept(position)
    };

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
