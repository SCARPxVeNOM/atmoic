import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { WalletContextProvider } from "./providers/WalletContextProvider";
import { PrivyAuthProvider } from "./providers/PrivyProvider";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PrivyAuthProvider>
      <WalletContextProvider>
        <App />
      </WalletContextProvider>
    </PrivyAuthProvider>
  </React.StrictMode>
);
