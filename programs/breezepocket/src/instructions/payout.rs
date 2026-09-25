//! Shared collateral distribution used by `settle` and `emergency_cancel`.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token as TokenProgram, TokenAccount, Transfer};

use crate::errors::ErrorCode;
use crate::state::*;

/// Where each leg of the position goes.
pub struct Distribution {
    pub sol_amount: u64,
    pub sol_to_user: bool,
    pub usdc_amount: u64,
    pub usdc_to_user: bool,
}

/// Everyone gets their own collateral back.
pub fn kept(position: &PositionAccount) -> Distribution {
    match position.product {
        Product::SellSol => Distribution {
            sol_amount: position.user_collateral,
            sol_to_user: true,
            usdc_amount: position.mm_collateral,
            usdc_to_user: false,
        },
        Product::BuySol => Distribution {
            sol_amount: position.mm_collateral,
            sol_to_user: false,
            usdc_amount: position.user_collateral,
            usdc_to_user: true,
        },
    }
}

/// The exchange at the fixed price happens: SOL and USDC swap sides.
pub fn exchanged(position: &PositionAccount) -> Distribution {
    let k = kept(position);
    Distribution {
        sol_amount: k.sol_amount,
        sol_to_user: !k.sol_to_user,
        usdc_amount: k.usdc_amount,
        usdc_to_user: !k.usdc_to_user,
    }
}

pub struct PayoutAccounts<'a, 'info> {
    pub position: &'a Account<'info, PositionAccount>,
    pub user: &'a AccountInfo<'info>,
    pub market_maker: &'a AccountInfo<'info>,
    pub vault: &'a AccountInfo<'info>,
    pub vault_amount: u64,
    pub user_usdc_ata: &'a Account<'info, TokenAccount>,
    pub mm_usdc_ata: &'a Account<'info, TokenAccount>,
    pub token_program: &'a Program<'info, TokenProgram>,
}

/// Checks that `info` is the position's USDC associated token account, owned by the
/// SPL token program, and returns its current balance.
pub fn load_vault(info: &AccountInfo, position: &Pubkey, usdc_mint: &Pubkey) -> Result<u64> {
    let expected = anchor_spl::associated_token::get_associated_token_address(position, usdc_mint);
    require_keys_eq!(info.key(), expected, ErrorCode::InvalidVault);
    require_keys_eq!(*info.owner, anchor_spl::token::ID, ErrorCode::InvalidVault);
    let data = info.try_borrow_data()?;
    let mut slice: &[u8] = &data;
    let vault = TokenAccount::try_deserialize(&mut slice)?;
    require_keys_eq!(vault.owner, *position, ErrorCode::InvalidVault);
    require_keys_eq!(vault.mint, *usdc_mint, ErrorCode::InvalidVault);
    Ok(vault.amount)
}

pub fn move_lamports(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    let new_from = from
        .lamports()
        .checked_sub(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    let new_to = to
        .lamports()
        .checked_add(amount)
        .ok_or(ErrorCode::MathOverflow)?;
    **from.try_borrow_mut_lamports()? = new_from;
    **to.try_borrow_mut_lamports()? = new_to;
    Ok(())
}

/// Pays out both legs, then closes the vault and refunds its rent to the market maker.
/// Any USDC sent to the vault beyond the recorded leg goes to the market maker so a
/// stray deposit can never block settlement.
pub fn distribute(accounts: &PayoutAccounts, dist: &Distribution) -> Result<()> {
    let position = accounts.position;
    let position_info = position.to_account_info();

    let seeds: &[&[u8]] = &[
        POSITION_SEED,
        position.user.as_ref(),
        position.market_maker.as_ref(),
        &position.fixed_price.to_le_bytes(),
        &position.expiry_ts.to_le_bytes(),
        &position.nonce.to_le_bytes(),
        &[position.bump],
    ];
    let signer_seeds = &[seeds];

    let usdc_recipient = if dist.usdc_to_user {
        accounts.user_usdc_ata
    } else {
        accounts.mm_usdc_ata
    };
    token::transfer(
        CpiContext::new_with_signer(
            accounts.token_program.to_account_info(),
            Transfer {
                from: accounts.vault.clone(),
                to: usdc_recipient.to_account_info(),
                authority: position_info.clone(),
            },
            signer_seeds,
        ),
        dist.usdc_amount,
    )?;

    let leftover = accounts
        .vault_amount
        .checked_sub(dist.usdc_amount)
        .ok_or(ErrorCode::MathOverflow)?;
    if leftover > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                accounts.token_program.to_account_info(),
                Transfer {
                    from: accounts.vault.clone(),
                    to: accounts.mm_usdc_ata.to_account_info(),
                    authority: position_info.clone(),
                },
                signer_seeds,
            ),
            leftover,
        )?;
    }

    token::close_account(CpiContext::new_with_signer(
        accounts.token_program.to_account_info(),
        CloseAccount {
            account: accounts.vault.clone(),
            destination: accounts.market_maker.clone(),
            authority: position_info.clone(),
        },
        signer_seeds,
    ))?;

    // The SOL leg is moved last. The runtime checks that lamport changes on the
    // accounts passed to a CPI balance among themselves, so debiting the position
    // before the token CPIs (which include the position as authority) would fail.
    let sol_recipient = if dist.sol_to_user {
        accounts.user
    } else {
        accounts.market_maker
    };
    move_lamports(&position_info, sol_recipient, dist.sol_amount)?;
    Ok(())
}
