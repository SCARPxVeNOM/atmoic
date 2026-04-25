export interface Tweaks {
  accentColor: string;
  showPositions: boolean;
  chartInterval: string;
  maxLeverage: number;
}

const ACCENTS = [
  { label: "Blue", val: "#58a6ff" },
  { label: "Teal", val: "#3fb68b" },
  { label: "Purple", val: "#a78bfa" },
  { label: "Orange", val: "#f97316" },
];

export function TweaksPanel({
  tweaks,
  onChange,
  onClose,
}: {
  tweaks: Tweaks;
  onChange: (patch: Partial<Tweaks>) => void;
  onClose: () => void;
}) {
  const row = (label: string, child: React.ReactNode) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, color: "#8b949e", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.07em" }}>{label}</div>
      {child}
    </div>
  );

  return (
    <div style={{
      position: "fixed", bottom: 72, right: 16, zIndex: 200,
      width: 240, background: "#161b22",
      border: "1px solid #30363d", borderRadius: 12,
      padding: 16, boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#e6edf3" }}>Tweaks</span>
        <button onClick={onClose} style={{
          background: "none", border: "none", color: "#8b949e", cursor: "pointer", fontSize: 16, lineHeight: 1,
        }}>&times;</button>
      </div>

      {row("Accent Color",
        <div style={{ display: "flex", gap: 8 }}>
          {ACCENTS.map(a => (
            <button key={a.val} title={a.label} onClick={() => onChange({ accentColor: a.val })} style={{
              width: 24, height: 24, borderRadius: "50%", background: a.val,
              border: tweaks.accentColor === a.val ? "2px solid #fff" : "2px solid transparent",
              cursor: "pointer",
            }} />
          ))}
        </div>
      )}

      {row("Chart Interval",
        <div style={{ display: "flex", gap: 6 }}>
          {["1m", "5m", "15m", "1h"].map(v => (
            <button key={v} onClick={() => onChange({ chartInterval: v })} style={{
              flex: 1, padding: "5px 0", borderRadius: 5, border: "1px solid",
              borderColor: tweaks.chartInterval === v ? tweaks.accentColor : "#30363d",
              background: tweaks.chartInterval === v ? `${tweaks.accentColor}20` : "#0d1117",
              color: tweaks.chartInterval === v ? tweaks.accentColor : "#8b949e",
              fontSize: 11, fontWeight: 600, cursor: "pointer",
            }}>{v}</button>
          ))}
        </div>
      )}

      {row("Show Positions Table",
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
          <div onClick={() => onChange({ showPositions: !tweaks.showPositions })} style={{
            width: 32, height: 18, borderRadius: 9,
            background: tweaks.showPositions ? tweaks.accentColor : "#30363d",
            position: "relative", transition: "background 0.2s", flexShrink: 0,
          }}>
            <div style={{
              position: "absolute", top: 2, width: 14, height: 14, borderRadius: "50%", background: "#fff",
              left: tweaks.showPositions ? 16 : 2, transition: "left 0.2s",
            }} />
          </div>
          <span style={{ fontSize: 12, color: tweaks.showPositions ? "#e6edf3" : "#8b949e" }}>
            {tweaks.showPositions ? "Visible" : "Hidden"}
          </span>
        </label>
      )}

      {row("Max Leverage Cap",
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input type="range" min={5} max={50} step={5} value={tweaks.maxLeverage}
            onChange={e => onChange({ maxLeverage: Number(e.target.value) })}
            style={{ flex: 1, accentColor: tweaks.accentColor }} />
          <span style={{
            fontSize: 13, fontFamily: "IBM Plex Mono,monospace", color: tweaks.accentColor,
            fontWeight: 700, minWidth: 32,
          }}>{tweaks.maxLeverage}x</span>
        </div>
      )}
    </div>
  );
}
