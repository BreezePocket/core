use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token as TokenProgram, TokenAccount};

use super::payout::{self, Distribution, TokenLeg};
use crate::errors::ErrorCode;
use crate::state::*;

/// Accounts shared by `settle_asset_position` and `emergency_cancel_asset_position`:
/// the position, both counterparties, and the two vaults with their destinations.
macro_rules! asset_payout_accounts {
    ($name:ident, $payer:ident, $($extra:tt)*) => {
        #[derive(Accounts)]
        pub struct $name<'info> {
            /// Pays the fee and, if needed, rent for missing token accounts.
            #[account(mut)]
            pub $payer: Signer<'info>,

            #[account(seeds = [CONFIG_SEED], bump = config.bump)]
            pub config: Box<Account<'info, GlobalConfig>>,

            #[account(
                mut,
                seeds = [
                    ASSET_POSITION_SEED,
                    position.user.as_ref(),
                    position.market_maker.as_ref(),
                    position.asset_mint.as_ref(),
                    &position.fixed_price.to_le_bytes(),
                    &position.expiry_ts.to_le_bytes(),
                    &position.nonce.to_le_bytes(),
                ],
                bump = position.bump,
                constraint = !position.settled @ ErrorCode::AlreadySettled,
            )]
            pub position: Box<Account<'info, AssetPosition>>,

            $($extra)*

            /// CHECK: must equal `position.user`; only the owner of its token accounts.
            #[account(address = position.user @ ErrorCode::InvalidCounterparty)]
            pub user: UncheckedAccount<'info>,

            /// CHECK: must equal `position.market_maker`; receives the vaults' rent.
            #[account(mut, address = position.market_maker @ ErrorCode::InvalidCounterparty)]
            pub market_maker: UncheckedAccount<'info>,

            #[account(address = position.asset_mint)]
            pub asset_mint: Box<Account<'info, Mint>>,

            #[account(address = config.usdc_mint @ ErrorCode::InvalidUsdcMint)]
            pub usdc_mint: Box<Account<'info, Mint>>,

            /// CHECK: validated in the handler as the position's asset token account,
            /// after the `settled` guard.
            #[account(mut)]
            pub position_asset_vault: UncheckedAccount<'info>,

            /// CHECK: validated in the handler as the position's USDC token account.
            #[account(mut)]
            pub position_usdc_vault: UncheckedAccount<'info>,

            #[account(
                init_if_needed,
                payer = $payer,
                associated_token::mint = asset_mint,
                associated_token::authority = user,
            )]
            pub user_asset_ata: Box<Account<'info, TokenAccount>>,

            #[account(
                init_if_needed,
                payer = $payer,
                associated_token::mint = usdc_mint,
                associated_token::authority = user,
            )]
            pub user_usdc_ata: Box<Account<'info, TokenAccount>>,

            #[account(
                init_if_needed,
                payer = $payer,
                associated_token::mint = asset_mint,
                associated_token::authority = market_maker,
            )]
            pub mm_asset_ata: Box<Account<'info, TokenAccount>>,

            #[account(
                init_if_needed,
                payer = $payer,
                associated_token::mint = usdc_mint,
                associated_token::authority = market_maker,
            )]
            pub mm_usdc_ata: Box<Account<'info, TokenAccount>>,

            pub token_program: Program<'info, TokenProgram>,
            pub associated_token_program: Program<'info, AssociatedToken>,
            pub system_program: Program<'info, System>,
        }

        impl<'info> $name<'info> {
            /// Pays out both legs as `dist` says and marks the position settled.
            pub fn pay_out(&mut self, dist: Distribution) -> Result<()> {
                let asset_vault = self.position_asset_vault.to_account_info();
                let usdc_vault = self.position_usdc_vault.to_account_info();
                payout::distribute_asset(
                    &self.position,
                    &self.market_maker.to_account_info(),
                    &self.token_program,
                    [
                        TokenLeg {
                            vault: &asset_vault,
                            mint: self.asset_mint.key(),
                            amount: dist.asset_amount,
                            to_user: dist.asset_to_user,
                            user_ata: self.user_asset_ata.to_account_info(),
                            mm_ata: self.mm_asset_ata.to_account_info(),
                        },
                        TokenLeg {
                            vault: &usdc_vault,
                            mint: self.usdc_mint.key(),
                            amount: dist.usdc_amount,
                            to_user: dist.usdc_to_user,
                            user_ata: self.user_usdc_ata.to_account_info(),
                            mm_ata: self.mm_usdc_ata.to_account_info(),
                        },
                    ],
                )?;
                self.position.settled = true;
                Ok(())
            }
        }
    };
}
pub(crate) use asset_payout_accounts;

asset_payout_accounts!(
    SettleAssetPosition,
    caller,
    /// CHECK: validated in `load_asset_settlement_price` so a missing account reports
    /// `SettlementPriceMissing` instead of a generic Anchor error.
    pub settlement_price: UncheckedAccount<'info>,
);

/// Reads the `AssetSettlementPrice` PDA for (mint, expiry) without letting Anchor
/// short-circuit on a missing account.
pub fn load_asset_settlement_price(
    info: &AccountInfo,
    mint: &Pubkey,
    expiry_ts: i64,
    program_id: &Pubkey,
) -> Result<AssetSettlementPrice> {
    let (expected, _) = Pubkey::find_program_address(
        &[ASSET_PRICE_SEED, mint.as_ref(), &expiry_ts.to_le_bytes()],
        program_id,
    );
    require_keys_eq!(info.key(), expected, ErrorCode::SettlementPriceMismatch);
    if info.owner != program_id || info.data_is_empty() {
        return err!(ErrorCode::SettlementPriceMissing);
    }
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    AssetSettlementPrice::try_deserialize(&mut slice)
}

pub fn handle_settle_asset_position(ctx: Context<SettleAssetPosition>) -> Result<()> {
    let position = &ctx.accounts.position;
    require!(!position.settled, ErrorCode::AlreadySettled);

    let now = Clock::get()?.unix_timestamp;
    require!(now >= position.expiry_ts, ErrorCode::NotExpiredYet);

    let settlement = load_asset_settlement_price(
        &ctx.accounts.settlement_price,
        &position.asset_mint,
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

    let (product, user_c, mm_c) = (position.product, position.user_collateral, position.mm_collateral);
    let dist = if exchange_happens(product, settlement.price, position.fixed_price) {
        payout::exchanged_legs(product, user_c, mm_c)
    } else {
        payout::kept_legs(product, user_c, mm_c)
    };
    ctx.accounts.pay_out(dist)
}
