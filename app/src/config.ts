export const API_BASE = import.meta.env.VITE_API_BASE ?? (
  typeof window !== "undefined" && window.location.hostname !== "localhost"
    ? "/api"
    : "http://localhost:3001"
);
export const RPC_URL = import.meta.env.VITE_RPC_URL ?? "https://api.mainnet-beta.solana.com";
export const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID ?? "";
