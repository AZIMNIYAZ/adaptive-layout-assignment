/**
 * surfaces.ts
 * -----------------------------------------------------------------------
 * Describes the *physical/contextual reality* of a place an ad can run —
 * not just a width and height, but the real-world constraints that
 * change what a "correct" layout even means (a thumb has to be able to
 * hit the button; a viewer 10 feet from a TV can't read 14px text).
 *
 * Crucially, nothing in here — or in resolver.ts — ever branches on a
 * surface's *name*. The resolver only ever looks at *classifySurface()*
 * output and the raw constraint fields below. That's what lets an
 * entirely new, never-seen surface profile.
 * -----------------------------------------------------------------------
 */

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type ViewingDistance = "close" | "normal" | "far";

export interface SurfaceProfile {
  /** Human label only — must never be branched on by the resolver. */
  id: string;
  name: string;
  width: number;
  height: number;
  safeArea?: SafeArea;
  /** Minimum square hit target (px) for any interactive element. Required on touch surfaces. */
  minTapTarget?: number;
  /** Minimum legible font size (px) at this surface's viewing distance. */
  minTextSize?: number;
  viewingDistance?: ViewingDistance;
  touchOnly?: boolean;
  /**
   * Print-bleed / broadcast-safe style outer margin that must stay free
   * of all content, distinct from safeArea (interactive vs purely visual
   * safety). Optional, demonstrates the constraint model isn't closed.
   */
  bleed?: number;
}

const ZERO_SAFE_AREA: SafeArea = { top: 0, right: 0, bottom: 0, left: 0 };

export type AspectClass = "tall" | "wide" | "square";

export interface SurfaceClassification {
  aspectClass: AspectClass;
  aspectRatio: number;
  isTouch: boolean;
  isFarViewing: boolean;
  contentBox: { x: number; y: number; width: number; height: number };
}

/**
 * Derives layout-relevant characteristics from a surface's raw numbers.
 * This is the *only* place aspect ratio thresholds live, and it is pure
 * geometry — swap in any surface, known or unknown, and it classifies
 * consistently.
 */
export function classifySurface(surface: SurfaceProfile): SurfaceClassification {
  if (surface.width <= 0 || surface.height <= 0) {
    throw new Error(
      `classifySurface: surface "${surface.id}" has non-positive dimensions (${surface.width}x${surface.height})`
    );
  }

  const ratio = surface.width / surface.height;
  const aspectClass: AspectClass = ratio < 0.8 ? "tall" : ratio > 1.3 ? "wide" : "square";

  const safe = surface.safeArea ?? ZERO_SAFE_AREA;
  const bleed = surface.bleed ?? 0;
  const inset = {
    top: safe.top + bleed,
    right: safe.right + bleed,
    bottom: safe.bottom + bleed,
    left: safe.left + bleed,
  };

  const contentBox = {
    x: inset.left,
    y: inset.top,
    width: Math.max(0, surface.width - inset.left - inset.right),
    height: Math.max(0, surface.height - inset.top - inset.bottom),
  };

  if (contentBox.width === 0 || contentBox.height === 0) {
    throw new Error(
      `classifySurface: surface "${surface.id}" has zero usable content area after safe area / bleed insets`
    );
  }

  return {
    aspectClass,
    aspectRatio: ratio,
    isTouch: Boolean(surface.touchOnly),
    isFarViewing: surface.viewingDistance === "far",
    contentBox,
  };
}

/**
 * The four required demo surfaces, plus a runtime helper elsewhere
 * (App.tsx) lets a fifth, fully custom profile be typed in live — see
 * "Custom surface" in the demo UI, which exercises the exact same
 * resolve() path as these.
 */
export const surfaces: Record<string, SurfaceProfile> = {
  mobilePortrait: {
    id: "mobilePortrait",
    name: "Mobile Interstitial (Portrait)",
    width: 320,
    height: 480,
    safeArea: { top: 24, right: 12, bottom: 24, left: 12 },
    minTapTarget: 44,
    viewingDistance: "close",
    touchOnly: true,
  },
  mobileLandscape: {
    id: "mobileLandscape",
    name: "Mobile Interstitial (Landscape)",
    width: 480,
    height: 270,
    safeArea: { top: 12, right: 16, bottom: 12, left: 16 },
    minTapTarget: 44,
    viewingDistance: "close",
    touchOnly: true,
  },
  broadcastLowerThird: {
    id: "broadcastLowerThird",
    name: "Broadcast Lower-Third",
    width: 1920,
    height: 250,
    safeArea: { top: 8, right: 60, bottom: 8, left: 60 },
    minTextSize: 32,
    viewingDistance: "far",
    bleed: 20,
  },
  retailKiosk: {
    id: "retailKiosk",
    name: "Retail Kiosk (Square)",
    width: 1080,
    height: 1080,
    safeArea: { top: 40, right: 40, bottom: 40, left: 40 },
    minTapTarget: 60,
    touchOnly: true,
    viewingDistance: "normal",
  },
  /**
   * Deliberately the "too little space for all elements at full priority"
   * surface the assignment asks for — modeled on a real constrained
   * format (a small in-store digital shelf tag / micro-kiosk widget,
   * the square-aspect sibling of a 320x50 mobile banner). At this size
   * branding's own region can no longer meet even its default 18x18
   * floor, so it cleanly drops while headline/price/CTA stay intact —
   * see the "square" template + priority-degradation trace in the demo.
   */
  microKiosk: {
    id: "microKiosk",
    name: "Micro Kiosk / Shelf Tag (200x200)",
    width: 200,
    height: 200,
    safeArea: { top: 8, right: 8, bottom: 8, left: 8 },
    minTapTarget: 28,
    touchOnly: true,
    viewingDistance: "close",
  },
};

export const surfaceList: SurfaceProfile[] = Object.values(surfaces);
