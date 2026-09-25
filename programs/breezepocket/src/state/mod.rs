use anchor_lang::prelude::*;

/// PDA seed prefixes.
pub const CONFIG_SEED: &[u8] = b"config";
pub const POSITION_SEED: &[u8] = b"position";
pub const SETTLEMENT_PRICE_SEED: &[u8] = b"settlement_price";
pub const ASSET_SEED: &[u8] = b"asset";
pub const ASSET_POSITION_SEED: &[u8] = b"asset_position";
pub const ASSET_PRICE_SEED: &[u8] = b"asset_price";

/// Longest symbol a listed asset may carry (e.g. "NVDAon", "POLYMARKET").
pub const MAX_SYMBOL_LEN: usize = 16;

/// Number of governance keys and the threshold that must sign.
pub const GOVERNANCE_KEYS: usize = 5;
pub const REQUIRED_SIGNATURES: u8 = 3;

/// Settle is blocked for this long after a poster-sourced price is posted.
pub const DISPUTE_WINDOW_SECS: i64 = 30 * 60;

/// Expiries must land exactly on 08:00 UTC, the Deribit delivery time.
pub const SECONDS_PER_DAY: i64 = 86_400;
pub const EXPIRY_TIME_OF_DAY: i64 = 8 * 60 * 60;

