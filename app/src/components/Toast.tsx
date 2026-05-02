import { createContext, useContext, useState, useCallback, ReactNode } from "react";

type ToastType = "success" | "error" | "warning" | "info";

interface ToastItem {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
}

interface ToastCtx {
  success: (title: string, message?: string) => void;
  error:   (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info:    (title: string, message?: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

const STYLE: Record<ToastType, { accent: string; icon: string; iconBg: string }> = {
  success: { accent: "#22c55e", icon: "✓", iconBg: "rgba(34,197,94,0.12)" },
  error:   { accent: "#ef4444", icon: "✕", iconBg: "rgba(239,68,68,0.12)" },
  warning: { accent: "#d29922", icon: "⚠", iconBg: "rgba(210,153,34,0.12)" },
  info:    { accent: "#e2b85d", icon: "i", iconBg: "rgba(226,184,93,0.10)" },
};

const DURATION = 5000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const push = useCallback((type: ToastType, title: string, message?: string) => {
    const id = Math.random().toString(36).slice(2, 9);
    setToasts(prev => [...prev.slice(-4), { id, type, title, message }]);
    setTimeout(() => dismiss(id), DURATION);
  }, [dismiss]);

  const ctx: ToastCtx = {
    success: (t, m) => push("success", t, m),
    error:   (t, m) => push("error", t, m),
    warning: (t, m) => push("warning", t, m),
    info:    (t, m) => push("info", t, m),
  };

  return (
    <Ctx.Provider value={ctx}>
      {children}
      <div style={{
        position: "fixed", bottom: 20, right: 20, zIndex: 9999,
        display: "flex", flexDirection: "column-reverse", gap: 8,
        pointerEvents: "none",
      }}>
        {toasts.map(t => {
          const s = STYLE[t.type];
          return (
            <div
              key={t.id}
              onClick={() => dismiss(t.id)}
              style={{
                pointerEvents: "all",
                cursor: "pointer",
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                background: "#0a0a0b",
                border: `1px solid #1a1a1f`,
                borderLeft: `3px solid ${s.accent}`,
                borderRadius: 0,
                padding: "11px 14px 11px 12px",
                minWidth: 270,
                maxWidth: 380,
                boxShadow: "0 8px 32px rgba(0,0,0,0.7)",
                animation: "toast-in 0.16s ease",
                fontFamily: "Inter, system-ui, sans-serif",
              }}
            >
              <span style={{
                fontSize: 10, fontWeight: 800, color: s.accent,
                background: s.iconBg, padding: "2px 6px",
                flexShrink: 0, lineHeight: 1.5, letterSpacing: "0.04em",
                marginTop: 1,
              }}>
                {s.icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 12, fontWeight: 600, color: "#ffffff",
                  marginBottom: t.message ? 3 : 0,
                  letterSpacing: "0.01em",
                }}>
                  {t.title}
                </div>
                {t.message && (
                  <div style={{
                    fontSize: 11, color: "#8b8b94", lineHeight: 1.55,
                    wordBreak: "break-word",
                  }}>
                    {t.message}
                  </div>
                )}
              </div>
              <span style={{ fontSize: 10, color: "#4a4a52", flexShrink: 0, marginTop: 2, lineHeight: 1 }}>✕</span>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

export function Spinner({ size = 14, color = "#ffffff" }: { size?: number; color?: string }) {
  return (
    <span style={{
      display: "inline-block",
      width: size,
      height: size,
      border: `2px solid rgba(255,255,255,0.10)`,
      borderTopColor: color,
      borderRadius: "50%",
      animation: "spin 0.65s linear infinite",
      flexShrink: 0,
      verticalAlign: "middle",
    }} />
  );
}
