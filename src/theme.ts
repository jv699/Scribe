/** All UI colors belong here. */
export const theme = {
  background: "#1d1d1d",

  accent: "#CC5500",
  accentHover: "#E86A1C",

  /** Also used on accent backgrounds. */
  text: "#FFFFFF",
  /** Body text and descriptions. */
  textDim: "#AAAAAA",
  /** Metadata and secondary information. */
  textMuted: "#888888",

  /** Dialog/window background. */
  surface: "#111111",
  /** Inputs, ghost buttons. */
  surfaceRaised: "#222222",
  /** Focused inputs, hovered ghost buttons. */
  surfaceActive: "#333333",

  danger: "#FF5555",

  /** Markdown highlights, coolest to hottest. */
  flameEmber: "#A63B00",
  flameCore: "#FFB84D",
} as const;
