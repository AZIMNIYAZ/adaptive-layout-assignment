/**
 * resolver.ts
 * -----------------------------------------------------------------------
 * The engine. Everything else in this repo (spec.ts, surfaces.ts,
 * render-dom.tsx, render-canvas.ts) is plumbing around this file.
 *
 * resolve(spec, surface) -> ResolvedLayout is a pure function:
 *   - it never touches the DOM
 *   - it never branches on a surface's id/name, only on derived
 *     characteristics (aspect class, touch, far-viewing, tap target /
 *     text size floors) — see surfaces.ts#classifySurface
 *   - it never branches on an element's id, only on its role/priority
 *
 * That's what makes the same code path produce genuinely different,
 * correct layouts for a brand-new surface it has never seen, rather
 * than a lookup table of per-surface branches.
 *
 * ---------------------------------------------------------------------
 * ALGORITHM, step by step (see README.md for the prose version):
 *
 *  1. Classify the surface -> tall | wide | square (+ touch/far flags).
 *  2. Pick that aspect class's region TEMPLATE: a fixed set of named
 *     regions, each a fractional (x, y, w, h) rectangle of the content
 *     box, each accepting one or more content ROLES.
 *  3. Assign every spec element to the region matching its role.
 *  4. Compute each element's REQUIRED size: a hard floor derived from
 *     its own authored minimums plus whatever hard constraints the
 *     surface imposes (minTapTarget, minTextSize).
 *  5. Compute each region's available pixel bounds. Where a region is
 *     shared by multiple roles (e.g. price + CTA sharing a row), split
 *     it proportionally by authored weight, in author order.
 *  6. CONTENTION PASS: for any shared region where the active members'
 *     required sizes exceed the space available along the split axis,
 *     drop the lowest-priority member and re-split among the survivors.
 *     Repeat until it fits or one member remains.
 *  7. SAFETY-NET + RECLAMATION PASS: for any element (shared-region or
 *     solo) that still doesn't meet its own hard floor inside its final
 *     region, first try to rescue it by pulling space from a
 *     geometrically adjacent region — genuine idle slack there, or (only
 *     if nothing else works) dropping that region's own least-important
 *     occupant, but only when that occupant is strictly lower-priority
 *     than the element being rescued. If no adjacent region can help at
 *     all, fall back to dropping the globally lowest-priority *active*
 *     element among the deficient ones, and redo steps 5-7. This
 *     guarantees the algorithm always terminates at a non-overlapping,
 *     in-bounds layout even for constraint combinations nobody
 *     explicitly designed for, while keeping a higher-priority element
 *     from being dropped just because a lower-priority one happens to
 *     sit in a differently-sized region.
 *  8. Finalize pixel geometry (+ font sizes, +/- text truncation) and
 *     assert the no-overlap / in-bounds invariant before returning.
 * ---------------------------------------------------------------------
 */

import type { AdElement, AdSpec, Priority, Role } from "./spec";
import {
  classifySurface,
  type AspectClass,
  type SurfaceClassification,
  type SurfaceProfile,
} from "./surfaces";

// ---------------------------------------------------------------------
// Text measurement — injectable so the resolver stays DOM-free and
// testable in plain Node, while the real app (render-dom.tsx) supplies
// an actual Canvas-2D-based measurer for pixel-accurate wrapping /
// truncation decisions (bonus: "text-measurement-aware layout").
// ---------------------------------------------------------------------

/**
 * The resolver only ever knows an element's content `Role` — never a
 * concrete CSS font stack (that mapping is a rendering concern). Passing
 * `role` through lets a real measurer (measure-text.ts) measure against
 * the *same* font each renderer actually paints that role in, so a
 * primary/display-styled headline is measured in the display font, not
 * silently measured in the body font used for everything else.
 */
export type TextMeasurer = (
  text: string,
  fontSizePx: number,
  role?: Role
) => { width: number; height: number };

/** Fallback used when no real measurer is supplied (e.g. unit tests, SSR). Deliberately approximate. */
export const heuristicTextMeasurer: TextMeasurer = (text, fontSizePx) => ({
  width: text.length * fontSizePx * 0.56,
  height: fontSizePx * 1.3,
});

// ---------------------------------------------------------------------
// Region templates
// ---------------------------------------------------------------------

interface SlotRole {
  role: Role;
  /** Relative share of the slot's split axis when multiple roles share it. Renormalized among active (non-dropped) roles. */
  weight: number;
}

