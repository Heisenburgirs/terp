use anchor_lang::prelude::*;

use crate::math::MathError;

#[error_code]
pub enum VaultError {
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Risk-increasing actions are paused")]
    Paused,
    #[msg("Invalid parameter")]
    InvalidParameter,

    #[msg("Mint must be a Token-2022 mint")]
    MintNotToken2022,
    #[msg("Mint authority must be revoked")]
    MintAuthorityPresent,
    #[msg("Freeze authority must be absent")]
    FreezeAuthorityPresent,
    #[msg("Mint supply does not match the declared fixed supply")]
    SupplyMismatch,
    #[msg("Mint carries an extension this launchpad does not allow")]
    UnsupportedMintExtension,
    #[msg("Transfer fee must be exactly 1% or 3% with no cap and no pending change")]
    InvalidTransferFee,
    #[msg("Transfer fee config authority must be revoked")]
    TransferFeeAuthorityPresent,
    #[msg("Withdraw-withheld authority must be the launch vault")]
    InvalidWithheldAuthority,
    #[msg("Token metadata must be immutable and stored on the mint")]
    MutableMetadata,
    #[msg("Declared allocations must add up to the supply")]
    AllocationMismatch,
    #[msg("Pool is already set")]
    PoolAlreadySet,
    #[msg("Pool is not owned by the configured swap program")]
    InvalidPool,

    #[msg("Nothing to collect")]
    NothingCollected,
    #[msg("Swap program or instruction is not allowlisted")]
    SwapNotAllowed,
    #[msg("Swap accounts do not include the launch pool")]
    SwapPoolMissing,
    #[msg("Not enough tax collected for a batch yet")]
    ConversionTooSmall,
    #[msg("Conversion must sell the batch the program computed, no more and not much less")]
    ConversionWrongSize,
    #[msg("Conversion cooldown has not elapsed")]
    ConversionCooldown,
    #[msg("Conversion returned no USDC")]
    SlippageExceeded,
    #[msg("Conversion price is too far below the reference price")]
    ConversionPriceTooLow,

    #[msg("Phoenix trader account is not registered for this launch")]
    TraderNotRegistered,
    #[msg("Phoenix trader account is already registered")]
    TraderAlreadyRegistered,
    #[msg("Unexpected Phoenix account")]
    InvalidPhoenixAccount,
    #[msg("Phoenix remaining accounts do not match the exchange trader index")]
    InvalidPhoenixTail,
    #[msg("Phoenix return data is missing or malformed")]
    InvalidPhoenixReturnData,
    #[msg("Mark price is stale")]
    StaleMarkPrice,
    #[msg("Nothing to deploy: no idle USDC above the minimum and no exposure left to open")]
    NothingToDeploy,
    #[msg("Leverage would exceed the policy limit")]
    LeverageTooHigh,
    #[msg("Account is not above the deleverage threshold")]
    NotDeleveragable,
    #[msg("Position is on the wrong side for this launch")]
    WrongPositionSide,
    #[msg("Account is liquidatable; exposure cannot be increased")]
    AccountAtRisk,
    #[msg("A Phoenix withdrawal is already queued for this launch")]
    WithdrawalAlreadyQueued,

    #[msg("Redemption amount is below the minimum or above the balance")]
    RedemptionTooSmall,
    #[msg("Payout is below the requested minimum")]
    PayoutBelowMinimum,
    #[msg("The position could not be reduced enough at the allowed price; try a smaller amount or retry")]
    ReductionIncomplete,
    #[msg("No claim is waiting, or the vault holds no USDC to pay it yet")]
    NothingToPay,
    #[msg("Supply is not zero or claims are still outstanding")]
    SupplyNotZero,
}

impl From<MathError> for Error {
    fn from(e: MathError) -> Self {
        match e {
            MathError::Overflow => VaultError::MathOverflow.into(),
            MathError::ZeroSupply | MathError::ZeroAmount | MathError::AmountExceedsSupply => {
                VaultError::InvalidParameter.into()
            }
        }
    }
}