/// Base units: SOL has 9 decimals, USDC has 6.
pub const LAMPORTS_PER_SOL: u128 = 1_000_000_000;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Product {
    /// User locks SOL, receives yield in SOL, may end up selling SOL at the fixed price.
    SellSol,
    /// User locks USDC, receives yield in USDC, may end up buying SOL at the fixed price.
    BuySol,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Token {
    Sol,
    Usdc,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PriceSource {
    Poster,
    Governance,
}

impl Product {
    /// Collateral token the user locks for this product.
    pub fn collateral_token(&self) -> Token {
        match self {
            Product::SellSol => Token::Sol,
            Product::BuySol => Token::Usdc,
        }
    }

    /// Asset whose settlement price decides the outcome. Both products settle on SOL.
    pub fn underlying(&self) -> Token {
        Token::Sol
    }
}

impl Token {
    pub fn seed_byte(&self) -> u8 {
        match self {
            Token::Sol => 0,
            Token::Usdc => 1,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    /// 3/5 multisig authority list.
    pub governance_keys: [Pubkey; GOVERNANCE_KEYS],
    /// Always 3.
    pub required_signatures: u8,
    /// Key allowed to post Deribit delivery prices.
    pub price_poster: Pubkey,
    /// USDC mint accepted as Buy SOL collateral and as the Sell SOL payment leg.
    pub usdc_mint: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SettlementPrice {
    /// Asset that was priced (SOL for every v1 product).
    pub token: Token,
    /// 08:00 UTC on the expiry date.
    pub expiry_ts: i64,
    /// USDC base units per token; the Deribit delivery price.
    pub price: u64,
    /// When the price was posted; the dispute window starts here.
    pub posted_ts: i64,
    pub source: PriceSource,
    /// Governance override approvals, indexed like `GlobalConfig.governance_keys`.
    pub approvals: [bool; GOVERNANCE_KEYS],
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PositionAccount {
    pub user: Pubkey,
    pub market_maker: Pubkey,
    pub product: Product,
    /// Token the user locked as collateral.
    pub token: Token,
    /// USDC base units per SOL.
    pub fixed_price: u64,
    /// Unix timestamp, must be 08:00 UTC.
    pub expiry_ts: i64,
    /// User collateral in base units of `token`. SOL lamports live on this account;
    /// USDC lives in the position's vault token account.
    pub user_collateral: u64,
    /// The other leg of the exchange, posted by the market maker: USDC for Sell SOL,
    /// SOL lamports for Buy SOL.
    pub mm_collateral: u64,
    /// Paid to the user upfront in `token` base units.
    pub yield_amount: u64,
    /// Replay protection; part of the PDA seed.
    pub nonce: u64,
    pub settled: bool,
    pub bump: u8,
}

/// An SPL token the program can settle besides SOL, listed by governance. Its
/// positions pair the token with USDC exactly as SOL positions do; `Product::SellSol`
/// means "sell the asset" and `Product::BuySol` "buy the asset" for these.
#[account]
#[derive(InitSpace)]
pub struct AssetConfig {
    pub mint: Pubkey,
    /// The symbol the desk and frontend use, e.g. "NVDAon".
    #[max_len(MAX_SYMBOL_LEN)]
    pub symbol: String,
    /// Copied from the mint at listing.
    pub decimals: u8,
    /// Seconds after 00:00 UTC every expiry must land on: 08:00 for assets priced off
    /// Deribit, 20:00 for US equities (the 16:00 New York close).
    pub expiry_time_of_day: i64,
    pub bump: u8,
}

/// A position on a listed asset. Both legs are SPL tokens held in the position's
/// associated token accounts: `asset_mint` and USDC.
#[account]
#[derive(InitSpace)]
pub struct AssetPosition {
    pub user: Pubkey,
    pub market_maker: Pubkey,
    pub asset_mint: Pubkey,
    /// SellSol: the user locks the asset. BuySol: the user locks USDC.
    pub product: Product,
    /// USDC base units per whole asset token.
    pub fixed_price: u64,
    /// Aligned to the asset's `expiry_time_of_day`.
    pub expiry_ts: i64,
    /// User collateral: asset base units (SellSol) or USDC (BuySol).
    pub user_collateral: u64,
    /// The other leg, posted by the market maker: USDC (SellSol) or asset (BuySol).
    pub mm_collateral: u64,
    /// Paid to the user upfront in the collateral token.
    pub yield_amount: u64,
    pub nonce: u64,
    pub settled: bool,
    pub bump: u8,
}

/// Settlement price for a listed asset at one expiry.
#[account]
#[derive(InitSpace)]
pub struct AssetSettlementPrice {
    pub asset_mint: Pubkey,
    pub expiry_ts: i64,
    /// USDC base units per whole token.
    pub price: u64,
    pub posted_ts: i64,
    pub source: PriceSource,
    pub approvals: [bool; GOVERNANCE_KEYS],
    pub bump: u8,
}

/// The exchange happens (sold / bought) when the settlement price crosses the fixed price.
pub fn exchange_happens(product: Product, settlement_price: u64, fixed_price: u64) -> bool {
    match product {
        Product::SellSol => settlement_price >= fixed_price,
        Product::BuySol => settlement_price <= fixed_price,
    }
}

pub fn is_aligned_expiry(expiry_ts: i64) -> bool {
    is_aligned_expiry_at(expiry_ts, EXPIRY_TIME_OF_DAY)
}

/// Expiry lands exactly on `time_of_day` seconds after 00:00 UTC.
pub fn is_aligned_expiry_at(expiry_ts: i64, time_of_day: i64) -> bool {
    expiry_ts > 0 && expiry_ts % SECONDS_PER_DAY == time_of_day
}

/// Market maker collateral for a position: the counter-leg of the exchange.
pub fn mm_collateral_for(product: Product, amount: u64, fixed_price: u64) -> Option<u64> {
    let amount = amount as u128;
    let fixed_price = fixed_price as u128;
    let value = match product {
        // amount lamports of SOL, priced in USDC base units per SOL.
        Product::SellSol => amount
            .checked_mul(fixed_price)?
            .checked_div(LAMPORTS_PER_SOL)?,
        // amount USDC base units buys amount / fixed_price SOL.
        Product::BuySol => amount
            .checked_mul(LAMPORTS_PER_SOL)?
            .checked_div(fixed_price)?,
    };
    u64::try_from(value).ok()
}

/// Market maker collateral for a listed-asset position, where the asset has
/// `decimals` decimals and `fixed_price` is USDC base units per whole token.
pub fn asset_mm_collateral_for(
    product: Product,
    amount: u64,
    fixed_price: u64,
    decimals: u8,
) -> Option<u64> {
    let amount = amount as u128;
    let fixed_price = fixed_price as u128;
    let unit = 10u128.checked_pow(decimals as u32)?;
    let value = match product {
        // amount asset base units, paid for in USDC at the fixed price.
        Product::SellSol => amount.checked_mul(fixed_price)?.checked_div(unit)?,
        // amount USDC base units buys amount / fixed_price whole tokens.
        Product::BuySol => amount.checked_mul(unit)?.checked_div(fixed_price)?,
    };
    u64::try_from(value).ok()
}

/// Counts how many of `signers` are governance keys that actually signed.
/// Errors if any signer is not a governance key. Duplicates are counted once.
pub fn count_governance_signers(
    config: &GlobalConfig,
    accounts: &[AccountInfo],
) -> Result<[bool; GOVERNANCE_KEYS]> {
    let mut approvals = [false; GOVERNANCE_KEYS];
    for account in accounts {
        if !account.is_signer {
            continue;
        }
        match config.governance_keys.iter().position(|k| k == account.key) {
            Some(i) => approvals[i] = true,
            None => return err!(crate::errors::ErrorCode::UnauthorizedGovernanceSigner),
        }
    }
    let count = approvals.iter().filter(|a| **a).count();
    require!(
        count >= config.required_signatures as usize,
        crate::errors::ErrorCode::InsufficientGovernanceSignatures
    );
    Ok(approvals)
}
