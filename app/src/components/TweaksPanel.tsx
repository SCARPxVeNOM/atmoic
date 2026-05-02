import { ReactNode } from "react";

export interface Tweaks {
  accentColor: string;
  showPositions: boolean;
  chartInterval: string;
  maxLeverage: number;
}

const ACCENTS = [
  { label: "Gold",   val: "#e2b85d" },
  { label: "Green",  val: "#22c55e" },
  { label: "Blue",   val: "#58a6ff" },
  { label: "Purple", val: "#a78bfa" },
  { label: "Orange", val: "#f97316" },
];

const INTERVALS = ["1m", "5m", "15m", "1h"];

const C = {
  bg:     "#000",
  panel:  "#0a0a0b",
  panel2: "#111114",
  border: "#1a1a1f",
  t1:     "#ffffff",
  t2:     "#8b8b94",
  t3:     "#4a4a52",
};
const SANS = "Inter, system-ui, sans-serif";
const MONO = "JetBrains Mono, IBM Plex Mono, Geist Mono, monospace";

export function TweaksPanel({
  tweaks,
  onChange,
  onClose,
}: {
  tweaks: Tweaks;
  onChange: (patch: Partial<Tweaks>) => void;
  onClose: () => void;
}) {
  const accent = tweaks.accentColor;

  const Section = ({ label, children }: { label: string; children: ReactNode }) => (
    <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}` }}>
      <div style={{
        fontSize: 9, color: C.t3, textTransform: "uppercase",
        letterSpacing: "0.10em", fontWeight: 600, marginBottom: 10,
      }}>{label}</div>
      {children}
    </div>
  );

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

      {/* Accent Color */}
      <Section label="Accent Color">
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {ACCENTS.map(a => (
            <button
              key={a.val}
              title={a.label}
              onClick={() => onChange({ accentColor: a.val })}
              style={{
                width: 22, height: 22,
                borderRadius: "50%",
                background: a.val,
                border: tweaks.accentColor === a.val
                  ? `2px solid ${C.t1}`
                  : "2px solid transparent",
                cursor: "pointer",
                outline: tweaks.accentColor === a.val ? `1px solid ${a.val}` : "none",
                outlineOffset: 2,
                transition: "outline 0.1s",
                flexShrink: 0,
              }}
            />
          ))}
        </div>
      </Section>

      {/* Chart Interval */}
      <Section label="Chart Interval">
        <div style={{ display: "flex", gap: 1, background: C.border }}>
          {INTERVALS.map(v => {
            const active = tweaks.chartInterval === v;
            return (
              <button key={v} onClick={() => onChange({ chartInterval: v })} style={{
                flex: 1, padding: "7px 0", borderRadius: 0, border: 0,
                background: active ? C.panel2 : C.panel,
                color: active ? accent : C.t3,
                fontSize: 11, fontWeight: 600, fontFamily: MONO,
                cursor: "pointer",
                transition: "color 0.15s, background 0.15s",
                borderBottom: active ? `2px solid ${accent}` : "2px solid transparent",
              }}>{v}</button>
            );
          })}
        </div>
      </Section>

      {/* Show Positions Table */}
      <Section label="Show Positions Table">
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, color: tweaks.showPositions ? C.t1 : C.t2 }}>
            {tweaks.showPositions ? "Visible" : "Hidden"}
          </span>
          <div
            onClick={() => onChange({ showPositions: !tweaks.showPositions })}
            style={{
              width: 34, height: 18, borderRadius: 9,
              background: tweaks.showPositions ? accent : C.border,
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
      </Section>

      {/* Max Leverage Cap */}
      <div style={{ padding: "12px 16px" }}>
        <div style={{
          fontSize: 9, color: C.t3, textTransform: "uppercase",
          letterSpacing: "0.10em", fontWeight: 600, marginBottom: 10,
          display: "flex", justifyContent: "space-between", alignItems: "baseline",
        }}>
          <span>Max Leverage Cap</span>
          <span style={{ fontFamily: MONO, fontSize: 12, color: accent, fontWeight: 700, textTransform: "none" }}>
            {tweaks.maxLeverage}×
          </span>
        </div>
        <input
          type="range" min={5} max={50} step={5}
          value={tweaks.maxLeverage}
          onChange={e => onChange({ maxLeverage: Number(e.target.value) })}
          style={{ width: "100%", accentColor: accent }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: C.t3, fontFamily: MONO, marginTop: 4 }}>
          <span>5×</span><span>50×</span>
        </div>
      </div>
    </div>
  );
}
