/**
 * spec.ts
 * -----------------------------------------------------------------------
 * Declarative ad content model. This file knows NOTHING about pixels,
 * surfaces, or rendering — it only describes *what* content exists and
 * *how important* each piece is relative to the others.
 *
 * The resolver (resolver.ts) is the only place that turns this into an
 * actual layout, which is what keeps this file swappable / testable in
 * isolation and keeps the type system honest: a spec referencing an
 * unknown role or a malformed element is rejected here, once, rather
 * than failing silently deep inside a layout pass.
 * -----------------------------------------------------------------------
 */

/** The fixed set of element kinds the engine knows how to lay out. */
export type ElementType = "text" | "image" | "button";

/**
 * The fixed set of *roles* content can play in an ad. The resolver keys
 * its region templates off roles, not element ids — this is what lets a
 * brand-new spec (different ids, different copy) reuse the same
 * templates without any changes to the resolution algorithm.
 */
export type Role = "primary" | "hero" | "action" | "branding" | "secondary";

/** Known roles, used for runtime validation of hand-authored specs. */
export const KNOWN_ROLES: readonly Role[] = [
  "primary",
  "hero",
  "action",
  "branding",
  "secondary",
] as const;

/**
 * Priority is a small positive integer. 1 is the most important
 * ("must always be visible, must never be the thing that shrinks"),
 * larger numbers are progressively more disposable. The resolver
 * degrades elements strictly in descending priority order.
 */
export type Priority = 1 | 2 | 3 | 4 | 5;

interface BaseElement {
  /** Unique within the spec. Used only for keying output, never for layout decisions. */
  id: string;
  type: ElementType;
  role: Role;
  priority: Priority;
  /**
   * Content-intrinsic aspect ratio hint (width / height), used by the
   * resolver to avoid distorting images when a region is reshaped.
   * Optional — falls back to filling the region.
   */
  aspectRatio?: number;
  /** Hard-floor overrides. If omitted, the resolver falls back to a per-role default (see resolver.ts ROLE_DEFAULTS). */
  minWidth?: number;
  minHeight?: number;
  /** Hard floor for rendered font size (text and button label). */
  minFontSize?: number;
}

export interface TextElement extends BaseElement {
  type: "text";
  content: string;
  /** Author's preferred size in px at "normal" viewing distance. The resolver may scale this up (far viewing) or down (space pressure), never below a hard floor. */
  preferredFontSize?: number;
  /** Hard floor — the resolver will drop the element entirely rather than render it smaller than this. */
  minFontSize?: number;
  emphasis?: "display" | "body" | "caption";
}

export interface ImageElement extends BaseElement {
  type: "image";
  src: string;
  alt: string;
}

export interface ButtonElement extends BaseElement {
  type: "button";
  label: string;
  preferredFontSize?: number;
}

export type AdElement = TextElement | ImageElement | ButtonElement;

export interface AdSpec {
  readonly id: string;
  readonly elements: readonly AdElement[];
}

export interface AdSpecInput {
  id?: string;
  elements: AdElement[];
}

/**
 * Builds and validates an AdSpec. Invalid specs throw synchronously and
 * descriptively (unknown role, duplicate id, non-positive priority)
 * rather than producing a spec that silently misbehaves three layers
 * deeper in the resolver.
 */
export function defineAd(input: AdSpecInput): AdSpec {
  const seenIds = new Set<string>();

  for (const el of input.elements) {
    if (seenIds.has(el.id)) {
      throw new Error(`defineAd: duplicate element id "${el.id}"`);
    }
    seenIds.add(el.id);

    if (!KNOWN_ROLES.includes(el.role)) {
      throw new Error(
        `defineAd: element "${el.id}" has unknown role "${el.role}". ` +
          `Known roles: ${KNOWN_ROLES.join(", ")}`
      );
    }

    if (!Number.isInteger(el.priority) || el.priority < 1) {
      throw new Error(
        `defineAd: element "${el.id}" has invalid priority ${el.priority} (must be a positive integer, 1 = most important)`
      );
    }

    if (el.type === "text" && el.content.trim().length === 0) {
      throw new Error(`defineAd: text element "${el.id}" has empty content`);
    }
    if (el.type === "image" && !el.src) {
      throw new Error(`defineAd: image element "${el.id}" is missing src`);
    }
    if (el.type === "button" && el.label.trim().length === 0) {
      throw new Error(`defineAd: button element "${el.id}" has empty label`);
    }
  }

  return {
    id: input.id ?? "ad",
    elements: input.elements,
  };
}
