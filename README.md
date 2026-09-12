# Adaptive Layout Engine for Multi-Surface Ads

One ad spec, defined once. A constraint-based resolver adapts it into a genuinely
different, correct layout for a tall mobile screen, a wide broadcast band, a
square kiosk, or a surface the engine has never seen before — without a single
`if (surface === "mobile")` anywhere in the codebase.

Demo ad: **TERRA**, a fictional trail-running shoe brand (headline, hero product
shot, price, CTA, logo — the same five-element brief given in the assignment).

Deployment Link: adaptive-layout-assignment-dusky.vercel.app

## Setup

```bash
npm install
npm run dev       # http://localhost:5173
```

Other scripts:

```bash
npm run build      # tsc -b && vite build — production build, type-checks first
npm run test        # runs tests/resolver.test.ts (plain assertions, no framework)
npm run lint         # oxlint
npm run preview       # serve the production build locally
```

## Running the demo / switching surfaces

Open the app and use the surface picker at the top:

- **Mobile Interstitial (Portrait)** — 320×480, touch, tap-target constrained
- **Mobile Interstitial (Landscape)** — 480×270, touch
- **Broadcast Lower-Third** — 1920×250, far-viewing, minimum text size enforced
- **Retail Kiosk (Square)** — 1080×1080, touch
- **Micro Kiosk / Shelf Tag (200×200)** — the *intentionally too-tight* surface.
  At this size branding can no longer meet even its default floor size, so it
  drops cleanly while the headline (shrunk + truncated) and CTA stay intact.
  Watch the trace panel on the right when you select it.
- **Custom surface** — a free-form width/height/touch/far-viewing form. This is
  the "surface unknown at design time" case: it runs through the exact same
  `resolve()` call as the five presets above, with no code path specific to it.
  Use this to hand the engine an arbitrary 5th profile and watch it resolve correctly.

Toggle **DOM / CSS** vs **Canvas** above the preview to switch renderers — both
consume the identical `ResolvedLayout` object.

The right-hand panel shows the **resolution trace**: a step-by-step log of every
shrink/truncate/drop decision the resolver made for the currently selected
surface, plus a table of each element's final state and pixel box.

## Layout algorithm — step by step

The full implementation is in `src/resolver.ts`, ~350 lines, no dependencies.

1. **Classify the surface.** `classifySurface()` (in `surfaces.ts`) looks only
   at raw numbers — `width/height` ratio, `touchOnly`, `viewingDistance` — and
   derives `aspectClass: "tall" | "wide" | "square"` plus `isTouch` /
   `isFarViewing` flags. Nothing downstream ever looks at a surface's `id` or
   `name`.

