use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Expiry must be in the future")]
    ExpiryInPast,
    #[msg("Expiry must be exactly 08:00 UTC (Deribit delivery time)")]
    ExpiryNotAligned,
    #[msg("Fixed price must be greater than zero")]
    InvalidFixedPrice,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Yield must be greater than zero")]
    InvalidYield,
    #[msg("User and market maker must be different accounts")]
    SameCounterparty,
    #[msg("Token account does not match the expected mint or owner")]
    InvalidTokenAccount,
    #[msg("USDC mint does not match GlobalConfig")]
    InvalidUsdcMint,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Position has not expired yet")]
    NotExpiredYet,
    #[msg("No settlement price has been posted for this expiry")]
    SettlementPriceMissing,
    #[msg("Settlement price account does not match the expected PDA")]
    SettlementPriceMismatch,
    #[msg("Dispute window is still open for the posted settlement price")]
    DisputeWindowOpen,
    #[msg("Position is already settled")]
    AlreadySettled,
    #[msg("Only the configured price poster may post settlement prices")]
    UnauthorizedPricePoster,
    #[msg("Fewer than the required number of governance keys signed")]
    InsufficientGovernanceSignatures,
    #[msg("A signer is not one of the governance keys")]
    UnauthorizedGovernanceSigner,
    #[msg("Governance keys must be distinct")]
    DuplicateGovernanceKey,
    #[msg("Position vault does not belong to this position")]
    InvalidVault,
    #[msg("Account does not match the position's user or market maker")]
    InvalidCounterparty,
}
