use solana_program::pubkey::Pubkey;

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Side { Long = 0, Short = 1 }

impl Side {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v { 0 => Some(Side::Long), 1 => Some(Side::Short), _ => None }
    }
}

#[derive(Clone)]
pub struct GlobalConfig {
    pub authority: Pubkey,
    pub fee_recipient: Pubkey,
    pub pyth_sol_feed: Pubkey,
    pub sol_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub sol_vault: Pubkey,
    pub usdc_reserve: Pubkey,
    pub is_paused: bool,
    pub max_leverage: u64,
    pub liquidation_threshold: u64,
    pub protocol_fee_bps: u64,
    pub max_tvl: u64,
    pub total_usdc_borrowed: u64,
    pub total_usdc_reserve: u64,
    pub bump: u8,
    pub program_authority_bump: u8,
    // V2 fields (added by migrate_config)
    pub total_long_oi: u64,
    pub total_short_oi: u64,
    pub psf_balance: u64,
}

impl GlobalConfig {
    pub const V1_SPACE: usize = 275; // Original layout
    pub const INIT_SPACE: usize = 299; // V1 + 3*u64(24)

    pub fn deserialize(data: &[u8]) -> Option<Self> {
        if data.len() < Self::V1_SPACE { return None; }
        let mut o = 0;
        let pk = |d: &[u8], o: &mut usize| -> Pubkey {
            let p = Pubkey::new_from_array(d[*o..*o+32].try_into().unwrap());
            *o += 32; p
        };
        let u64le = |d: &[u8], o: &mut usize| -> u64 {
            let v = u64::from_le_bytes(d[*o..*o+8].try_into().unwrap());
            *o += 8; v
        };
        let authority = pk(data, &mut o);
        let fee_recipient = pk(data, &mut o);
        let pyth_sol_feed = pk(data, &mut o);
        let sol_mint = pk(data, &mut o);
        let usdc_mint = pk(data, &mut o);
        let sol_vault = pk(data, &mut o);
        let usdc_reserve = pk(data, &mut o);
        let is_paused = { let v = data[o]; o += 1; v != 0 };
        let max_leverage = u64le(data, &mut o);
        let liquidation_threshold = u64le(data, &mut o);
        let protocol_fee_bps = u64le(data, &mut o);
        let max_tvl = u64le(data, &mut o);
        let total_usdc_borrowed = u64le(data, &mut o);
        let total_usdc_reserve = u64le(data, &mut o);
        let bump = { let v = data[o]; o += 1; v };
        let program_authority_bump = { let v = data[o]; o += 1; v };

        // V2 fields — default to 0 if account hasn't been migrated yet
        let (total_long_oi, total_short_oi, psf_balance) = if data.len() >= Self::INIT_SPACE {
            (u64le(data, &mut o), u64le(data, &mut o), u64le(data, &mut o))
        } else {
            (0, 0, 0)
        };

        Some(Self {
            authority, fee_recipient, pyth_sol_feed, sol_mint, usdc_mint,
            sol_vault, usdc_reserve, is_paused, max_leverage, liquidation_threshold,
            protocol_fee_bps, max_tvl, total_usdc_borrowed, total_usdc_reserve,
            bump, program_authority_bump, total_long_oi, total_short_oi, psf_balance,
        })
    }

    pub fn serialize_into(&self, buf: &mut [u8]) {
        let mut o = 0;
        let wpk = |b: &mut [u8], o: &mut usize, pk: &Pubkey| {
            b[*o..*o+32].copy_from_slice(pk.as_ref()); *o += 32;
        };
        let wu64 = |b: &mut [u8], o: &mut usize, v: u64| {
            b[*o..*o+8].copy_from_slice(&v.to_le_bytes()); *o += 8;
        };
        wpk(buf, &mut o, &self.authority);
        wpk(buf, &mut o, &self.fee_recipient);
        wpk(buf, &mut o, &self.pyth_sol_feed);
        wpk(buf, &mut o, &self.sol_mint);
        wpk(buf, &mut o, &self.usdc_mint);
        wpk(buf, &mut o, &self.sol_vault);
        wpk(buf, &mut o, &self.usdc_reserve);
        buf[o] = self.is_paused as u8; o += 1;
        wu64(buf, &mut o, self.max_leverage);
        wu64(buf, &mut o, self.liquidation_threshold);
        wu64(buf, &mut o, self.protocol_fee_bps);
        wu64(buf, &mut o, self.max_tvl);
        wu64(buf, &mut o, self.total_usdc_borrowed);
        wu64(buf, &mut o, self.total_usdc_reserve);
        buf[o] = self.bump; o += 1;
        buf[o] = self.program_authority_bump; o += 1;
        // V2 fields
        if buf.len() >= Self::INIT_SPACE {
            buf[o..o+8].copy_from_slice(&self.total_long_oi.to_le_bytes()); o += 8;
            buf[o..o+8].copy_from_slice(&self.total_short_oi.to_le_bytes()); o += 8;
            buf[o..o+8].copy_from_slice(&self.psf_balance.to_le_bytes());
        }
    }
}

