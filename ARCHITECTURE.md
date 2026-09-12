# Architecture

## File map

```
src/
├── spec.ts            content model: elements, roles, priority, defineAd()
├── surfaces.ts         constraint model: SurfaceProfile, classifySurface()
├── resolver.ts          the engine: resolve(spec, surface) -> ResolvedLayout
├── measure-text.ts        injectable, real (canvas-based) text measurement
├── render-dom.tsx          renderer #1: absolutely-positioned DOM/CSS
├── render-canvas.tsx        renderer #2: Canvas 2D (bonus)
├── demoAd.ts                  the one ad spec used throughout the demo
└── App.tsx                     demo shell: surface picker, renderer toggle, trace panel
tests/
└── resolver.test.ts              plain-assertion regression tests
```

## Separation of concerns

```
   spec.ts                    surfaces.ts
  (what content              (what constraints
   exists, and                a place imposes)
   how important
   each piece is)
        │                          │
        └───────────┬──────────────┘
                     ▼
               resolver.ts
        (the only file that decides
         where anything goes)
                     │
                     ▼
             ResolvedLayout
       (plain typed data: x, y, w, h,
        visible, fontSize, displayText)
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
  render-dom.tsx            render-canvas.tsx
  (paints it as             (paints it on a
   positioned DOM            <canvas>)
   nodes)
```

`resolver.ts` is the only file in the repo that makes the final layout
decisions. `spec.ts` and `surfaces.ts` describe and validate the ad content
and surface constraints, while `render-dom.tsx` and `render-canvas.tsx`
consume the resulting `ResolvedLayout` without making layout decisions.

## Could a new surface be added without touching the resolver?

Yes, `App.tsx`'s "Custom surface" form
builds an arbitrary `SurfaceProfile` object at runtime and passes it straight
into the same `resolve()` call used for the five preset surfaces — no branch,
no new template, no resolver code touched. `resolve()` only ever reads
`classifySurface(surface)`'s output (`aspectClass`, `isTouch`, `isFarViewing`,
`contentBox`) and the surface's raw constraint fields (`minTapTarget`,
`minTextSize`). It never reads `surface.id` or `surface.name`. Concretely, adding a sixth *named* preset only requires adding another
`SurfaceProfile` to the `surfaces` object in `surfaces.ts`:

```ts
export const surfaces = {
  // ...existing five
  smartWatch: {
    id: "smartWatch",
    name: "Smart Watch Face",
    width: 198,
    height: 198,
    safeArea: { top: 6, right: 6, bottom: 6, left: 6 },
    minTapTarget: 40,
    touchOnly: true,
  },
};
```

`resolver.ts` needs no edits for this to resolve correctly — it will classify
as `square` (ratio ≈ 1) and go through the exact same contention/safety-net
passes as `microKiosk`.

## Could a new renderer be added without touching the resolver?

Yes — `render-canvas.tsx` is the proof. It was written entirely after
`resolver.ts` and `render-dom.tsx` were finished, without a single edit to
either. Both renderers share the exact same contract:

```ts
function SomeRenderer(props: { spec: AdSpec; layout: ResolvedLayout; displayScale?: number }): JSX.Element
```

A hypothetical third renderer (say, exporting to SVG for a print/QR panel, or
targeting React Native) would only need to implement this same contract.
Nothing in `resolver.ts` imports React, touches `document`, or knows a
renderer exists.

## Where the "no hardcoded per-surface branches" claim is actually enforced

- `classifySurface()` is the single choke point between a `SurfaceProfile`
  and everything downstream. It's pure geometry (an aspect-ratio threshold
  test) — there is no `switch`/`if` on `surface.id` anywhere in the codebase.
  `grep -rn "surface.id ===" src/` and `grep -rn "surface.name ===" src/`
  both return nothing outside of trace-logging strings.
- Region templates (`TALL_TEMPLATE`, `WIDE_TEMPLATE`, `SQUARE_TEMPLATE`) are
  keyed by `AspectClass`, a derived value, not by any surface identity.
- `validateTemplate()` runs once at module load and enforces that every
  `Role` is claimed by exactly one slot across a template and that no two
  slots in the same template overlap in fractional space — a structural
  guarantee about the *templates themselves*, independent of any specific
  spec or surface.

## Why a region-template model instead of a literal flex/grid reimplementation

The region-template approach provides a predictable structural arrangement,
while the priority-ordered resolver handles sizing and degradation dynamically. Region templates are the smallest model that still forces genuine
per-surface re-composition (not uniform scaling): each aspect class gets a
*different shape* of regions — stacked vertically for `tall`, banded
horizontally for `wide`, hero-dominant-with-a-footer for `square` — so the
same spec produces structurally different arrangements (verified in
`tests/resolver.test.ts`: headline stacks *below* the hero on `tall`/`square`
but sits *beside* a narrow hero band on `wide`), while the *within-region*
sizing math (contention pass, safety-net pass, shrink/truncate) is a single,
surface-agnostic priority-ordered algorithm shared by all three.

## Extending to broadcast-safe-area / print-bleed constraints

`SurfaceProfile` already has both `safeArea` (interactive/visual safety,
excluded from the content box) and `bleed` (a separate, more conservative
outer margin — modeled on `broadcastLowerThird`'s profile) as independent,
composable insets in `classifySurface()`. A print-bleed panel would set
`bleed` to the trim margin and leave `safeArea` for the panel's actual
interactive zone; no resolver change is needed because both insets are
already folded into `contentBox` before any region math happens.
