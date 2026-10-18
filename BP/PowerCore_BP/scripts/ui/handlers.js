import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { system, world } from "@minecraft/server";

function nextForm(fn) {
  system.run(() => {
    try {
      fn();
    } catch (e) {
      console.warn("[PowerCore] form", e);
    }
  });
}

function isAdmin(player) {
  try {
    if (typeof player.isOp === "function" && player.isOp()) return true;
  } catch (e) {}
  try {
    if (player.hasTag && player.hasTag("powercore_admin")) return true;
  } catch (e) {}
  return false;
}

const BLOCK_TYPES = {
  "powercore:generator_diesel": "generator_diesel",
  "powercore:generator_solar": "generator_solar",
  "powercore:transformer": "transformer",
  "powercore:power_pole": "power_pole",
  "powercore:substation": "substation",
  "powercore:meter": "meter",
  "powercore:control_panel": "control_panel"
};

export function setupUIHandlers(grid) {
  world.afterEvents.itemUse.subscribe((event) => {
    const item = event.itemStack;
    if (!item) return;
    const player = event.source;
    if (item.typeId === "powercore:multimeter") {
      nextForm(() => showMultimeter(player, grid));
    } else if (item.typeId === "powercore:utility_bill") {
      player.sendMessage("§7Utility bills post to linked FinanceCore accounts from the control panel.");
    }
  });

  world.afterEvents.playerInteractWithBlock.subscribe((event) => {
    const block = event.block;
    if (!block) return;
    const id = block.typeId;
    const type = BLOCK_TYPES[id];
    if (!type) return;
    event.cancel = true;
    const player = event.player;
    const dim = block.dimension.id;
    let node = grid.getNodeAt(block.x, block.y, block.z, dim);
    if (!node) {
      node = grid.registerNode(type, block.x, block.y, block.z, dim, player.name);
      player.sendMessage(`§aRegistered §f${type} §7${node.id}`);
    }
    nextForm(() => showNodeMenu(player, grid, node));
  });

  world.afterEvents.playerBreakBlock.subscribe((event) => {
    try {
      const perm = event.brokenBlockPermutation;
      const typeId = perm && perm.type ? perm.type.id : null;
      if (!typeId || !typeId.startsWith("powercore:")) return;
      const b = event.block;
      const removed = grid.deregisterAt(b.x, b.y, b.z, event.player?.dimension?.id || b.dimension?.id);
      if (removed && event.player) {
        event.player.sendMessage(`§eRemoved grid node §f${removed.id}`);
      }
    } catch (e) {}
  });
}

function showMultimeter(player, grid) {
  const s = grid.formatStatus();
  new ActionFormData()
    .title("Multimeter")
    .body(s.text)
    .button("Open control tips")
    .button("Close")
    .show(player)
    .then((res) => {
      if (res.canceled || res.selection === 1) return;
      player.sendMessage("§7Place generators, poles, transformers, meters. Range ~24 blocks.");
      player.sendMessage("§7Diesel needs refuel. Solar works daytime. Overload trips gear.");
      player.sendMessage("§7Link meters to FinanceCore accounts at the meter menu.");
    });
}

