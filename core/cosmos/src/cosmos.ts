import { Graph } from "@cosmos.gl/graph";
import { CONFIG } from "./config";
import { GraphData } from "./graph-data";
import type { State } from "./state";
import { palette } from "./theme";

export interface CosmosCallbacks {
  onClick?: (index: number | undefined) => void;
  onHover?: (nodeId: string | null) => void;
  onSimulationEnd?: () => void;
}

export class CosmosGraph {
  readonly gl: Graph;
  readonly data = new GraphData();
  private tickCount = 0;
  private tickListeners: Array<(tick: number) => void> = [];

  constructor(container: HTMLDivElement, callbacks: CosmosCallbacks = {}) {
    this.gl = new Graph(container, {
      backgroundColor: palette.background,
      spaceSize: CONFIG.spaceSize,
      rescalePositions: true,
      fitViewOnInit: false,

      simulationFriction: CONFIG.friction,
      simulationGravity: CONFIG.gravity,
      simulationCenter: CONFIG.center,
      simulationRepulsion: CONFIG.repulsion,
      simulationRepulsionTheta: CONFIG.repulsionTheta,
      simulationLinkSpring: CONFIG.linkSpring,
      simulationLinkDistance: CONFIG.linkDistance,
      simulationDecay: CONFIG.decay,

      pointDefaultColor: "#b3b3b3",
      pointDefaultSize: 4,
      pointSizeScale: CONFIG.pointSizeScale,
      scalePointsOnZoom: CONFIG.scalePointsOnZoom,
      pointOpacity: CONFIG.pointOpacity,
      pointGreyoutOpacity: CONFIG.greyoutOpacity,

      linkDefaultColor: "#444444",
      linkDefaultWidth: CONFIG.linkWidth,
      linkOpacity: CONFIG.linkOpacity,
      curvedLinks: false,

      enableSimulationDuringZoom: true,
      enableDrag: true,
      renderHoveredPointRing: false,
      hoveredPointCursor: "pointer",

      onDragStart: () => this.gl.start(1),
      onDrag: () => this.gl.start(CONFIG.dragReheatAlpha),

      onClick: (index) => callbacks.onClick?.(index),
      onMouseMove: (index) => {
        const id = index !== undefined ? this.data.idOf(index) ?? null : null;
        callbacks.onHover?.(id);
      },
      onSimulationEnd: () => callbacks.onSimulationEnd?.(),
      onSimulationTick: () => {
        this.tickCount++;
        if (this.tickCount === 1) this.gl.fitView(0, CONFIG.fitPadding);
        for (const fn of this.tickListeners) fn(this.tickCount);
      },
    });
  }

  onTick(fn: (tick: number) => void): void {
    this.tickListeners.push(fn);
  }

  readPositions(): Map<string, [number, number]> {
    const map = new Map<string, [number, number]>();
    try {
      const pos = this.gl.getPointPositions();
      if (!pos || pos.length === 0) return map;
      const ids = this.data.allIds();
      for (let i = 0; i < ids.length; i++) {
        map.set(ids[i], [pos[i * 2], pos[i * 2 + 1]]);
      }
    } catch { /* no positions yet */ }
    return map;
  }

  applyState(state: State, preservePositions = false, reheatAlpha?: number): void {
    const existing = preservePositions ? this.readPositions() : undefined;
    this.data.rebuild(state, existing);
    this.gl.setPointPositions(this.data.positions);
    this.gl.setPointColors(this.data.colors);
    this.gl.setPointSizes(this.data.sizes);
    this.gl.setLinks(this.data.links);
    this.gl.setLinkColors(this.data.linkColors);
    this.gl.render();
    this.gl.start(reheatAlpha);
  }

  applyMetaUpdate(state: State): void {
    this.data.updateMeta(state);
    this.gl.setPointColors(this.data.colors);
    this.gl.render();
  }

  pushColors(): void {
    this.gl.setPointColors(this.data.colors);
    this.gl.setLinkColors(this.data.linkColors);
  }

  pushImages(images: ImageData[], indices: Float32Array, sizes: Float32Array): void {
    if (images.length > 0) this.gl.setImageData(images);
    this.gl.setPointImageIndices(indices);
    this.gl.setPointImageSizes(sizes);
  }

  render(): void {
    this.gl.render();
  }

  applyConfig(): void {
    this.gl.setConfig({
      spaceSize: CONFIG.spaceSize,
      simulationFriction: CONFIG.friction,
      simulationGravity: CONFIG.gravity,
      simulationCenter: CONFIG.center,
      simulationRepulsion: CONFIG.repulsion,
      simulationRepulsionTheta: CONFIG.repulsionTheta,
      simulationLinkSpring: CONFIG.linkSpring,
      simulationLinkDistance: CONFIG.linkDistance,
      simulationDecay: CONFIG.decay,
      pointSizeScale: CONFIG.pointSizeScale,
      pointOpacity: CONFIG.pointOpacity,
      pointGreyoutOpacity: CONFIG.greyoutOpacity,
      linkDefaultWidth: CONFIG.linkWidth,
      linkOpacity: CONFIG.linkOpacity,
    });
  }

  setBackground(color: string): void {
    this.gl.setConfig({ backgroundColor: color });
  }

  reheat(alpha = 0.5): void {
    this.gl.start(alpha);
  }

  fitView(): void {
    this.gl.fitView(CONFIG.fitDuration, CONFIG.fitPadding);
  }

  zoomToNode(index: number): void {
    this.gl.zoomToPointByIndex(index, CONFIG.fitDuration);
  }

  destroy(): void {
    this.gl.destroy();
  }
}
