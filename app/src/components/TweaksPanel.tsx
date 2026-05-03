import { ReactNode } from "react";

export interface Tweaks {
  showPositions: boolean;
}

const C = {
  bg:     "#000",
  panel:  "#0a0a0b",
  panel2: "#111114",
  border: "#1a1a1f",
  t1:     "#ffffff",
  t2:     "#8b8b94",
  t3:     "#4a4a52",
  accent: "#e2b85d",
};
const SANS = "Inter, system-ui, sans-serif";

export function TweaksPanel({
  tweaks,
  onChange,
  onClose,
}: {
  tweaks: Tweaks;
  onChange: (patch: Partial<Tweaks>) => void;
  onClose: () => void;
}) {
  return (
    <div style={{
      position: "fixed", bottom: 72, right: 16, zIndex: 200,
      width: 252,
      background: C.panel,
      border: `1px solid ${C.border}`,
      borderRadius: 0,
      boxShadow: "0 12px 40px rgba(0,0,0,0.8)",
      fontFamily: SANS,
      overflow: "hidden",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "11px 16px",
        borderBottom: `1px solid ${C.border}`,
        background: C.panel2,
      }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.t1, letterSpacing: "0.04em", textTransform: "uppercase" }}>
          Tweaks
        </span>
        <button onClick={onClose} style={{
          background: "none", border: "none", color: C.t3, cursor: "pointer",
          fontSize: 16, lineHeight: 1, padding: "2px 4px",
          transition: "color 0.15s",
        }}
          onMouseEnter={e => (e.currentTarget.style.color = C.t1)}
          onMouseLeave={e => (e.currentTarget.style.color = C.t3)}
        >×</button>
      </div>

      {/* Show Positions Table */}
      <div style={{ padding: "12px 16px" }}>
        <div style={{
          fontSize: 9, color: C.t3, textTransform: "uppercase",
          letterSpacing: "0.10em", fontWeight: 600, marginBottom: 10,
        }}>Show Positions Table</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, color: tweaks.showPositions ? C.t1 : C.t2 }}>
            {tweaks.showPositions ? "Visible" : "Hidden"}
          </span>
          <div
            onClick={() => onChange({ showPositions: !tweaks.showPositions })}
            style={{
              width: 34, height: 18, borderRadius: 9,
              background: tweaks.showPositions ? C.accent : C.border,
              position: "relative", cursor: "pointer",
              transition: "background 0.2s", flexShrink: 0,
            }}
          >
            <div style={{
              position: "absolute", top: 2,
              width: 14, height: 14, borderRadius: "50%",
              background: tweaks.showPositions ? "#000" : C.t2,
              left: tweaks.showPositions ? 18 : 2,
              transition: "left 0.2s, background 0.2s",
            }} />
          </div>
        </div>
      </div>
    </div>
  );
}
