import pino from "pino";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { connection, loadKeypair } from "../lib/connection";
import { env } from "../lib/env";
import { fetchPriceUpdateVaa, SOL_USD_FEED_ID } from "../lib/pyth";

const log = pino({ transport: { target: "pino-pretty" } } as any);

/**
 * Posts fresh PriceUpdateV2 accounts on-chain from Hermes.
 *
 * Our on-chain `validate_and_get_price` requires the feed's publish_time to be
 * within 5s of the current slot. Mainnet Pyth normally keeps feeds fresh on
 * its own, so this relay is a belt-and-suspenders service: if liquidator-side
 * txs start failing with OracleStale we can flip this on to force an update
 * before liquidating.
 */
export async function postLatestPriceUpdate(): Promise<string | null> {
  const keypair = loadKeypair();
  const wallet = new Wallet(keypair);
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const receiver = new PythSolanaReceiver({ connection, wallet });

  const vaas = await fetchPriceUpdateVaa(SOL_USD_FEED_ID);
  if (vaas.length === 0) {
    log.warn("hermes returned no VAAs");
    return null;
  }

  const txBuilder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await txBuilder.addPostPriceUpdates(vaas);

  const versionedTxs = await txBuilder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
  });

  let lastSig: string | null = null;
  for (const vt of versionedTxs) {
    const sig = await provider.sendAndConfirm(vt.tx, vt.signers ?? []);
    lastSig = sig;
    log.info({ sig }, "price update posted");
  }
  return lastSig;
}

export async function startOracleRelay(): Promise<void> {
  log.info({ pollMs: env.oracleRelayPollMs }, "oracle-relay starting");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await postLatestPriceUpdate();
    } catch (e) {
      log.error({ err: String(e) }, "relay iteration failed");
    }
    await new Promise((r) => setTimeout(r, env.oracleRelayPollMs));
  }
}

if (require.main === module) {
  startOracleRelay().catch((e) => {
    log.error({ err: String(e) }, "fatal");
    process.exit(1);
  });
}
