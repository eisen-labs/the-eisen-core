export const CONFIG = {
  // Simulation
  gravity: 0.2,
  center: 1,
  repulsion: 50,
  repulsionTheta: 3.0,
  friction: 0.95,
  decay: 1500,
  spaceSize: 16384,

  // Links
  linkSpring: 0.5,
  linkDistance: 30,
  linkOpacity: 0.8,
  linkWidth: 1.5,

  // Points
  pointSizeScale: 3.0,
  scalePointsOnZoom: true,
  pointOpacity: 1.0,
  greyoutOpacity: 0.15,

  // Drag
  dragReheatAlpha: 0.3,

  // View
  fitPadding: 0.15,
  fitDuration: 400,

  // Initial layout
  initialSpread: 500,
};

export type Config = typeof CONFIG;
