//! Reads the transaction's own instructions from the instructions sysvar, by hand: the layout is
//! `u16` count, one `u16` offset per instruction, then at each offset a `u16` account count,
//! 33 bytes per account (flags, address), the program id, a `u16` data length and the data. The
//! last two bytes are the index of the instruction now executing.
use anchor_lang::prelude::*;

pub struct TxInstruction {
    pub program_id: Pubkey,
    pub accounts: Vec<Pubkey>,
    pub data: Vec<u8>,
}

fn u16_at(data: &[u8], at: usize) -> Option<usize> {
    Some(u16::from_le_bytes(data.get(at..at + 2)?.try_into().ok()?) as usize)
}

/// Index of the top-level instruction that is executing.
pub fn current_index(sysvar: &[u8]) -> Option<usize> {
    u16_at(sysvar, sysvar.len().checked_sub(2)?)
}

pub fn instruction_at(sysvar: &[u8], index: usize) -> Option<TxInstruction> {
    if index >= u16_at(sysvar, 0)? {
        return None;
    }
    let start = u16_at(sysvar, 2 + index * 2)?;
    let count = u16_at(sysvar, start)?;
    let mut accounts = Vec::with_capacity(count);
    for i in 0..count {
        let at = start + 2 + i * 33 + 1;
        accounts.push(Pubkey::new_from_array(
            sysvar.get(at..at + 32)?.try_into().ok()?,
        ));
    }
    let program_at = start + 2 + count * 33;
    let program_id =
        Pubkey::new_from_array(sysvar.get(program_at..program_at + 32)?.try_into().ok()?);
    let len = u16_at(sysvar, program_at + 32)?;
    let data = sysvar.get(program_at + 34..program_at + 34 + len)?.to_vec();
    Some(TxInstruction {
        program_id,
        accounts,
        data,
    })
}