interface RegionSlot {
  id: string;
  roles: SlotRole[];
  /** Fractions of the surface's content box, 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Axis along which multiple active roles in this slot are divided. */
  split: "row" | "col";
}

type RegionTemplate = RegionSlot[];

/**
 * TALL — stacked vertical composition. Suits a portrait phone screen:
 * big hero image up top (what you notice first scrolling a feed),
 * headline directly under it, price/CTA as a single actionable row,
 * branding tucked into a small corner last.
 */
const TALL_TEMPLATE: RegionTemplate = [
  { id: "hero", roles: [{ role: "hero", weight: 1 }], x: 0, y: 0, w: 1, h: 0.44, split: "row" },
  { id: "primary", roles: [{ role: "primary", weight: 1 }], x: 0, y: 0.44, w: 1, h: 0.17, split: "row" },
  {
    id: "actionRow",
    roles: [
      { role: "secondary", weight: 0.4 },
      { role: "action", weight: 0.6 },
    ],
    x: 0,
    y: 0.61,
    w: 1,
    h: 0.24,
    split: "row",
  },
  { id: "branding", roles: [{ role: "branding", weight: 1 }], x: 0.68, y: 0.87, w: 0.3, h: 0.11, split: "row" },
];

/**
 * WIDE — a single horizontal band. Suits a broadcast lower-third or a
 * landscape/leaderboard-style placement: everything reads left-to-right
 * in one glance because there's no vertical room to stack. Branding
 * anchors the brand on the left (broadcast convention), the CTA gets
 * the far-right "next action" position.
 */
const WIDE_TEMPLATE: RegionTemplate = [
  { id: "branding", roles: [{ role: "branding", weight: 1 }], x: 0, y: 0, w: 0.1, h: 1, split: "row" },
  { id: "hero", roles: [{ role: "hero", weight: 1 }], x: 0.1, y: 0, w: 0.15, h: 1, split: "row" },
  {
    id: "textBlock",
    roles: [
      { role: "primary", weight: 0.6 },
      { role: "secondary", weight: 0.4 },
    ],
    x: 0.25,
    y: 0,
    w: 0.45,
    h: 1,
    split: "col",
  },
  { id: "action", roles: [{ role: "action", weight: 1 }], x: 0.7, y: 0, w: 0.3, h: 1, split: "row" },
];

/**
 * SQUARE — a dominant hero image (kiosks/social tiles are look-first,
 * read-second) with a compact text+action band anchored to the bottom,
 * and branding as a small badge overlapping the hero/text seam.
 */
const SQUARE_TEMPLATE: RegionTemplate = [
  { id: "hero", roles: [{ role: "hero", weight: 1 }], x: 0, y: 0, w: 1, h: 0.56, split: "row" },
  { id: "primary", roles: [{ role: "primary", weight: 1 }], x: 0, y: 0.56, w: 1, h: 0.15, split: "row" },
  {
    id: "actionRow",
    roles: [
      { role: "secondary", weight: 0.38 },
      { role: "action", weight: 0.62 },
    ],
    x: 0,
    y: 0.71,
    w: 1,
    h: 0.19,
    split: "row",
  },
  { id: "branding", roles: [{ role: "branding", weight: 1 }], x: 0.74, y: 0.91, w: 0.22, h: 0.07, split: "row" },
];

const TEMPLATES: Record<AspectClass, RegionTemplate> = {
  tall: TALL_TEMPLATE,
  wide: WIDE_TEMPLATE,
  square: SQUARE_TEMPLATE,
};

/**
 * Fails fast at module load if a template's own fractional regions
 * overlap each other — this is a template-authoring bug, not a
 * per-spec/per-surface runtime concern, so it shouldn't have to wait
 * for a lucky combination of content + surface to be caught by
 * assertValidLayout(). Every slot also covers exactly the known role
 * set exactly once, so a newly-added Role can't silently fall through
 * with nowhere to render.
 */
function validateTemplate(name: AspectClass, template: RegionTemplate): void {
  const seenRoles = new Set<Role>();
  for (const slot of template) {
    for (const r of slot.roles) {
      if (seenRoles.has(r.role)) throw new Error(`Template "${name}": role "${r.role}" is claimed by more than one slot.`);
      seenRoles.add(r.role);
    }
  }
  const EPS = 1e-6;
  for (let i = 0; i < template.length; i++) {
    for (let j = i + 1; j < template.length; j++) {
      const a = template[i];
      const b = template[j];
      const overlapX = a.x < b.x + b.w - EPS && a.x + a.w - EPS > b.x;
      const overlapY = a.y < b.y + b.h - EPS && a.y + a.h - EPS > b.y;
      if (overlapX && overlapY) {
        throw new Error(`Template "${name}": slots "${a.id}" and "${b.id}" overlap in fractional space.`);
      }
    }
  }
}

