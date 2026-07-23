/**
 * Every colour and size the renderer uses.
 *
 * Centralised so the map's look can be retuned in one file. The palette
 * deliberately imitates a printed 1940s staff map: desaturated ochre land,
 * ink-blue water, red/blue counters.
 */
export const theme = {
  background: 0x101820,

  map: {
    sea: 0x16202c,
    land: 0x2e3428,
    landOutline: 0x5c6450,
    lake: 0x1c2a3a,
    river: 0x3d6a8a,
    riverMajorWidthPx: 2.2,
    riverMinorWidthPx: 1.1,
    coastWidthPx: 1.2,
    graticule: 0x232c38,
  },

  terrainOverlayAlpha: 0.55,

  border: {
    major: 0xd6c08a,
    minor: 0xa89a78,
    casing: 0x0a0e14,
    label: 0xcdbd93,
  },

  city: {
    dot: 0xd9cfae,
    label: 0xcfc6a8,
    capitalDot: 0xf0e2b6,
  },

  unit: {
    widthPx: 42,
    heightPx: 28,
    selectedOutline: 0xffe680,
    hoverOutline: 0xffffff,
    strengthBarBg: 0x000000,
    strengthBar: 0x8fd06a,
    orgBar: 0x6aa9d0,
  },

  battle: {
    radiusPx: 15,
    rim: 0xf0d99a,
    blades: 0xf5ead0,
  },

  order: {
    line: 0xffe680,
    lineAlpha: 0.75,
    widthPx: 1.6,
    waypointRadiusPx: 3,
  },

  objective: {
    attack: 0xe0645a,
    defense: 0x6aa9d0,
    radiusPx: 12,
    widthPx: 2,
  },

  selectionBox: {
    fill: 0x8fd0ff,
    fillAlpha: 0.12,
    stroke: 0xbfe4ff,
  },
} as const;

/** Zoom limits, in screen pixels per world kilometre. */
export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 4.0;
