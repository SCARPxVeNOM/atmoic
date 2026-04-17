import { ReactNode, useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-wallets";
import { RPC_URL } from "../config";
import "@solana/wallet-adapter-react-ui/styles.css";

// Cast to any to dodge the React 18 ReactNode | Promise<ReactNode> type clash
// that wallet-adapter's providers produce under @types/react 18.3+.
const ConnProvider = ConnectionProvider as any;
const WalProvider = WalletProvider as any;
const WalModalProvider = WalletModalProvider as any;

export function WalletContextProvider({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  return (
    <ConnProvider endpoint={RPC_URL}>
      <WalProvider wallets={wallets} autoConnect>
        <WalModalProvider>{children}</WalModalProvider>
      </WalProvider>
    </ConnProvider>
  );
}