(Object.keys(TEMPLATES) as AspectClass[]).forEach((k) => validateTemplate(k, TEMPLATES[k]));

/**
 * Which slot (if any) borders each of a slot's four edges — `null` means that edge only
 * borders the surface's own content-box boundary, not another region. Used for two
 * unrelated things that both need "is this a real neighbor, and which one": the gutter inset
 * (slotPixelRect, below — an edge only gets breathing room if something is actually on the
 * other side of it) and adjacent-region space reclamation (the safety-net pass, further down
 * — a starving higher-priority region may only ever borrow from a slot it geometrically
 * touches, never an arbitrary region elsewhere in the layout).
 */
interface SlotEdgeNeighbors {
  top: string | null;
  right: string | null;
  bottom: string | null;
  left: string | null;
}

/**
 * Computed once per template at module load: for each slot, which other slot (if any) shares
 * each edge. An edge that only borders the surface's own content-box boundary is left alone —
 * that's already protected by safeArea/bleed and isn't a place two regions could ever collide
 * or a place there's a neighbor to borrow from.
 */
function computeSlotEdgeNeighbors(template: RegionTemplate): Map<string, SlotEdgeNeighbors> {
  const EPS = 1e-6;
  const result = new Map<string, SlotEdgeNeighbors>();
  for (const a of template) {
    const edges: SlotEdgeNeighbors = { top: null, right: null, bottom: null, left: null };
    for (const b of template) {
      if (a === b) continue;
      const verticalOverlap = a.y < b.y + b.h - EPS && a.y + a.h - EPS > b.y;
      const horizontalOverlap = a.x < b.x + b.w - EPS && a.x + a.w - EPS > b.x;
      if (verticalOverlap && Math.abs(a.x + a.w - b.x) < EPS) edges.right = b.id;
      if (verticalOverlap && Math.abs(b.x + b.w - a.x) < EPS) edges.left = b.id;
      if (horizontalOverlap && Math.abs(a.y + a.h - b.y) < EPS) edges.bottom = b.id;
      if (horizontalOverlap && Math.abs(b.y + b.h - a.y) < EPS) edges.top = b.id;
    }
    result.set(a.id, edges);
  }
  return result;
}

const TEMPLATE_EDGE_NEIGHBORS: Record<AspectClass, Map<string, SlotEdgeNeighbors>> = {
  tall: computeSlotEdgeNeighbors(TALL_TEMPLATE),
  wide: computeSlotEdgeNeighbors(WIDE_TEMPLATE),
  square: computeSlotEdgeNeighbors(SQUARE_TEMPLATE),
};

// ---------------------------------------------------------------------
// Per-role fallback floors, used only when an element doesn't author
// its own minWidth/minHeight/minFontSize.
// ---------------------------------------------------------------------

const ROLE_DEFAULTS: Record<Role, { minFontSize?: number; minWidth?: number; minHeight?: number }> = {
  primary: { minFontSize: 14 },
  secondary: { minFontSize: 10 },
  action: { minWidth: 56, minHeight: 28 },
  hero: { minWidth: 36, minHeight: 36 },
  branding: { minWidth: 18, minHeight: 18 },
};

const LINE_HEIGHT = 1.3;

// ---------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------

export interface ResolvedElementLayout {
  id: string;
  role: Role;
  visible: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Present for text/button elements only. */
  fontSize?: number;
  /** Present when the text measurer determined the content had to be shortened to fit. */
  truncated?: boolean;
  displayText?: string;
}

export interface ResolvedLayout {
  surfaceId: string;
  surfaceWidth: number;
  surfaceHeight: number;
  aspectClass: AspectClass;
  elements: ResolvedElementLayout[];
  /** Human-readable log of every degradation decision, in order — this is what you'd narrate in the live interview walkthrough. */
  trace: string[];
}

export interface ResolveOptions {
  measureText?: TextMeasurer;
}

// ---------------------------------------------------------------------
// Internal working model
// ---------------------------------------------------------------------