function showNodeMenu(player, grid, node) {
  const status = grid.gridStatus();
  const powered = status.powered.has(node.key);
  let body =
    `§f${node.type}\n§7${node.id}\n` +
    `§7Powered: ${powered ? "§aYES" : "§cNO"}\n` +
    `§7Online: ${node.online ? "§aON" : "§cOFF"}` +
    (node.broken ? " §cTRIPPED" : "");
  if (node.type === "generator_diesel") body += `\n§7Fuel: §f${node.fuel || 0}%`;
  if (node.type === "generator_solar") body += `\n§7Output: §f${node.generation} (day)`;

  const form = new ActionFormData().title("Grid equipment").body(body);

  if (node.type === "control_panel") {
    form.button("Grid status");
    form.button("Issue utility bills");
    form.button("Price settings");
    form.button("Close");
    form.show(player).then((res) => {
      if (res.canceled || res.selection === 3) return;
      if (res.selection === 0) {
        const s = grid.formatStatus();
        player.sendMessage("§b" + s.text.replace(/\n/g, " · "));
      }
      if (res.selection === 1) {
        const bills = grid.issueBills();
        player.sendMessage(
          bills.length ? `§aIssued ${bills.length} bill(s)` : "§7No usage to bill"
        );
        for (const b of bills.slice(0, 5)) {
          player.sendMessage(
            `§7${b.customer || "?"} §f$${b.amount.toFixed(2)} §8(${b.kwh} kWh)` +
              (b.charged ? " §acharged" : " §eunlinked")
          );
        }
      }
      if (res.selection === 2) {
        if (!isAdmin(player)) return player.sendMessage("§cOps only");
        nextForm(() => {
          new ModalFormData()
            .title("Utility rates")
            .textField("Price per kWh", String(grid.settings.kwhPrice || 0.12))
            .textField("Connection range", String(grid.settings.connectionRange || 24))
            .show(player)
            .then((r) => {
              if (r.canceled) return;
              const p = Number(r.formValues[0]);
              const range = Number(r.formValues[1]);
              if (Number.isFinite(p) && p >= 0) grid.settings.kwhPrice = p;
              if (Number.isFinite(range) && range > 4) grid.settings.connectionRange = range;
              grid.save();
              player.sendMessage("§aSaved");
            });
        });
      }
    });
    return;
  }

  if (node.type === "meter") {
    const m = grid.meters.get(node.key) || { kwh: 0 };
    body += `\n§7Usage: §f${(m.kwh || 0).toFixed(2)} kWh`;
    if (m.accountId) body += `\n§7Account: §f${m.accountId}`;
    form.body(body);
    form.button("Link FinanceCore account id");
    form.button("Toggle meter online");
    form.button("Close");
    form.show(player).then((res) => {
      if (res.canceled || res.selection === 2) return;
      if (res.selection === 0) {
        nextForm(() => {
          new ModalFormData()
            .title("Link account")
            .textField("FinanceCore account id", m.accountId || "acc_1000")
            .show(player)
            .then((r) => {
              if (r.canceled) return;
              const id = String(r.formValues[0] || "").trim();
              grid.linkMeterToAccount(node.key, id, player.name);
              player.sendMessage("§aMeter linked to " + id);
            });
        });
      }
      if (res.selection === 1) {
        const r = grid.toggleNode(node.key);
        player.sendMessage(r.online ? "§aMeter online" : "§eMeter offline");
      }
    });
    return;
  }

  if (node.type === "generator_diesel") {
    form.button("Refuel +50");
    form.button("Toggle online");
    form.button("Close");
    form.show(player).then((res) => {
      if (res.canceled || res.selection === 2) return;
      if (res.selection === 0) {
        const r = grid.refuelDiesel(node.key, 50);
        player.sendMessage(r.ok ? `§aFuel ${r.fuel}%` : `§c${r.error}`);
      }
      if (res.selection === 1) {
        const r = grid.toggleNode(node.key);
        player.sendMessage(r.online ? "§aOnline" : "§eOffline");
      }
    });
    return;
  }

  // Generic: poles, transformers, solar, substation
  form.button(node.broken ? "Replace fuse" : "Trip breaker (test)");
  form.button("Toggle online");
  form.button("Close");
  form.show(player).then((res) => {
    if (res.canceled || res.selection === 2) return;
    if (res.selection === 0) {
      if (node.broken) {
        // consume fuse if present
        let used = false;
        try {
          const inv = player.getComponent("inventory")?.container;
          if (inv) {
            for (let i = 0; i < inv.size; i++) {
              const it = inv.getItem(i);
              if (it && it.typeId === "powercore:fuse") {
                if (it.amount <= 1) inv.setItem(i, undefined);
                else {
                  it.amount -= 1;
                  inv.setItem(i, it);
                }
                used = true;
                break;
              }
            }
          }
        } catch (e) {}
        if (!used) {
          player.sendMessage("§cNeed a fuse item");
          return;
        }
        grid.replaceFuse(node.key);
        player.sendMessage("§aFuse replaced — back online");
      } else {
        grid.tripBreaker(node.key);
        player.sendMessage("§eBreaker tripped");
      }
    }
    if (res.selection === 1) {
      const r = grid.toggleNode(node.key);
      player.sendMessage(r.online ? "§aOnline" : "§eOffline");
    }
  });
}
