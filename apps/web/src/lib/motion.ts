/**
 * Framer Motion presets (DESIGN_NOTES.md — motion). One vocabulary for the
 * whole app so nothing animates off-brand.
 */
import type { Transition } from "framer-motion";

export const spring = {
  /** Layout moves, slide-ins, tab underlines. */
  default: { type: "spring", stiffness: 260, damping: 30 } as Transition,
  /** Micro-interactions: chips, buttons, count ticks. */
  snappy: { type: "spring", stiffness: 520, damping: 34 } as Transition,
  /** Row/section expand — damped, no bounce. */
  expand: { type: "spring", stiffness: 300, damping: 36 } as Transition,
};

/** Standard slide-in for list items (leads, feed cards). */
export const slideIn = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
};

/** Expand/collapse for detail rows. */
export const expand = {
  initial: { opacity: 0, height: 0 },
  animate: { opacity: 1, height: "auto" },
  exit: { opacity: 0, height: 0 },
};
