/**
 * Trade History — SQLite-backed persistent store for closed position records.
 *
 * Records are added when positions are closed via the /build-tx/close endpoint.
 * Data persists across server restarts, keyed by wallet address.
 */

import Database from "better-sqlite3";
import path from "path";

export interface TradeRecord {
  wallet: string;
  market: string;         // "SOL-PERP", "BTC-PERP", "ETH-PERP"
  side: "Long" | "Short";
  entryPrice: number;     // USD 6dp
  exitPrice: number;      // USD 6dp
  size: number;           // notional USD
  pnl: number;            // realized PnL USD
  collateralType: string; // "SOL", "JLP", "mSOL"
  closeBps: number;       // 10000 = full, 5000 = 50%
  closedAt: number;       // unix timestamp
  txSig?: string;         // transaction signature if available
}

const DB_PATH = path.join(__dirname, "..", "..", "data", "trades.db");

// Ensure data directory exists
import fs from "fs";
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read/write performance
db.pragma("journal_mode = WAL");

// Create trades table if not exists
db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet TEXT NOT NULL,
    market TEXT NOT NULL,
    side TEXT NOT NULL,
    entry_price REAL NOT NULL,
    exit_price REAL NOT NULL,
    size REAL NOT NULL,
    pnl REAL NOT NULL,
    collateral_type TEXT NOT NULL,
    close_bps INTEGER NOT NULL,
    closed_at INTEGER NOT NULL,
    tx_sig TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet);
  CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(closed_at);
`);

// Prepared statements for performance
const insertStmt = db.prepare(`
  INSERT INTO trades (wallet, market, side, entry_price, exit_price, size, pnl, collateral_type, close_bps, closed_at, tx_sig)
  VALUES (@wallet, @market, @side, @entryPrice, @exitPrice, @size, @pnl, @collateralType, @closeBps, @closedAt, @txSig)
`);

const selectByWalletStmt = db.prepare(`
  SELECT wallet, market, side, entry_price, exit_price, size, pnl, collateral_type, close_bps, closed_at, tx_sig
  FROM trades
  WHERE wallet = ?
  ORDER BY closed_at DESC
  LIMIT 200
`);

const countAllStmt = db.prepare(`SELECT COUNT(*) as cnt FROM trades`);

const countByWalletStmt = db.prepare(`SELECT COUNT(*) as cnt FROM trades WHERE wallet = ?`);

function rowToRecord(row: any): TradeRecord {
  return {
    wallet: row.wallet,
    market: row.market,
    side: row.side as "Long" | "Short",
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    size: row.size,
    pnl: row.pnl,
    collateralType: row.collateral_type,
    closeBps: row.close_bps,
    closedAt: row.closed_at,
    txSig: row.tx_sig || undefined,
  };
}

export function recordTrade(record: TradeRecord): void {
  insertStmt.run({
    wallet: record.wallet,
    market: record.market,
    side: record.side,
    entryPrice: record.entryPrice,
    exitPrice: record.exitPrice,
    size: record.size,
    pnl: record.pnl,
    collateralType: record.collateralType,
    closeBps: record.closeBps,
    closedAt: record.closedAt,
    txSig: record.txSig || null,
  });
}

export function getTradeHistory(wallet: string): TradeRecord[] {
  const rows = selectByWalletStmt.all(wallet);
  return rows.map(rowToRecord);
}

export function getAllTradeCount(): number {
  const row = countAllStmt.get() as any;
  return row?.cnt ?? 0;
}

export function getWalletTradeCount(wallet: string): number {
  const row = countByWalletStmt.get(wallet) as any;
  return row?.cnt ?? 0;
}

// Graceful shutdown — close the database
process.on("exit", () => db.close());
