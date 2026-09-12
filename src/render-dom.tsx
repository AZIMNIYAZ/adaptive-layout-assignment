/**
 * render-dom.tsx
 * -----------------------------------------------------------------------
 * Deliberately "dumb": this component reads a ResolvedLayout and places
 * absolutely-positioned boxes at the exact coordinates the resolver
 * computed. It never inspects the surface's id/name and never makes a
 * layout decision of its own — that's the whole point of the
 * spec -> resolver -> layout -> renderer separation. Swap this file for
 * render-canvas.ts and nothing upstream needs to change.
 * -----------------------------------------------------------------------
 */
import type { AdSpec } from "./spec";
import type { ResolvedLayout } from "./resolver";
import { FONT_FAMILY_BODY, fontFamilyForRole, fontWeightForRole } from "./measure-text";

interface Props {
  spec: AdSpec;
  layout: ResolvedLayout;
  /** CSS pixels the surface should render at on screen (independent of the surface's native px, which may be e.g. 1920 wide). */
  displayScale?: number;
}

export function ResolvedAdRenderer({ spec, layout, displayScale = 1 }: Props) {
  const byId = new Map(spec.elements.map((e) => [e.id, e]));

  return (
    <div
      className="ad-surface"
      style={{
        position: "relative",
        width: layout.surfaceWidth * displayScale,
        height: layout.surfaceHeight * displayScale,
        overflow: "hidden",
        background: "var(--ad-bg, #EDE8DE)",
        transition: "width 320ms cubic-bezier(0.22,1,0.36,1), height 320ms cubic-bezier(0.22,1,0.36,1)",
      }}
    >
      {layout.elements.map((el) => {
        const spec_el = byId.get(el.id);
        if (!spec_el) return null;

        const commonStyle: React.CSSProperties = {
          position: "absolute",
          left: el.x * displayScale,
          top: el.y * displayScale,
          width: el.width * displayScale,
          height: el.height * displayScale,
          opacity: el.visible ? 1 : 0,
          pointerEvents: el.visible ? "auto" : "none",
          transition:
            "left 320ms cubic-bezier(0.22,1,0.36,1), top 320ms cubic-bezier(0.22,1,0.36,1), " +
            "width 320ms cubic-bezier(0.22,1,0.36,1), height 320ms cubic-bezier(0.22,1,0.36,1), opacity 200ms ease",
        };

        if (!el.visible) {
          return <div key={el.id} style={commonStyle} data-role={spec_el.role} data-dropped="true" />;
        }

        if (spec_el.type === "image") {
          return (
            <img
              key={el.id}
              src={spec_el.src}
              alt={spec_el.alt}
              data-role={spec_el.role}
              style={{ ...commonStyle, objectFit: "contain" }}
              draggable={false}
            />
          );
        }

        if (spec_el.type === "button") {
          return (
            <button
              key={el.id}
              data-role={spec_el.role}
              style={{
                ...commonStyle,
                fontFamily: FONT_FAMILY_BODY,
                fontSize: (el.fontSize ?? 14) * displayScale,
                fontWeight: fontWeightForRole(spec_el.role),
                letterSpacing: "0.01em",
                color: "var(--ad-cta-fg, #F6F3EA)",
                background: "var(--ad-cta-bg, #B5562D)",
                border: "none",
                borderRadius: 4 * displayScale,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              {el.displayText}
            </button>
          );
        }

        // text
        const isPrimary = spec_el.role === "primary";
        return (
          <div
            key={el.id}
            data-role={spec_el.role}
            style={{
              ...commonStyle,
              fontFamily: fontFamilyForRole(spec_el.role),
              fontSize: (el.fontSize ?? 14) * displayScale,
              fontWeight: fontWeightForRole(spec_el.role),
              lineHeight: 1.3,
              color: isPrimary ? "var(--ad-fg, #1C2019)" : "var(--ad-fg-muted, #55594F)",
              display: "flex",
              alignItems: isPrimary ? "flex-start" : "center",
              whiteSpace: "nowrap",
              overflow: "hidden",
            }}
            title={el.truncated ? spec_el.content : undefined}
          >
            {el.displayText}
          </div>
        );
      })}
    </div>
  );
}