interface RequiredSize {
  /** Hard floor — if the assigned region can't fit at least this, the element cannot be shown at all. */
  minWidth: number;
  minHeight: number;
  /** Text/button only: the smallest and the author-preferred font size. Actual rendered size is chosen at finalize time by shrinking preferred -> floor to fit the region height (never below floor). */
  floorFontSize?: number;
  preferredFontSize?: number;
}

interface WorkingElement {
  el: AdElement;
  required: RequiredSize;
  active: boolean;
}

/**
 * Deliberately decoupled from *content* width: an over-long headline is a
 * truncation problem (solved later, against the real region, using the
 * real measurer) not a fitness problem. The hard floor only asks "could
 * this element show *something* legible here at all" — full-string width
 * is irrelevant to whether the element deserves to exist in this layout.
 */
function requiredSizeOf(
  el: AdElement,
  surface: SurfaceProfile,
  cls: SurfaceClassification,
  measure: TextMeasurer
): RequiredSize {
  const roleDefaults = ROLE_DEFAULTS[el.role];

  if (el.type === "text") {
    const floor = Math.max(el.minFontSize ?? roleDefaults.minFontSize ?? 10, surface.minTextSize ?? 0);
    const preferred = Math.max(el.preferredFontSize ?? floor, surface.minTextSize ?? 0);
    const nominalMinWidth = measure("\u2026", floor, el.role).width + 2; // must fit at least an ellipsis
    return {
      minWidth: el.minWidth ?? nominalMinWidth,
      minHeight: el.minHeight ?? floor * LINE_HEIGHT,
      floorFontSize: floor,
      preferredFontSize: preferred,
    };
  }

  if (el.type === "button") {
    const tap = cls.isTouch ? surface.minTapTarget ?? 0 : 0;
    const floor = Math.max(el.minFontSize ?? 11, surface.minTextSize ?? 0);
    const preferred = Math.max(el.preferredFontSize ?? floor + 2, surface.minTextSize ?? 0);
    const nominalLabelWidth = measure("\u2026", floor, el.role).width;
    const minWidth = Math.max(el.minWidth ?? roleDefaults.minWidth ?? 0, nominalLabelWidth + 24, tap);
    const minHeight = Math.max(el.minHeight ?? roleDefaults.minHeight ?? 0, tap, floor * LINE_HEIGHT + 12);
    return { minWidth, minHeight, floorFontSize: floor, preferredFontSize: preferred };
  }

  // image — no truncation escape hatch, so this IS a true hard floor.
  const tap = cls.isTouch && el.role === "action" ? surface.minTapTarget ?? 0 : 0;
  return {
    minWidth: Math.max(el.minWidth ?? roleDefaults.minWidth ?? 0, tap),
    minHeight: Math.max(el.minHeight ?? roleDefaults.minHeight ?? 0, tap),
  };
}

interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Fixed visual breathing room, in px, applied (a) around every region's own
 * edges — so two templates-adjacent regions (e.g. WIDE's textBlock and
 * action) never sit truly edge-to-edge — and (b) between siblings sharing
 * one split region (e.g. price/CTA in the same row). This is a robustness
 * margin on top of the real fix (role-aware text measurement below), not a
 * substitute for it: it exists so a *future* small measurement discrepancy
 * degrades into "a bit less breathing room" instead of a visible collision,
 * not to paper over an existing one. Baked into slotPixelRect/splitSlot —
 * the only two functions that ever compute a region's pixel bounds — so it
 * applies identically to the contention pass, the safety-net pass, and
 * final geometry; there is no separate place it could be forgotten.
 */
const REGION_GUTTER_PX = 4;
const SIBLING_GUTTER_PX = 4;

function slotPixelRect(
  slot: RegionSlot,
  contentBox: SurfaceClassification["contentBox"],
  edges: SlotEdgeNeighbors
): PixelRect {
  const rawX = contentBox.x + slot.x * contentBox.width;
  const rawY = contentBox.y + slot.y * contentBox.height;
  const rawW = slot.w * contentBox.width;
  const rawH = slot.h * contentBox.height;
  const half = REGION_GUTTER_PX / 2;
  // Cap each side's inset at a quarter of the raw extent, so a slot bordered on both sides
  // (e.g. a narrow column sandwiched between two neighbors) can never lose more than half its
  // own size to gutters, regardless of how thin the template author drew it.
  const left = edges.left !== null ? Math.min(half, rawW / 4) : 0;
  const right = edges.right !== null ? Math.min(half, rawW / 4) : 0;
  const top = edges.top !== null ? Math.min(half, rawH / 4) : 0;
  const bottom = edges.bottom !== null ? Math.min(half, rawH / 4) : 0;
  return {
    x: rawX + left,
    y: rawY + top,
    w: Math.max(0, rawW - left - right),
    h: Math.max(0, rawH - top - bottom),
  };
}