#[derive(Clone)]
pub struct Position {
    pub owner: Pubkey,
    pub collateral_amount: u64,
    pub borrow_amount_usdc: u64,
    pub perp_side: Side,
    pub perp_size: u64,
    pub entry_price: u64,
    pub opened_at: i64,
    pub is_open: bool,
    pub bump: u8,
}

impl Position {
    pub const INIT_SPACE: usize = 75; // 32 + 8+8+1+8+8+8+1+1

    pub fn deserialize(data: &[u8]) -> Option<Self> {
        if data.len() < Self::INIT_SPACE { return None; }
        let mut o = 0;
        let owner = Pubkey::new_from_array(data[o..o+32].try_into().unwrap()); o += 32;
        let collateral_amount = u64::from_le_bytes(data[o..o+8].try_into().unwrap()); o += 8;
        let borrow_amount_usdc = u64::from_le_bytes(data[o..o+8].try_into().unwrap()); o += 8;
        let perp_side = Side::from_u8(data[o])?; o += 1;
        let perp_size = u64::from_le_bytes(data[o..o+8].try_into().unwrap()); o += 8;
        let entry_price = u64::from_le_bytes(data[o..o+8].try_into().unwrap()); o += 8;
        let opened_at = i64::from_le_bytes(data[o..o+8].try_into().unwrap()); o += 8;
        let is_open = data[o] != 0; o += 1;
        let bump = data[o];
        Some(Self { owner, collateral_amount, borrow_amount_usdc, perp_side, perp_size, entry_price, opened_at, is_open, bump })
    }

    pub fn serialize_into(&self, buf: &mut [u8]) {
        let mut o = 0;
        buf[o..o+32].copy_from_slice(self.owner.as_ref()); o += 32;
        buf[o..o+8].copy_from_slice(&self.collateral_amount.to_le_bytes()); o += 8;
        buf[o..o+8].copy_from_slice(&self.borrow_amount_usdc.to_le_bytes()); o += 8;
        buf[o] = self.perp_side as u8; o += 1;
        buf[o..o+8].copy_from_slice(&self.perp_size.to_le_bytes()); o += 8;
        buf[o..o+8].copy_from_slice(&self.entry_price.to_le_bytes()); o += 8;
        buf[o..o+8].copy_from_slice(&self.opened_at.to_le_bytes()); o += 8;
        buf[o] = self.is_open as u8; o += 1;
        buf[o] = self.bump;
    }
}

// ===== DFBA Queue Structs =====

/// Single order in a queue shard.
#[derive(Clone)]
pub struct Order {
    pub user: Pubkey,
    pub price: u64,     // 6dp USD
    pub size: u64,      // 6dp notional
    pub timestamp: i64,
}

impl Order {
    pub const SIZE: usize = 56; // 32 + 8 + 8 + 8

    pub fn deserialize(data: &[u8]) -> Option<Self> {
        if data.len() < Self::SIZE { return None; }
        let user = Pubkey::new_from_array(data[0..32].try_into().unwrap());
        let price = u64::from_le_bytes(data[32..40].try_into().unwrap());
        let size = u64::from_le_bytes(data[40..48].try_into().unwrap());
        let timestamp = i64::from_le_bytes(data[48..56].try_into().unwrap());
        Some(Self { user, price, size, timestamp })
    }

    pub fn serialize_into(&self, buf: &mut [u8]) {
        buf[0..32].copy_from_slice(self.user.as_ref());
        buf[32..40].copy_from_slice(&self.price.to_le_bytes());
        buf[40..48].copy_from_slice(&self.size.to_le_bytes());
        buf[48..56].copy_from_slice(&self.timestamp.to_le_bytes());
    }
}

/// Queue shard — holds up to MAX_ORDERS orders.
pub const MAX_ORDERS_PER_SHARD: usize = 85;
pub const ORDER_QUEUE_HEADER: usize = 4; // u32 count

/// Commitment for commit-reveal large orders.
#[derive(Clone)]
pub struct OrderCommitment {
    pub hash: [u8; 32],
    pub side: u8,          // 0=bid, 1=ask
    pub notional: u64,
    pub slot: u64,
    pub revealed: bool,
}

impl OrderCommitment {
    pub const INIT_SPACE: usize = 50; // 32 + 1 + 8 + 8 + 1

    pub fn deserialize(data: &[u8]) -> Option<Self> {
        if data.len() < Self::INIT_SPACE { return None; }
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&data[0..32]);
        let side = data[32];
        let notional = u64::from_le_bytes(data[33..41].try_into().unwrap());
        let slot = u64::from_le_bytes(data[41..49].try_into().unwrap());
        let revealed = data[49] != 0;
        Some(Self { hash, side, notional, slot, revealed })
    }

    pub fn serialize_into(&self, buf: &mut [u8]) {
        buf[0..32].copy_from_slice(&self.hash);
        buf[32] = self.side;
        buf[33..41].copy_from_slice(&self.notional.to_le_bytes());
        buf[41..49].copy_from_slice(&self.slot.to_le_bytes());
        buf[49] = self.revealed as u8;
    }
}
