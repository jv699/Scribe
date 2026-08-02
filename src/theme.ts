/**
 * Unified app palette: burnt-orange accent over flat, dark, neutral surfaces.
 * Every color in the UI should come from here — no ad-hoc hex literals.
 */
export const theme = {
  /** Burnt orange — titles, dialog borders, selected items, primary buttons. */
  accent: "#CC5500",
  /** Brighter orange — hover/focus state on accent-colored controls. */
  accentHover: "#E86A1C",

  /** Primary text (also text on accent backgrounds). */
  text: "#FFFFFF",
  /** Body text — peeks, descriptions. */
  textDim: "#AAAAAA",
  /** Metadata — paths, timestamps, secondary info. */
  textMuted: "#888888",

  /** Dialog/window background. */
  surface: "#111111",
  /** Inputs, ghost buttons. */
  surfaceRaised: "#222222",
  /** Focused inputs, hovered ghost buttons. */
  surfaceActive: "#333333",

  /** Validation errors and destructive hints. */
  danger: "#FF5555",

  /** Flame spinner palette — tip to base (coolest to hottest). */
  flameEmber: "#A63B00",
  flameCore: "#FFB84D",
} as const;