2. **Pick a region template.** Each aspect class maps to one fixed
   `RegionTemplate`: a small set of named rectangles (in *fractions* of the
   surface's content box, not pixels), each one accepting one or more content
   *roles*.
   - `tall` → vertical stack: hero image on top, headline under it, a
     price+CTA row, branding tucked in a bottom corner.
   - `wide` → a single horizontal band: branding strip, small hero thumbnail,
     a headline+price text block, CTA on the right — everything readable in
     one left-to-right glance, because there's no vertical room to stack.
   - `square` → hero image dominates the top ~56%, with headline / price+CTA
     compressed into a band underneath and a small branding badge in the
     corner.

3. **Assign elements to regions by role**, not by id. This is what lets a spec
   with entirely different ids/copy reuse the same three templates untouched.

4. **Compute each element's hard floor.** `requiredSizeOf()` computes the
   *smallest* size an element could legitimately render at:
   - Text: floor font size = `max(element's own minFontSize, surface's
     minTextSize)`. The **hard floor width is deliberately tiny** (just enough
     to show an ellipsis) — an over-long headline is a *truncation* problem,
     solved later against the real region, not a reason to fail early.
   - Buttons: floor size = `max(role default, surface's minTapTarget)`.
   - Images: floor size = author-specified minimum, bumped to `minTapTarget`
     only if the image itself is the tappable element (role `action`).

5. **Split shared regions.** Where a region hosts more than one role (e.g. the
   price+CTA row), it's divided along the region's own split axis
   (`row`/`col`), proportional to each active role's authored `weight`,
   renormalized among whichever roles are still active.

6. **Contention pass.** For each shared region, if the *sum* of active
   members' hard floors along the split axis exceeds the space available,
   drop the lowest-`priority` member (`priority` 1 = never touched first, N =
   most disposable) and re-split among the survivors. Repeat until it fits or
   one member is left.

7. **Safety-net pass.** After contention is resolved, re-check *every* active
   element (shared-region or solo) against its own final region. Any element
   still failing its own hard floor is deficient. Among only the deficient
   elements this round, drop the lowest-priority one and re-check — never an
   unrelated element elsewhere in the layout. This guarantees termination while preserving the highest-priority content
whenever a feasible layout remains, including for constraint combinations that
were not explicitly designed for, while avoiding unnecessary dropping.

8. **Finalize geometry.**
   - Images: fit "contain" within their final region, preserving
     `aspectRatio` if the element specifies one (never stretched/distorted).
   - Text/buttons: **shrink** the font from the author's `preferredFontSize`
     down toward (never past) the floor if the region is shorter than one
     line at the preferred size; then, using the real text measurer, if the
     content still doesn't fit the region's *width* at the final font size,
     **truncate** with a binary search for the longest prefix + "…" that
     actually fits (not a fixed character-count guess).
   - Dropped elements get `visible: false` and an empty box.

9. **Invariant check.** `assertValidLayout()` re-verifies, on every single
   `resolve()` call, that no two visible elements overlap and every visible
   element is within surface bounds — with a small epsilon to absorb
   floating-point noise from independent fraction×dimension multiplications,
   not to mask real overlaps. It throws (loudly) rather than silently
   shipping a broken layout. There's a second, template-authoring-time
   version of this same check (`validateTemplate()`) that runs once at module
   load and catches a malformed *template* (overlapping regions, a role
   claimed by two slots) before it ever reaches a specific spec/surface
   combination — this actually caught a real bug during development (see
   "Time spent" below).

## Priority / degradation decision order

Two independent mechanisms, both keyed only on `element.priority` (smaller =
more important, never touched first):

- **Shared-region contention**: siblings sharing one region (e.g. price vs.
  CTA) — the lower-priority sibling is dropped first, repeatedly, until the
  remaining siblings fit.
- **Global safety net**: only ever drops an element that is *itself* currently
  failing to meet its own floor — never a bystander. If two unrelated regions
  are both deficient in the same pass, the lower-priority one of the two is
  dropped first, then the pass re-checks from scratch.

Within a single element, degradation is ordered **shrink → truncate → drop**:
shrinking and truncating are always tried first (and are usually sufficient –
see the Mobile Landscape / Micro Kiosk traces), and only an element that *still*
can't meet its hard floor after those is dropped.

## TypeScript design

- `spec.ts`: `ElementType`, `Role`, and `Priority` are literal unions, so an
  unknown role or a non-element type is a compile-time error at the call
  site. `defineAd()` additionally validates at runtime (duplicate ids, unknown
  role, non-positive priority, empty content) — belt-and-suspenders, since a
  spec can also be constructed from non-typechecked data (e.g. a JSON import)
  at runtime.
- `surfaces.ts`: `SurfaceProfile` is a plain interface; `classifySurface()`
  throws on non-positive dimensions or a safe-area/bleed combination that
  eats the entire surface, so a malformed surface fails immediately with a
  specific message rather than producing `NaN` positions three layers later.
- `resolver.ts`: `ResolvedLayout` and `ResolvedElementLayout` are fully typed
  (`x`, `y`, `width`, `height`, `visible`, optional `fontSize` /
  `truncated` / `displayText`) — a renderer consumes this with autocomplete
  and no guessing. `TextMeasurer` is an injectable function type, which keeps
  the resolver DOM-free/testable while the real app supplies a
  canvas-`measureText`-backed implementation (`measure-text.ts`).
- Template authoring itself is type-checked and self-validated: adding a slot
  with a role that doesn't exist on `Role` is a compile error; two slots
  accidentally claiming the same role, or overlapping in fractional space, is
  a runtime error thrown once at module load (`validateTemplate()`), not a
  bug waiting to be found by a specific test case.

## Resolution flow

```
AdSpec + SurfaceProfile
        │
        ▼
classifySurface()  ──►  aspectClass, isTouch, isFarViewing, contentBox
        │
        ▼
resolve()  (resolver.ts)
  1. pick region template for aspectClass
  2. assign elements to regions by role
  3. compute each element's hard floor
  4. contention pass (shared regions)
  5. safety-net pass (global)
  6. finalize geometry: fit / shrink / truncate
  7. assertValidLayout()
        │
        ▼
ResolvedLayout  { elements: [{ id, x, y, width, height, visible, ... }], trace }
        │
        ├──► render-dom.tsx     (absolutely-positioned DOM/CSS)
        └──► render-canvas.tsx  (Canvas 2D — same input, zero resolver changes)
```

## AI Tool Disclosure

AI tools were used during development for code assistance, debugging, testing,
and exploring different implementation approaches. They were also used to
suggest alternative solutions and trade-offs when making technical decisions.
While AI provided these options and recommendations, the final implementation
choices and technical decisions were evaluated and made by me. The final
implementation was reviewed and validated against the assignment requirements.

## Known limitations

- **No text wrapping.** Text is single-line; overflow is handled by shrinking
  the font down to a floor and then truncating with `"…"`, rather than wrapping
  onto multiple lines. The resolver does use real text measurement when
  determining what content fits.

- **A solo-slot element dropping doesn't reclaim space.** If a whole
  solo-occupied region (hero, primary, or branding) is dropped, its region
  goes blank rather than being reclaimed by a neighboring region. Only
  regions that share a slot (price/CTA) redistribute space among the
  survivors. This keeps the algorithm predictable and avoids unnecessary
  reflow, at the cost of leaving some unused space.

- **Fixed element type set.** `text | image | button` only, matching the
  brief; no video, carousel, or richer composite element types.

- **Accessibility constraint support is partial.** `minTapTarget` is a
  first-class hard constraint enforced end-to-end. Contrast-aware branding
  placement (the bonus item) is not implemented; it would require additional
  image/background analysis and placement logic, which is out of scope for
  the current implementation.

- **No animation between arbitrary layout states.** The DOM renderer uses
  CSS transitions for position, size, and opacity when switching surfaces,
  but there is no orchestrated surface-to-surface morphing sequence.

- **`RegionTemplate` fractions are hand-tuned.** The templates are authored
  for the current `tall`, `wide`, and `square` aspect classes rather than
  being derived from content. An unusual aspect ratio is still resolved
  through the same pipeline, but it will be assigned to one of these three
  classes based on the current thresholds (`< 0.8`, `> 1.3`, otherwise
  `square`). These thresholds and templates would be the areas to extend if
  additional aspect categories were needed.

## Time spent

Approximately **3 days** in total, covering the design and implementation of
the adaptive layout engine, TypeScript type design, constraint resolution,
priority-based degradation, DOM/Canvas rendering, automated and manual
testing, extreme-condition testing, debugging, documentation, and deployment. 
