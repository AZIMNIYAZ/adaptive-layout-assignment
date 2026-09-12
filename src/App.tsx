import { useMemo, useState } from "react";
import { surfaces, type SurfaceProfile } from "./surfaces";
import { resolve } from "./resolver";
import { trailAd } from "./demoAd";
import { ResolvedAdRenderer } from "./render-dom";
import { CanvasAdRenderer } from "./render-canvas";
import { createCanvasTextMeasurer } from "./measure-text";

const PREVIEW_BOX = { width: 620, height: 420 };

const PRESET_ORDER: (keyof typeof surfaces)[] = [
  "mobilePortrait",
  "mobileLandscape",
  "broadcastLowerThird",
  "retailKiosk",
  "microKiosk",
];

const PRESET_BADGE: Partial<Record<string, string>> = {
  microKiosk: "intentionally tight — forces degradation",
};

type RendererKind = "dom" | "canvas";

interface CustomSurfaceForm {
  width: number;
  height: number;
  touchOnly: boolean;
  minTapTarget: number;
  farViewing: boolean;
  minTextSize: number;
}

const DEFAULT_CUSTOM: CustomSurfaceForm = {
  width: 600,
  height: 800,
  touchOnly: false,
  minTapTarget: 44,
  farViewing: false,
  minTextSize: 24,
};

const measureText = createCanvasTextMeasurer();

function fitScale(surface: SurfaceProfile): number {
  const s = Math.min(PREVIEW_BOX.width / surface.width, PREVIEW_BOX.height / surface.height, 1.6);
  return Math.max(s, 0.08);
}

function buildCustomSurface(form: CustomSurfaceForm): SurfaceProfile {
  return {
    id: "custom",
    name: `Custom (${form.width}x${form.height})`,
    width: form.width,
    height: form.height,
    safeArea: { top: 12, right: 12, bottom: 12, left: 12 },
    touchOnly: form.touchOnly,
    minTapTarget: form.touchOnly ? form.minTapTarget : undefined,
    viewingDistance: form.farViewing ? "far" : "normal",
    minTextSize: form.farViewing ? form.minTextSize : undefined,
  };
}

