import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// Whether the viewer asked their system for less motion. The hook re-renders when they change it with the page open;
// the plain function is for code outside React (the task runner's pauses).
const lessMotion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
export const prefersReducedMotion = () => lessMotion?.matches === true;
function onMotionChange(notify) {
  lessMotion?.addEventListener("change", notify);
  return () => lessMotion?.removeEventListener("change", notify);
}
export const useReducedMotion = () => useSyncExternalStore(onMotionChange, prefersReducedMotion, () => false);

// An element's width in CSS pixels, so an SVG chart can draw its text at the size it shows. One ResizeObserver
// serves every chart on the page; a width of 0 (a hidden tab) keeps the last one.
const widthSetters = new Map();
let sizes = null;
function measure(el, setWidth) {
  sizes ??= new ResizeObserver((entries) => {
    for (const { target, contentRect } of entries) {
      const px = Math.round(contentRect.width);
      if (px > 0) widthSetters.get(target)?.(px);
    }
  });
  widthSetters.set(el, setWidth);
  sizes.observe(el);
  return () => {
    widthSetters.delete(el);
    sizes.unobserve(el);
  };
}
export function useWidth(fallback = 600) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => (ref.current ? measure(ref.current, setWidth) : undefined), []);
  return [ref, width];
}
