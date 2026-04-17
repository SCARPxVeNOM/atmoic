import { createContext, FC, ReactNode, useContext, useState } from "react";

type Mode = "simple" | "standard" | "pro";

interface ModeCtx {
  mode: Mode;
  setMode: (m: Mode) => void;
}

const Ctx = createContext<ModeCtx>({ mode: "simple", setMode: () => {} });

export const ModeProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [mode, setModeRaw] = useState<Mode>(
    () => (localStorage.getItem("ui-mode") as Mode) ?? "simple"
  );
  const setMode = (m: Mode) => {
    localStorage.setItem("ui-mode", m);
    setModeRaw(m);
  };
  return <Ctx.Provider value={{ mode, setMode }}>{children}</Ctx.Provider>;
};

export const useMode = () => useContext(Ctx);
