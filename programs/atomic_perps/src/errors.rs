use solana_program::program_error::ProgramError;

#[repr(u32)]
#[derive(Clone, Copy)]
pub enum AtomicPerpsError {
    OracleStale = 6000,
    OracleConfidenceTooWide = 6001,
    InvalidOracleFeed = 6002,
    ExcessiveLeverage = 6003,
    InsufficientCollateral = 6004,
    PositionUnhealthy = 6005,
    PositionHealthy = 6006,
    PositionNotOpen = 6007,
    TVLCapExceeded = 6008,
    ProtocolPaused = 6009,
    Unauthorized = 6010,
    InvalidProgramId = 6011,
    MathOverflow = 6012,
    InvalidCollateralMint = 6013,
    BadInput = 6014,
    FillsSuspended = 6015,
    QueueFull = 6016,
    CommitmentNotFound = 6017,
    CommitmentAlreadyRevealed = 6018,
    HashMismatch = 6019,
    OrderNotFound = 6020,
    NoBidsOrAsks = 6021,
}

impl From<AtomicPerpsError> for ProgramError {
    #[inline(always)]
    fn from(e: AtomicPerpsError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[macro_export]
macro_rules! ensure {
    ($cond:expr, $err:expr) => {
        if !($cond) {
            return Err($err.into());
        }
    };
}
