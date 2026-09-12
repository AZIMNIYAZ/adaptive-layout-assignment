import { defineAd } from "./spec";

/**
 * One product ad, defined once. Every surface in the demo resolves
 * *this exact object* — nothing about it changes per surface. If the
 * layouts still look meaningfully different across surfaces, that
 * difference came entirely from resolver.ts + surfaces.ts.
 */
export const trailAd = defineAd({
  id: "terra-descent",
  elements: [
    {
      id: "product-image",
      type: "image",
      role: "hero",
      priority: 1,
      src: "/ad-assets/shoe.svg",
      alt: "TERRA Descent trail running shoe, three-quarter view",
      aspectRatio: 640 / 440,
      minWidth: 60,
      minHeight: 40,
    },
    {
      id: "headline",
      type: "text",
      role: "primary",
      priority: 1,
      content: "Own the descent.",
      preferredFontSize: 26,
      minFontSize: 12,
    },
    {
      id: "price",
      type: "text",
      role: "secondary",
      priority: 2,
      content: "$139",
      preferredFontSize: 18,
      minFontSize: 10,
    },
    {
      id: "cta",
      type: "button",
      role: "action",
      priority: 2,
      label: "Shop now",
      preferredFontSize: 15,
      minFontSize: 11,
    },
    {
      id: "logo",
      type: "image",
      role: "branding",
      priority: 3,
      src: "/ad-assets/logo.svg",
      alt: "TERRA",
      aspectRatio: 220 / 70,
      minWidth: 18,
      minHeight: 18,
    },
  ],
});
