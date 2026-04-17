use solana_program::{
    account_info::AccountInfo,
    entrypoint,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};

solana_program::declare_id!("8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

pub mod constants;
pub mod errors;
pub mod events;
pub mod state;
pub mod instructions;
pub mod utils;

// Precomputed sha256("global:<name>")[..8] — avoids linking hash at runtime.
const DISC_INITIALIZE:  [u8; 8] = [0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed];
const DISC_ATOMIC_OPEN: [u8; 8] = [0x2f, 0xd2, 0xdf, 0xf1, 0x38, 0x86, 0x8a, 0x1c];
const DISC_ATOMIC_CLOSE:[u8; 8] = [0x06, 0x58, 0xa3, 0xce, 0x22, 0x34, 0xb7, 0xe6];
const DISC_LIQUIDATE:   [u8; 8] = [0xdf, 0xb3, 0xe2, 0x7d, 0x30, 0x2e, 0x27, 0x4a];
const DISC_UPDATE_CFG:  [u8; 8] = [0x1d, 0x9e, 0xfc, 0xbf, 0x0a, 0x53, 0xdb, 0x63];
const DISC_MIGRATE_CFG: [u8; 8] = [0x5c, 0x83, 0x3a, 0x69, 0xd2, 0x9a, 0xe0, 0xc1];
#[cfg(feature = "dfba")]
const DISC_EXEC_BATCH:  [u8; 8] = [0x70, 0x9f, 0xd3, 0x33, 0xee, 0x46, 0xd4, 0x3c];
#[cfg(feature = "dfba")]
const DISC_PLACE_ORDER: [u8; 8] = [0x14, 0x3e, 0x08, 0x7e, 0x21, 0xc8, 0x81, 0x90];
#[cfg(feature = "dfba")]
const DISC_CANCEL_ORDER:[u8; 8] = [0x5f, 0x81, 0xed, 0xf0, 0x08, 0x31, 0xdf, 0x84];

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let (d, data) = instruction_data.split_at(8);
    let d8: [u8; 8] = d.try_into().unwrap();

    match d8 {
        DISC_INITIALIZE   => instructions::initialize::process(program_id, accounts, data),
        DISC_ATOMIC_OPEN  => instructions::atomic_open::process(program_id, accounts, data),
        DISC_ATOMIC_CLOSE => instructions::atomic_close::process(program_id, accounts, data),
        DISC_LIQUIDATE    => instructions::liquidate::process(program_id, accounts, data),
        DISC_UPDATE_CFG   => instructions::update_config::process(program_id, accounts, data),
        DISC_MIGRATE_CFG  => instructions::migrate_config::process(program_id, accounts, data),
        #[cfg(feature = "dfba")]
        DISC_EXEC_BATCH   => instructions::execute_batch::process(program_id, accounts, data),
        #[cfg(feature = "dfba")]
        DISC_PLACE_ORDER  => instructions::place_order::process(program_id, accounts, data),
        #[cfg(feature = "dfba")]
        DISC_CANCEL_ORDER => instructions::cancel_order::process(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}
