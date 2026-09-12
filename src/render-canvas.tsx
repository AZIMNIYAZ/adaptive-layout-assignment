/**
 * render-canvas.tsx
 * -----------------------------------------------------------------------
 * Bonus: a second renderer, added without touching resolver.ts or
 * spec.ts at all. It consumes the exact same ResolvedLayout shape as
 * render-dom.tsx — proof that the resolution algorithm doesn't know or
 * care how its output gets painted.
 * -----------------------------------------------------------------------
 */
import { useEffect, useRef } from "react";
import type { AdSpec } from "./spec";
import type { ResolvedLayout } from "./resolver";
import { FONT_FAMILY_BODY, fontFamilyForRole, fontWeightForRole } from "./measure-text";

interface Props {
  spec: AdSpec;
  layout: ResolvedLayout;
  displayScale?: number;
}

const imageCache = new Map<string, HTMLImageElement>();
function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(src, img);
      resolve(img);
    };
    img.onerror = reject;
    img.src = src;
  });
}

export function CanvasAdRenderer({ spec, layout, displayScale = 1 }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const byId = new Map(spec.elements.map((e) => [e.id, e]));
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    const w = layout.surfaceWidth * displayScale;
    const h = layout.surfaceHeight * displayScale;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    let cancelled = false;

    async function draw() {
      const ctx = context!;
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#EDE8DE";
      ctx.fillRect(0, 0, w, h);

      for (const el of layout.elements) {
        if (!el.visible) continue;
        const spec_el = byId.get(el.id);
        if (!spec_el) continue;

        const x = el.x * displayScale;
        const y = el.y * displayScale;
        const width = el.width * displayScale;
        const height = el.height * displayScale;

        if (spec_el.type === "image") {
          try {
            const img = await loadImage(spec_el.src);
            if (cancelled) return;
            // Preserve aspect ratio within the box (same "contain" behavior as the DOM renderer).
            const ratio = img.naturalWidth / img.naturalHeight;
            let dw = width;
            let dh = width / ratio;
            if (dh > height) {
              dh = height;
              dw = height * ratio;
            }
            const dx = x + (width - dw) / 2;
            const dy = y + (height - dh) / 2;
            ctx.drawImage(img, dx, dy, dw, dh);
          } catch {
            // Missing/broken image asset: skip silently rather than crash the whole canvas frame.
          }
        } else if (spec_el.type === "button") {
          ctx.fillStyle = "#B5562D";
          roundRect(ctx, x, y, width, height, 4 * displayScale);
          ctx.fill();
          ctx.fillStyle = "#F6F3EA";
          ctx.font = `${fontWeightForRole(spec_el.role)} ${(el.fontSize ?? 14) * displayScale}px ${FONT_FAMILY_BODY}`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(el.displayText ?? "", x + width / 2, y + height / 2);
        } else {
          const isPrimary = spec_el.role === "primary";
          ctx.fillStyle = isPrimary ? "#1C2019" : "#55594F";
          ctx.font = `${fontWeightForRole(spec_el.role)} ${(el.fontSize ?? 14) * displayScale}px ${fontFamilyForRole(
            spec_el.role
          )}`;
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillText(el.displayText ?? "", x, y + height / 2, width);
        }
      }
    }

    draw();
    return () => {
      cancelled = true;
    };
  }, [spec, layout, displayScale]);

  return <canvas ref={canvasRef} className="ad-surface" />;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
