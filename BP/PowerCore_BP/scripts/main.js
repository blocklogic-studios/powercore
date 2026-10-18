import { system, world } from "@minecraft/server";
import { GridManager } from "./core/GridManager.js";
import { setupUIHandlers } from "./ui/handlers.js";

export const grid = new GridManager();

const COMPONENT_IDS = [
  "powercore:generator_diesel",
  "powercore:generator_solar",
  "powercore:transformer",
  "powercore:power_pole",
  "powercore:substation",
  "powercore:meter",
  "powercore:control_panel"
];

system.beforeEvents.startup.subscribe((event) => {
  const reg = event.blockComponentRegistry;
  for (const id of COMPONENT_IDS) {
    reg.registerCustomComponent(id, {
      onPlayerInteract() {
        /* menus in playerInteractWithBlock */
      }
    });
  }
  console.log("[PowerCore] Components registered");
});

world.afterEvents.worldLoad.subscribe(() => {
  grid.load();
  setupUIHandlers(grid);
  console.log("[PowerCore] Grid ready");
});

system.runInterval(() => {
  grid.tick();
}, 20);

console.log("[PowerCore] Script started");
