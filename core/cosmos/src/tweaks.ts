import { Pane } from "tweakpane";
import { CONFIG } from "./config";
import type { CosmosGraph } from "./cosmos";

export function mountTweakpane(graph: CosmosGraph): void {
  const pane = new Pane({ title: "debug", expanded: false }) as any;

  const onChange = () => {
    graph.applyConfig();
    graph.reheat(0.3);
  };

  const sim = pane.addFolder({ title: "Simulation", expanded: false });
  sim.addBinding(CONFIG, "gravity", { min: 0, max: 5, step: 0.05 }).on("change", onChange);
  sim.addBinding(CONFIG, "center", { min: 0, max: 5, step: 0.05 }).on("change", onChange);
  sim.addBinding(CONFIG, "repulsion", { min: 0, max: 50, step: 0.5 }).on("change", onChange);
  sim.addBinding(CONFIG, "repulsionTheta", { min: 0.1, max: 5, step: 0.1 }).on("change", onChange);
  sim.addBinding(CONFIG, "friction", { min: 0, max: 1, step: 0.01 }).on("change", onChange);
  sim.addBinding(CONFIG, "decay", { min: 100, max: 10000, step: 50 }).on("change", onChange);
  sim.addBinding(CONFIG, "spaceSize", { min: 1024, max: 16384, step: 256 }).on("change", onChange);

  const links = pane.addFolder({ title: "Links", expanded: false });
  links.addBinding(CONFIG, "linkSpring", { min: 0, max: 2, step: 0.05 }).on("change", onChange);
  links.addBinding(CONFIG, "linkOpacity", { min: 0, max: 1, step: 0.01 }).on("change", onChange);
  links.addBinding(CONFIG, "linkWidth", { min: 0.1, max: 10, step: 0.1 }).on("change", onChange);

  const points = pane.addFolder({ title: "Points", expanded: false });
  points.addBinding(CONFIG, "pointSizeScale", { min: 0.1, max: 5, step: 0.1 }).on("change", onChange);
  points.addBinding(CONFIG, "pointOpacity", { min: 0, max: 1, step: 0.01 }).on("change", onChange);
  points.addBinding(CONFIG, "greyoutOpacity", { min: 0, max: 1, step: 0.01 }).on("change", onChange);

  const actions = pane.addFolder({ title: "Actions", expanded: false });
  actions.addButton({ title: "Reheat" }).on("click", () => graph.reheat(1.0));
  actions.addButton({ title: "Fit View" }).on("click", () => graph.fitView());
}
