import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

export const env = {
  rpcUrl: process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
  wsUrl: process.env.WS_URL,
  programId: required("ATOMIC_PERPS_PROGRAM_ID"),
  liquidatorKeypairPath: required("LIQUIDATOR_KEYPAIR_PATH"),
  hermesUrl: process.env.HERMES_URL ?? "https://hermes.pyth.network",
  pythProApiKey: process.env.PYTH_PRO_API_KEY,
  apiPort: Number(process.env.API_PORT ?? 3001),
  liquidatorPollMs: Number(process.env.LIQUIDATOR_POLL_MS ?? 10_000),
  oracleRelayPollMs: Number(process.env.ORACLE_RELAY_POLL_MS ?? 2_000),
  depMonitorPollMs: Number(process.env.DEP_MONITOR_POLL_MS ?? 300_000),
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL,
  crankRpc1: process.env.CRANK_RPC_1,
  crankRpc2: process.env.CRANK_RPC_2,
  crankRpc3: process.env.CRANK_RPC_3,
  jitoTipLamports: Number(process.env.JITO_TIP_LAMPORTS ?? 1_000),
  altAddress: process.env.ALT_ADDRESS,
  circuitBreakerThresholdBps: Number(process.env.CIRCUIT_BREAKER_THRESHOLD_BPS ?? 1500),
  pagerdutyKey: process.env.PAGERDUTY_KEY,
  jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL ?? "https://mainnet.block-engine.jito.wtf",
  jitoBundleEnabled: process.env.JITO_BUNDLE_ENABLED === "true",
};
