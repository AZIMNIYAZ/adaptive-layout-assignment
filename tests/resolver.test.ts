/**
 * resolver.test.ts
 * -----------------------------------------------------------------------
 * Plain assertions run via `npm test` (tsx + node:assert) — no test
 * framework dependency needed for a repo this size. Run automatically
 * doesn't happen in CI here, but `npm test` is wired up in package.json.
 * -----------------------------------------------------------------------
 */
import assert from "node:assert/strict";
import { defineAd } from "../src/spec";
import { surfaces } from "../src/surfaces";
import { resolve } from "../src/resolver";
import { trailAd } from "../src/demoAd";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`FAIL  ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

console.log("resolver.test.ts");

test("every preset surface resolves without throwing (invariant check passes internally)", () => {
  for (const surface of Object.values(surfaces)) {
    const layout = resolve(trailAd, surface);
    assert.ok(layout.elements.length === trailAd.elements.length);
  }
});

test("tall vs wide vs square produce structurally different compositions, not just scaled copies", () => {
  const tall = resolve(trailAd, surfaces.mobilePortrait);
  const wide = resolve(trailAd, surfaces.broadcastLowerThird);
  const square = resolve(trailAd, surfaces.retailKiosk);
  assert.equal(tall.aspectClass, "tall");
  assert.equal(wide.aspectClass, "wide");
  assert.equal(square.aspectClass, "square");

  const find = (layout: typeof tall, id: string) => layout.elements.find((e) => e.id === id)!;

  // TALL: stacked — headline sits *below* the hero image, not beside it.
  const heroTall = find(tall, "product-image");
  const headlineTall = find(tall, "headline");
  assert.ok(headlineTall.y > heroTall.y + heroTall.height - 1, "tall: headline should stack below the hero image");

  // WIDE: banded — headline sits roughly *beside* the hero image (similar y, hero is narrow), not below it.
  const heroWide = find(wide, "product-image");
  const headlineWide = find(wide, "headline");
  assert.ok(headlineWide.x > heroWide.x + heroWide.width - 1, "wide: headline should sit to the right of a narrow hero band");
  assert.ok(Math.abs(headlineWide.y - heroWide.y) < heroWide.height, "wide: headline and hero should share roughly the same vertical band");

  // SQUARE: hero dominates the top; headline+price+CTA compress into a band underneath.
  const heroSquare = find(square, "product-image");
  const headlineSquare = find(square, "headline");
  assert.ok(heroSquare.height > heroSquare.width * 0.5, "square: hero should be a tall-ish dominant block, not a thin strip");
  assert.ok(headlineSquare.y > heroSquare.y + heroSquare.height - 1, "square: headline should stack below the hero image, like tall");

  // But square and tall are NOT identical either — square's hero occupies a much larger share of total area.
  const heroAreaShareTall = (heroTall.width * heroTall.height) / (tall.surfaceWidth * tall.surfaceHeight);
  const heroAreaShareSquare = (heroSquare.width * heroSquare.height) / (square.surfaceWidth * square.surfaceHeight);
  assert.notEqual(heroAreaShareTall.toFixed(2), heroAreaShareSquare.toFixed(2));
});

test("microKiosk (intentionally tight) drops branding but keeps headline/CTA visible", () => {
  const layout = resolve(trailAd, surfaces.microKiosk);
  const logo = layout.elements.find((e) => e.id === "logo")!;
  const headline = layout.elements.find((e) => e.id === "headline")!;
  const cta = layout.elements.find((e) => e.id === "cta")!;
  assert.equal(logo.visible, false, "branding should be dropped");
  assert.equal(headline.visible, true, "priority-1 headline must survive");
  assert.equal(cta.visible, true, "CTA must survive");
});

test("dropping one element never cascades into dropping unrelated ones needlessly", () => {
  // Regression test for the bug found during development: the safety-net pass used to drop
  // the globally lowest-priority element instead of the one actually causing a deficit,
  // cascading a single tight region into wiping out almost the whole ad.
  const layout = resolve(trailAd, surfaces.mobileLandscape);
  const visibleCount = layout.elements.filter((e) => e.visible).length;
  assert.equal(visibleCount, 5, `expected all 5 elements visible on mobileLandscape, got ${visibleCount}`);
});

test("a surface unknown at design time (arbitrary custom profile) still resolves cleanly", () => {
  const weird = {
    id: "unseen",
    name: "Unseen 777x233",
    width: 777,
    height: 233,
    safeArea: { top: 10, right: 10, bottom: 10, left: 10 },
    touchOnly: true,
    minTapTarget: 48,
    viewingDistance: "far" as const,
    minTextSize: 20,
  };
  const layout = resolve(trailAd, weird);
  assert.ok(layout.elements.length === 5);
});

test("defineAd rejects an unknown role at construction time", () => {
  assert.throws(() =>
    defineAd({
      elements: [
        // @ts-expect-error deliberately invalid role, should be a type error AND a runtime error
        { id: "x", type: "text", role: "not-a-real-role", priority: 1, content: "hi" },
      ],
    })
  );
});

test("defineAd rejects duplicate element ids", () => {
  assert.throws(() =>
    defineAd({
      elements: [
        { id: "dup", type: "text", role: "primary", priority: 1, content: "a" },
        { id: "dup", type: "text", role: "secondary", priority: 2, content: "b" },
      ],
    })
  );
});

console.log(`\n${passed} test(s) passed.`);
