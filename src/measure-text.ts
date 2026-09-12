/**
 * measure-text.ts
 * -----------------------------------------------------------------------
 * Bonus: "text-measurement-aware layout" — the resolver's truncation and
 * font-fit decisions are driven by this, not by a fixed characters-per-em
 * guess. We measure against the exact font stack the renderer actually
 * uses, so what the resolver decides will fit is what really fits.
 *
 * `fontFamilyForRole()` is the ONE place that decides which CSS font
 * stack a given content role paints in. The resolver never sees a font
 * name — it only ever passes an element's `Role` into the measurer (see
 * TextMeasurer in resolver.ts) — and both render-dom.tsx and
 * render-canvas.tsx call this same function for their actual paint call.
 * That's what guarantees the font used to *decide* a truncation and the
 * font used to *paint* it can never drift apart again: there both is,
 * and always was, exactly one function that makes this decision.
 * -----------------------------------------------------------------------
 */
import type { TextMeasurer } from "./resolver";
import type { Role } from "./spec";

/**
 * Deliberately just "Georgia, serif" — not a longer fallback chain naming fonts this
 * project never actually loads (no @font-face, no web font link). A chain with names that
 * never resolve gives Canvas 2D's font-matching and the DOM's font-matching two different
 * multi-hop fallbacks to walk, and they aren't guaranteed to land on the same actual font or
 * metrics — that's what silently broke measurement-vs-render agreement here. Georgia is
 * either genuinely installed or falls back to the browser's generic serif the same way in
 * both places, so there's no ambiguous chain left for the two engines to disagree over.
 */
export const FONT_FAMILY_DISPLAY = "Georgia, serif";
export const FONT_FAMILY_BODY =
  '-apple-system, "Inter", "Segoe UI", ui-sans-serif, sans-serif';

/** The only role rendered in the display face today is "primary" (the headline). */
export function fontFamilyForRole(role: Role): string {
  return role === "primary" ? FONT_FAMILY_DISPLAY : FONT_FAMILY_BODY;
}

/**
 * Both renderers render "primary" (headline) and "action" (button label) text semi-bold and
 * everything else at a lighter weight — this is that single decision, shared the same way
 * fontFamilyForRole() is. A bolder weight measures meaningfully wider than normal at the same
 * font/size (confirmed: ~40px wider for this ad's headline at its resolved size), so leaving
 * weight out of the measurer — as this file did until now — understates real text width for
 * every role rendered bold, independent of which font family is in play.
 */
export function fontWeightForRole(role: Role): number {
  return role === "primary" || role === "action" ? 600 : 500;
}

let ctx: CanvasRenderingContext2D | null = null;
function getCtx(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!ctx) {
    const canvas = document.createElement("canvas");
    ctx = canvas.getContext("2d");
  }
  return ctx;
}

export function createCanvasTextMeasurer(): TextMeasurer {
  return (text, fontSizePx, role) => {
    const c = getCtx();
    const resolvedRole = role ?? "secondary";
    const fontFamily = fontFamilyForRole(resolvedRole);
    const fontWeight = fontWeightForRole(resolvedRole);
    if (!c) return { width: text.length * fontSizePx * 0.56, height: fontSizePx * 1.3 };
    c.font = `${fontWeight} ${fontSizePx}px ${fontFamily}`;
    const metrics = c.measureText(text);
    return { width: metrics.width, height: fontSizePx * 1.3 };
  };
}