/**
 * Minimum extent a slot needs along `axis` to keep exactly `members` legal. If `axis` is the
 * slot's own split axis, members sit side by side along it, so the slot needs their sum (plus
 * the sibling gutters between them) — same accounting as the contention pass. If `axis` is the
 * slot's *cross* axis, members fully overlap there (a shared row's height, say), so the slot
 * only needs to be as tall as its most demanding member, not their sum.
 */
function neededExtentForSlot(slot: RegionSlot, axis: "row" | "col", members: WorkingElement[]): number {
  if (members.length === 0) return 0;
  if (slot.split === axis) {
    return (
      members.reduce((s, w) => s + requiredExtent(w.required, axis), 0) +
      Math.max(0, members.length - 1) * SIBLING_GUTTER_PX
    );
  }
  return Math.max(...members.map((w) => requiredExtent(w.required, axis)));
}

/**
 * Moves `amount` px of a shared border from `giver`'s rect to `receiver`'s rect, in place.
 * `edge` is which edge of `receiver` the giver sits across — e.g. "bottom" means the giver is
 * below the receiver, so the receiver grows downward and the giver's top retreats by the same
 * amount. This is the only place a slot's rect ever changes after its initial computation.
 */
function growReceiverIntoGiver(
  rects: Map<string, PixelRect>,
  receiver: RegionSlot,
  edge: "top" | "right" | "bottom" | "left",
  giver: RegionSlot,
  amount: number
): void {
  const r = rects.get(receiver.id)!;
  const g = rects.get(giver.id)!;
  if (edge === "bottom") {
    r.h += amount;
    g.y += amount;
    g.h -= amount;
  } else if (edge === "top") {
    r.y -= amount;
    r.h += amount;
    g.h -= amount;
  } else if (edge === "right") {
    r.w += amount;
    g.x += amount;
    g.w -= amount;
  } else {
    r.x -= amount;
    r.w += amount;
    g.w -= amount;
  }
}

/** Splits a slot's pixel rect among its currently-active roles, proportional to renormalized weight. */
function splitSlot(rect: PixelRect, slot: RegionSlot, activeRoles: Set<Role>): Map<Role, PixelRect> {
  const members = slot.roles.filter((r) => activeRoles.has(r.role));
  const totalWeight = members.reduce((s, m) => s + m.weight, 0) || 1;
  const gutterCount = Math.max(0, members.length - 1);
  const fullExtent = slot.split === "row" ? rect.w : rect.h;
  const usableExtent = Math.max(0, fullExtent - gutterCount * SIBLING_GUTTER_PX);

  const result = new Map<Role, PixelRect>();
  let cursor = 0;
  for (const m of members) {
    const share = m.weight / totalWeight;
    if (slot.split === "row") {
      const w = usableExtent * share;
      result.set(m.role, { x: rect.x + cursor, y: rect.y, w, h: rect.h });
      cursor += w + SIBLING_GUTTER_PX;
    } else {
      const h = usableExtent * share;
      result.set(m.role, { x: rect.x, y: rect.y + cursor, w: rect.w, h });
      cursor += h + SIBLING_GUTTER_PX;
    }
  }
  return result;
}

/** Required extent of a role's member along the slot's split axis. */
function requiredExtent(size: RequiredSize, split: "row" | "col"): number {
  return split === "row" ? size.minWidth : size.minHeight;
}

/** Available extent of a slot's pixel rect along its own split axis. */
function availableExtent(rect: PixelRect, split: "row" | "col"): number {
  return split === "row" ? rect.w : rect.h;
}

// ---------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------