export default function App() {
  const [selected, setSelected] = useState<string>("mobilePortrait");
  const [renderer, setRenderer] = useState<RendererKind>("dom");
  const [customForm, setCustomForm] = useState<CustomSurfaceForm>(DEFAULT_CUSTOM);
  const [showTrace, setShowTrace] = useState(true);

  const surface: SurfaceProfile = useMemo(() => {
    if (selected === "custom") return buildCustomSurface(customForm);
    return surfaces[selected];
  }, [selected, customForm]);

  const layout = useMemo(() => resolve(trailAd, surface, { measureText }), [surface]);
  const scale = fitScale(surface);
  const Renderer = renderer === "dom" ? ResolvedAdRenderer : CanvasAdRenderer;

  const droppedCount = layout.elements.filter((e) => !e.visible).length;

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <div>
          <h1 style={styles.h1}>Adaptive Layout Engine</h1>
          <p style={styles.sub}>
            One ad spec, one resolver. Same code path — different surfaces produce genuinely different layouts.
          </p>
        </div>
      </header>

      <div style={styles.pickerRow}>
        {PRESET_ORDER.map((key) => {
          const s = surfaces[key];
          const active = selected === key;
          return (
            <button
              key={key}
              onClick={() => setSelected(key)}
              style={{ ...styles.pickerBtn, ...(active ? styles.pickerBtnActive : {}) }}
            >
              <span style={styles.pickerName}>{s.name}</span>
              <span style={styles.pickerDims}>
                {s.width}×{s.height}
              </span>
              {PRESET_BADGE[key] && <span style={styles.tightBadge}>{PRESET_BADGE[key]}</span>}
            </button>
          );
        })}
        <button
          onClick={() => setSelected("custom")}
          style={{ ...styles.pickerBtn, ...(selected === "custom" ? styles.pickerBtnActive : {}) }}
        >
          <span style={styles.pickerName}>Custom surface</span>
          <span style={styles.pickerDims}>unknown-at-design-time test</span>
        </button>
      </div>

      {selected === "custom" && (
        <div style={styles.customForm}>
          <CustomField label="Width">
            <input
              type="number"
              value={customForm.width}
              min={40}
              max={4000}
              onChange={(e) => setCustomForm({ ...customForm, width: Number(e.target.value) || 1 })}
              style={styles.input}
            />
          </CustomField>
          <CustomField label="Height">
            <input
              type="number"
              value={customForm.height}
              min={20}
              max={4000}
              onChange={(e) => setCustomForm({ ...customForm, height: Number(e.target.value) || 1 })}
              style={styles.input}
            />
          </CustomField>
          <CustomField label="Touch surface">
            <input
              type="checkbox"
              checked={customForm.touchOnly}
              onChange={(e) => setCustomForm({ ...customForm, touchOnly: e.target.checked })}
            />
          </CustomField>
          {customForm.touchOnly && (
            <CustomField label="Min tap target (px)">
              <input
                type="number"
                value={customForm.minTapTarget}
                onChange={(e) => setCustomForm({ ...customForm, minTapTarget: Number(e.target.value) || 0 })}
                style={styles.input}
              />
            </CustomField>
          )}
          <CustomField label="Far viewing distance">
            <input
              type="checkbox"
              checked={customForm.farViewing}
              onChange={(e) => setCustomForm({ ...customForm, farViewing: e.target.checked })}
            />
          </CustomField>
          {customForm.farViewing && (
            <CustomField label="Min text size (px)">
              <input
                type="number"
                value={customForm.minTextSize}
                onChange={(e) => setCustomForm({ ...customForm, minTextSize: Number(e.target.value) || 0 })}
                style={styles.input}
              />
            </CustomField>
          )}
          <p style={styles.customHint}>
            This exact form is the "5th surface, unseen at design time" case — resolve() has never been told
            about a surface with these numbers, and runs the identical code path as the five presets above.
          </p>
        </div>
      )}

      <div style={styles.mainGrid}>
        <div style={styles.previewColumn}>
          <div style={styles.previewToolbar}>
            <div style={styles.rendererToggle}>
              <button
                onClick={() => setRenderer("dom")}
                style={{ ...styles.toggleBtn, ...(renderer === "dom" ? styles.toggleBtnActive : {}) }}
              >
                DOM / CSS
              </button>
              <button
                onClick={() => setRenderer("canvas")}
                style={{ ...styles.toggleBtn, ...(renderer === "canvas" ? styles.toggleBtnActive : {}) }}
              >
                Canvas
              </button>
            </div>
            <span style={styles.meta}>
              {layout.aspectClass} template · scale {scale.toFixed(2)}× · {layout.elements.length - droppedCount}/
              {layout.elements.length} elements visible
            </span>
          </div>

          <div style={styles.previewStage}>
            <Renderer spec={trailAd} layout={layout} displayScale={scale} />
          </div>
        </div>

        <aside style={styles.inspector}>
          <button style={styles.traceToggle} onClick={() => setShowTrace((v) => !v)}>
            {showTrace ? "Hide" : "Show"} resolution trace
          </button>
          {showTrace && (
            <ol style={styles.traceList}>
              {layout.trace.map((line, i) => (
                <li key={i} style={styles.traceLine}>
                  {line}
                </li>
              ))}
            </ol>
          )}

          <h2 style={styles.h2}>Element geometry</h2>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>id</th>
                <th style={styles.th}>priority</th>
                <th style={styles.th}>state</th>
                <th style={styles.th}>box (px)</th>
              </tr>
            </thead>
            <tbody>
              {layout.elements.map((el) => {
                const specEl = trailAd.elements.find((e) => e.id === el.id)!;
                return (
                  <tr key={el.id}>
                    <td style={styles.td}>{el.id}</td>
                    <td style={styles.td}>{specEl.priority}</td>
                    <td style={styles.td}>
                      {el.visible ? (el.truncated ? "truncated" : "visible") : "dropped"}
                    </td>
                    <td style={styles.tdMono}>
                      {el.visible ? `${Math.round(el.width)}×${Math.round(el.height)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </aside>
      </div>
    </div>
  );
}

function CustomField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={styles.customField}>
      <span style={styles.customLabel}>{label}</span>
      {children}
    </label>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: { maxWidth: 1180, margin: "0 auto", padding: "32px 24px 64px" },
  header: { marginBottom: 20 },
  h1: { fontSize: 22, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" },
  sub: { color: "var(--fg-muted)", fontSize: 14, marginTop: 6, maxWidth: 560 },
  pickerRow: { display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 16 },
  pickerBtn: {
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "10px 14px",
    color: "var(--fg)",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: 2,
    textAlign: "left",
    minWidth: 150,
  },
  pickerBtnActive: { borderColor: "var(--accent)", background: "var(--panel-raised)" },
  pickerName: { fontSize: 13, fontWeight: 600 },
  pickerDims: { fontSize: 11, color: "var(--fg-muted)", fontFamily: "ui-monospace, monospace" },
  tightBadge: { fontSize: 10, color: "var(--danger)", marginTop: 2 },
  customForm: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    alignItems: "center",
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "14px 16px",
    marginBottom: 20,
  },
  customField: { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--fg-muted)" },
  customLabel: {},
  customHint: { fontSize: 12, color: "var(--fg-muted)", maxWidth: 260, margin: 0 },
  input: {
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: "var(--fg)",
    padding: "5px 8px",
    width: 90,
    fontSize: 13,
  },
  mainGrid: { display: "grid", gridTemplateColumns: "1fr 340px", gap: 20 },
  previewColumn: { minWidth: 0 },
  previewToolbar: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 },
  rendererToggle: { display: "flex", gap: 4, background: "var(--panel)", padding: 4, borderRadius: 6 },
  toggleBtn: {
    background: "transparent",
    border: "none",
    color: "var(--fg-muted)",
    padding: "6px 10px",
    borderRadius: 4,
    cursor: "pointer",
    fontSize: 12,
  },
  toggleBtnActive: { background: "var(--accent-dim)", color: "#fff" },
  meta: { fontSize: 12, color: "var(--fg-muted)", fontFamily: "ui-monospace, monospace" },
  previewStage: {
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    minHeight: PREVIEW_BOX.height + 48,
  },
  inspector: {
    background: "var(--panel)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: 16,
    alignSelf: "start",
  },
  traceToggle: {
    background: "transparent",
    border: "1px solid var(--border)",
    color: "var(--fg-muted)",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 12,
    cursor: "pointer",
    marginBottom: 10,
  },
  traceList: {
    fontFamily: "ui-monospace, 'SF Mono', monospace",
    fontSize: 11.5,
    lineHeight: 1.5,
    color: "var(--fg-muted)",
    paddingLeft: 18,
    margin: "0 0 18px",
    maxHeight: 220,
    overflowY: "auto",
  },
  traceLine: { marginBottom: 6 },
  h2: { fontSize: 13, fontWeight: 600, margin: "0 0 10px", color: "var(--fg-muted)", textTransform: "none" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
  th: { textAlign: "left", color: "var(--fg-muted)", fontWeight: 500, borderBottom: "1px solid var(--border)", padding: "4px 6px" },
  td: { padding: "6px 6px", borderBottom: "1px solid var(--border)" },
  tdMono: { padding: "6px 6px", borderBottom: "1px solid var(--border)", fontFamily: "ui-monospace, monospace" },
};