export function resolve(spec: AdSpec, surface: SurfaceProfile, options: ResolveOptions = {}): ResolvedLayout {
  const measure = options.measureText ?? heuristicTextMeasurer;
  const cls = classifySurface(surface);
  const template = TEMPLATES[cls.aspectClass];
  const edgesMap = TEMPLATE_EDGE_NEIGHBORS[cls.aspectClass];
  const slotById = new Map(template.map((s) => [s.id, s] as const));
  const trace: string[] = [
    `Surface "${surface.name}" (${surface.width}x${surface.height}) classified as "${cls.aspectClass}" ` +
      `(ratio ${cls.aspectRatio.toFixed(2)}, touch=${cls.isTouch}, farViewing=${cls.isFarViewing}) -> using ${cls.aspectClass} template.`,
  ];

  // Map role -> the slot that owns it. (Each of our 3 templates covers every known role exactly once.)
  const slotByRole = new Map<Role, RegionSlot>();
  for (const slot of template) {
    for (const r of slot.roles) slotByRole.set(r.role, slot);
  }

  const working = new Map<string, WorkingElement>();
  for (const el of spec.elements) {
    const slot = slotByRole.get(el.role);
    if (!slot) {
      trace.push(`WARNING: element "${el.id}" has role "${el.role}" with no region in the "${cls.aspectClass}" template — it will not be rendered.`);
      continue;
    }
    working.set(el.id, { el, required: requiredSizeOf(el, surface, cls, measure), active: true });
  }

  function activeElementsInSlot(slot: RegionSlot): WorkingElement[] {
    return slot.roles
      .map((r) => [...working.values()].find((w) => w.el.role === r.role && w.active))
      .filter((w): w is WorkingElement => Boolean(w));
  }

  function priorityRank(w: WorkingElement): Priority {
    return w.el.priority;
  }

  /** Drops the lowest-priority active element among the given candidates. Returns false if none could be dropped (all gone). */
  function dropLowestPriority(candidates: WorkingElement[], reason: string): boolean {
    const droppable = candidates.filter((w) => w.active);
    if (droppable.length === 0) return false;
    const victim = droppable.reduce((worst, w) => (priorityRank(w) > priorityRank(worst) ? w : worst));
    victim.active = false;
    trace.push(`DROP "${victim.el.id}" (role=${victim.el.role}, priority=${victim.el.priority}): ${reason}`);
    return true;
  }

  // Mutable per-slot pixel rects, computed once from the static template and then read (and,
  // only in the reclamation step below, written) by every later pass. Computing this once up
  // front — rather than re-deriving it fresh from the template each time, as every earlier
  // version of this file did — is what lets reclamation permanently resize a region and have
  // that resize actually stick for every subsequent pass and for final geometry.
  const rects = new Map<string, PixelRect>();
  for (const slot of template) {
    rects.set(slot.id, slotPixelRect(slot, cls.contentBox, edgesMap.get(slot.id)!));
  }

  // --- Contention pass: resolve shared-slot overcrowding by dropping low-priority siblings ---
  for (const slot of template) {
    if (slot.roles.length < 2) continue;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const rect = rects.get(slot.id)!;
      const active = activeElementsInSlot(slot);
      if (active.length <= 1) break;
      // +1 sibling gutter per gap between active members — splitSlot() reserves the same
      // space, so contention must account for it or it would under-detect a squeeze that
      // the safety-net pass would then have to clean up one element at a time instead.
      const totalRequired =
        active.reduce((s, w) => s + requiredExtent(w.required, slot.split), 0) +
        (active.length - 1) * SIBLING_GUTTER_PX;
      const available = availableExtent(rect, slot.split);
      if (totalRequired <= available) break;
      // Before sacrificing a sibling, see if an adjacent region can spare the slot enough
      // room to fit everyone — protecting the slot's most important active member is the
      // point, so that's who "needs" the reclaimed space for this purpose. Only reaches a
      // slot the template says is a genuine geometric neighbor (see tryReclaim below).
      const mostImportant = active.reduce((best, w) => (w.el.priority < best.el.priority ? w : best));
      if (
        tryReclaim({ w: mostImportant, slot, axis: slot.split, shortfall: totalRequired - available })
      ) {
        continue;
      }
      const dropped = dropLowestPriority(
        active,
        `slot "${slot.id}" needs ${Math.round(totalRequired)}px but only has ${Math.round(available)}px along its ${slot.split === "row" ? "width" : "height"} axis`
      );
      if (!dropped) break;
    }
  }

  // --- Safety-net + reclamation pass. Every round:
  //   1. RECLAIM: take the single *most important* currently-deficient element and try to
  //      rescue it by pulling space from an adjacent region — either genuine idle slack there,
  //      or (only if nothing else works) by dropping that region's own least-important
  //      occupant, and only when that occupant is strictly lower-priority than the element
  //      being rescued. This never reaches past a geometric neighbor in the template, so it
  //      stays a two-sentence rule ("a starving higher-priority region can eat into a
  //      lower-priority neighbor's space") rather than a general space auction across the ad.
  //   2. DROP: if no adjacent region can help at all, fall back to the original behavior —
  //      drop the globally lowest-priority element among the deficient ones.
  // Both branches re-scan for deficiencies from scratch every round, so a single rescue or
  // drop is always evaluated against the layout's current, up-to-date state.
  const EPS = 0.01;
  type DeficiencyAxis = "row" | "col";
  interface Deficiency {
    w: WorkingElement;
    slot: RegionSlot;
    axis: DeficiencyAxis;
    shortfall: number;
  }

  function findDeficiencies(): Deficiency[] {
    const found: Deficiency[] = [];
    for (const slot of template) {
      const rect = rects.get(slot.id)!;
      const activeRoles = new Set(activeElementsInSlot(slot).map((w) => w.el.role));
      const split = splitSlot(rect, slot, activeRoles);
      for (const w of activeElementsInSlot(slot)) {
        const sub = split.get(w.el.role);
        if (!sub) continue;
        if (sub.w + EPS < w.required.minWidth) found.push({ w, slot, axis: "row", shortfall: w.required.minWidth - sub.w });
        if (sub.h + EPS < w.required.minHeight) found.push({ w, slot, axis: "col", shortfall: w.required.minHeight - sub.h });
      }
    }
    return found;
  }

  /** Attempts to free space for `d` from one adjacent slot. Returns true on any change made
   *  (a transfer or a drop) — even a partial transfer is progress; the next round's fresh scan
   *  picks up whatever shortfall remains. */
  function tryReclaim(d: Deficiency): boolean {
    const edges = edgesMap.get(d.slot.id)!;
    const candidateEdges: ("top" | "right" | "bottom" | "left")[] = d.axis === "col" ? ["top", "bottom"] : ["left", "right"];
    for (const edge of candidateEdges) {
      const neighborId = edges[edge];
      if (!neighborId) continue;
      const neighbor = slotById.get(neighborId)!;
      const neighborActive = activeElementsInSlot(neighbor);
      const neighborRect = rects.get(neighbor.id)!;
      const currentExtent = d.axis === "col" ? neighborRect.h : neighborRect.w;
      const neededByNeighbor = neededExtentForSlot(neighbor, d.axis, neighborActive);
      const slack = currentExtent - neededByNeighbor;

      if (slack > EPS) {
        const amount = Math.min(d.shortfall, slack);
        growReceiverIntoGiver(rects, d.slot, edge, neighbor, amount);
        trace.push(
          `RECLAIM: borrowed ${Math.round(amount)}px of ${d.axis === "col" ? "height" : "width"} from slot "${neighbor.id}" ` +
            `for slot "${d.slot.id}" to protect higher-priority "${d.w.el.id}" (priority=${d.w.el.priority}).`
        );
        return true;
      }

      if (neighborActive.length > 0) {
        const worst = neighborActive.reduce((worst, w) => (w.el.priority > worst.el.priority ? w : worst));
        if (worst.el.priority > d.w.el.priority) {
          worst.active = false;
          trace.push(
            `RECLAIM: dropped "${worst.el.id}" (priority=${worst.el.priority}) from adjacent slot "${neighbor.id}" ` +
              `to make room for higher-priority "${d.w.el.id}" (priority=${d.w.el.priority}) in slot "${d.slot.id}".`
          );
          return true;
        }
      }
    }
    return false;
  }

  for (let guard = 0; guard < (working.size + template.length) * 3 + 4; guard++) {
    const deficient = findDeficiencies();
    if (deficient.length === 0) break;
    deficient.sort((a, b) => a.w.el.priority - b.w.el.priority);
    if (tryReclaim(deficient[0])) continue;
    const dropped = dropLowestPriority(
      deficient.map((d) => d.w),
      "did not meet its own minimum size even alone in its region, and no adjacent region could spare it any (safety-net pass)"
    );
    if (!dropped) break;
  }

  // --- Finalize geometry ---
  const elements: ResolvedElementLayout[] = [];
  for (const slot of template) {
    const rect = rects.get(slot.id)!;
    const activeRoles = new Set(activeElementsInSlot(slot).map((w) => w.el.role));
    const split = splitSlot(rect, slot, activeRoles);

    for (const w of working.values()) {
      if (w.el.role !== undefined && slotByRole.get(w.el.role) !== slot) continue;
      if (![...slot.roles].some((r) => r.role === w.el.role)) continue;

      if (!w.active) {
        elements.push({ id: w.el.id, role: w.el.role, visible: false, x: 0, y: 0, width: 0, height: 0 });
        continue;
      }

      const sub = split.get(w.el.role)!;
      let width = sub.w;
      let height = sub.h;

      // Preserve intrinsic aspect ratio for images rather than stretching to fill a reshaped region.
      if (w.el.type === "image" && w.el.aspectRatio) {
        const fitHeight = width / w.el.aspectRatio;
        if (fitHeight <= height) {
          height = fitHeight;
        } else {
          width = height * w.el.aspectRatio;
        }
      }

      let fontSize = w.required.preferredFontSize;
      let displayText: string | undefined;
      let truncated = false;

      if (w.el.type === "text" || w.el.type === "button") {
        const floor = w.required.floorFontSize!;
        const preferred = w.required.preferredFontSize!;
        // SHRINK: if the region is shorter than one line at the preferred size, scale the
        // font down — but never past the hard floor (the safety-net pass already guaranteed
        // the floor fits, or this element wouldn't be active).
        const maxFontByHeight = sub.h / LINE_HEIGHT;
        fontSize = maxFontByHeight < preferred ? Math.max(floor, Math.round(maxFontByHeight * 10) / 10) : preferred;
        if (fontSize < preferred) {
          trace.push(`SHRINK "${w.el.id}": region only ${Math.round(sub.h)}px tall -> font reduced ${preferred}px to ${fontSize}px.`);
        }

        const raw = w.el.type === "text" ? w.el.content : w.el.label;
        displayText = raw;
        const measured = measure(displayText, fontSize, w.el.role);
        if (measured.width > sub.w && sub.w > 0) {
          // TRUNCATE: binary-search the longest prefix (+ ellipsis) that actually fits at the
          // final font size, using the real measurer — not a fixed character-count guess.
          truncated = true;
          let lo = 0;
          let hi = displayText.length;
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            const candidate = displayText.slice(0, mid).trimEnd() + "\u2026";
            if (measure(candidate, fontSize, w.el.role).width <= sub.w) lo = mid;
            else hi = mid - 1;
          }
          displayText = lo === 0 ? "\u2026" : displayText.slice(0, lo).trimEnd() + "\u2026";
          trace.push(`TRUNCATE "${w.el.id}": "${raw}" did not fit ${Math.round(sub.w)}px at ${fontSize}px -> "${displayText}".`);
        }
      }

      elements.push({
        id: w.el.id,
        role: w.el.role,
        visible: true,
        x: sub.x,
        y: sub.y,
        width,
        height,
        fontSize,
        truncated: truncated || undefined,
        displayText,
      });
    }
  }

  assertValidLayout(elements, surface, trace);

  return {
    surfaceId: surface.id,
    surfaceWidth: surface.width,
    surfaceHeight: surface.height,
    aspectClass: cls.aspectClass,
    elements,
    trace,
  };
}

// ---------------------------------------------------------------------
// Invariant checker — "never overlap, never render outside the
// surface". Runs on every resolve() call; throws (loudly, in dev)
// rather than silently shipping a broken layout.
// ---------------------------------------------------------------------

function assertValidLayout(elements: ResolvedElementLayout[], surface: SurfaceProfile, trace: string[]): void {
  const visible = elements.filter((e) => e.visible);

  for (const e of visible) {
    const withinBounds =
      e.x >= -0.5 && e.y >= -0.5 && e.x + e.width <= surface.width + 0.5 && e.y + e.height <= surface.height + 0.5;
    if (!withinBounds) {
      throw new Error(
        `Layout invariant violated: element "${e.id}" renders outside surface bounds ` +
          `(${e.x},${e.y},${e.width}x${e.height}) on a ${surface.width}x${surface.height} surface.`
      );
    }
  }

  // Adjacent regions computed via independent fraction*dimension multiplications can land a
  // few ULPs apart (e.g. 287.5199999999999 vs 287.52) without genuinely overlapping — EPS
  // absorbs that floating-point noise without masking real, visible overlaps.
  const EPS = 0.01;
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i];
      const b = visible[j];
      const overlapX = a.x < b.x + b.width - EPS && a.x + a.width - EPS > b.x;
      const overlapY = a.y < b.y + b.height - EPS && a.y + a.height - EPS > b.y;
      if (overlapX && overlapY) {
        throw new Error(`Layout invariant violated: "${a.id}" and "${b.id}" overlap on surface "${surface.id}".`);
      }
    }
  }

  trace.push(`Invariant check passed: ${visible.length}/${elements.length} elements visible, no overlaps, all in-bounds.`);
}
