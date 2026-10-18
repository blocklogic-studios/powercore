import { world } from "@minecraft/server";

const SAVE_KEY = "powercore:state";
const BRIDGE_KEY = "powercore:grid_bridge";
const FINANCE_BRIDGE = "financecore:power_bridge";
const CARRIER_BRIDGE = "carriercore:power_bridge";

/** Generation MW ratings */
const GEN_RATE = {
  generator_diesel: 50,
  generator_solar: 25
};

/** Load draw when online */
const LOAD_DRAW = {
  meter: 2,
  substation: 5,
  transformer: 1,
  control_panel: 1,
  power_pole: 0
};

function keyAt(dim, x, y, z) {
  return `${dim}:${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export class GridManager {
  constructor() {
    this.nodes = new Map(); // key -> node
    this.meters = new Map(); // key -> meter account link
    this.settings = {
      kwhPrice: 0.12,
      connectionRange: 24,
      solarDayOnly: true,
      billIntervalTicks: 24000
    };
    this.nextIds = { node: 1, bill: 1 };
    this._tick = 0;
    this.lastGridOnline = true;
  }

  load() {
    try {
      const raw = world.getDynamicProperty(SAVE_KEY);
      if (raw && typeof raw === "string") {
        const data = JSON.parse(raw);
        if (data.nodes) this.nodes = new Map(data.nodes);
        if (data.meters) this.meters = new Map(data.meters);
        if (data.settings) this.settings = { ...this.settings, ...data.settings };
        if (data.nextIds) this.nextIds = { ...this.nextIds, ...data.nextIds };
      }
    } catch (e) {
      console.warn("[PowerCore] load", e);
    }
    console.log(`[PowerCore] ${this.nodes.size} grid nodes`);
  }

  save() {
    try {
      world.setDynamicProperty(
        SAVE_KEY,
        JSON.stringify({
          nodes: [...this.nodes.entries()],
          meters: [...this.meters.entries()],
          settings: this.settings,
          nextIds: this.nextIds
        })
      );
    } catch (e) {
      console.warn("[PowerCore] save", e);
    }
  }

  registerNode(type, x, y, z, dim, owner = null) {
    const key = keyAt(dim, x, y, z);
    const id = `node_${this.nextIds.node++}`;
    const node = {
      id,
      key,
      type,
      x: Math.floor(x),
      y: Math.floor(y),
      z: Math.floor(z),
      dim,
      owner,
      online: true,
      fuel: type === "generator_diesel" ? 100 : 0,
      generation: GEN_RATE[type] || 0,
      load: LOAD_DRAW[type] || 0,
      broken: false,
      registeredAt: Date.now()
    };
    this.nodes.set(key, node);
    if (type === "meter") {
      this.meters.set(key, {
        key,
        kwh: 0,
        accountId: null,
        customer: owner,
        lastBillAt: Date.now()
      });
    }
    this.save();
    return node;
  }

  deregisterAt(x, y, z, dim) {
    const key = keyAt(dim, x, y, z);
    const n = this.nodes.get(key);
    if (!n) return null;
    this.nodes.delete(key);
    this.meters.delete(key);
    this.save();
    return n;
  }

  getNode(key) {
    return this.nodes.get(key);
  }

  getNodeAt(x, y, z, dim) {
    return this.nodes.get(keyAt(dim, x, y, z));
  }

  /** Nodes within connection range of a point */
  neighbors(node) {
    const range = this.settings.connectionRange || 24;
    const out = [];
    for (const other of this.nodes.values()) {
      if (other.key === node.key) continue;
      if (other.dim !== node.dim) continue;
      if (dist(node, other) <= range) out.push(other);
    }
    return out;
  }

  /** BFS from generators through poles/transformers/substations */
  computePoweredSet(timeOfDay = 6000) {
    const powered = new Set();
    const queue = [];
    const day = timeOfDay >= 0 && timeOfDay < 12000;

    for (const n of this.nodes.values()) {
      if (n.broken || !n.online) continue;
      if (n.type === "generator_diesel" && (n.fuel || 0) > 0) {
        powered.add(n.key);
        queue.push(n);
      }
      if (n.type === "generator_solar") {
        if (!this.settings.solarDayOnly || day) {
          powered.add(n.key);
          queue.push(n);
        }
      }
    }

    const canRelay = new Set([
      "power_pole",
      "transformer",
      "substation",
      "meter",
      "control_panel",
      "generator_diesel",
      "generator_solar"
    ]);

    while (queue.length) {
      const cur = queue.shift();
      for (const nb of this.neighbors(cur)) {
        if (powered.has(nb.key)) continue;
        if (nb.broken || !nb.online) continue;
        if (!canRelay.has(nb.type)) continue;
        powered.add(nb.key);
        queue.push(nb);
      }
    }
    return powered;
  }

  totalGeneration(powered) {
    let g = 0;
    for (const key of powered) {
      const n = this.nodes.get(key);
      if (!n) continue;
      if (n.type === "generator_diesel" || n.type === "generator_solar") {
        g += n.generation || GEN_RATE[n.type] || 0;
      }
    }
    return g;
  }

  totalLoad(powered) {
    let l = 0;
    for (const key of powered) {
      const n = this.nodes.get(key);
      if (!n) continue;
      l += n.load || LOAD_DRAW[n.type] || 0;
      // meters represent customer load
      if (n.type === "meter") l += 8;
    }
    return l;
  }

  gridStatus() {
    let tod = 6000;
    try {
      tod = world.getTimeOfDay ? world.getTimeOfDay() : 6000;
    } catch (e) {}
    const powered = this.computePoweredSet(tod);
    const gen = this.totalGeneration(powered);
    const load = this.totalLoad(powered);
    const online = gen >= load && gen > 0;
    return { powered, gen, load, online, surplus: gen - load };
  }

  refuelDiesel(key, amount = 50) {
    const n = this.nodes.get(key);
    if (!n || n.type !== "generator_diesel") return { ok: false, error: "Not a diesel generator" };
    n.fuel = Math.min(100, (n.fuel || 0) + amount);
    n.online = true;
    n.broken = false;
    this.save();
    return { ok: true, fuel: n.fuel };
  }

  toggleNode(key) {
    const n = this.nodes.get(key);
    if (!n) return { ok: false, error: "Unknown node" };
    n.online = !n.online;
    this.save();
    return { ok: true, online: n.online };
  }

  tripBreaker(key) {
    const n = this.nodes.get(key);
    if (!n) return { ok: false, error: "Unknown node" };
    n.broken = true;
    n.online = false;
    this.save();
    return { ok: true };
  }

  replaceFuse(key) {
    const n = this.nodes.get(key);
    if (!n) return { ok: false, error: "Unknown node" };
    n.broken = false;
    n.online = true;
    this.save();
    return { ok: true };
  }

  linkMeterToAccount(meterKey, accountId, customerName) {
    const m = this.meters.get(meterKey) || { key: meterKey, kwh: 0 };
    m.accountId = accountId;
    m.customer = customerName;
    this.meters.set(meterKey, m);
    this.save();
    return { ok: true, meter: m };
  }

  /** Publish bridges for FinanceCore billing + CarrierCore tower power */
  publishBridges(status) {
    const payload = {
      online: status.online,
      generation: status.gen,
      load: status.load,
      surplus: status.surplus,
      meters: {},
      at: Date.now()
    };
    for (const [k, m] of this.meters) {
      payload.meters[k] = {
        kwh: m.kwh,
        accountId: m.accountId,
        customer: m.customer,
        powered: status.powered.has(k)
      };
    }
    try {
      world.setDynamicProperty(BRIDGE_KEY, JSON.stringify(payload));
      world.setDynamicProperty(CARRIER_BRIDGE, JSON.stringify({
        gridOnline: status.online,
        generation: status.gen,
        load: status.load,
        at: Date.now()
      }));
    } catch (e) {}

    // FinanceCore bill events
    if (status.online) {
      try {
        let fb = {};
        const raw = world.getDynamicProperty(FINANCE_BRIDGE);
        if (raw && typeof raw === "string") fb = JSON.parse(raw);
        if (!fb.pendingBills) fb.pendingBills = [];
        // accumulate only; actual charge can be applied by FinanceCore or control panel
        world.setDynamicProperty(FINANCE_BRIDGE, JSON.stringify(fb));
      } catch (e) {}
    }
  }

  /**
   * Issue utility bills into FinanceCore state if present.
   * Charges linked accountId for kWh * price.
   */
  issueBills() {
    const price = this.settings.kwhPrice || 0.12;
    const results = [];
    let finance = null;
    try {
      const raw = world.getDynamicProperty("financecore:state");
      if (raw && typeof raw === "string") finance = JSON.parse(raw);
    } catch (e) {}

    for (const [key, m] of this.meters) {
      const kwh = m.kwh || 0;
      if (kwh < 1) continue;
      const amount = round2(kwh * price);
      const bill = {
        id: `pwr_bill_${this.nextIds.bill++}`,
        meterKey: key,
        customer: m.customer,
        accountId: m.accountId,
        kwh: round2(kwh),
        amount,
        at: Date.now()
      };

      if (finance && m.accountId) {
        const accounts = finance.accounts || [];
        let found = false;
        for (let i = 0; i < accounts.length; i++) {
          const entry = accounts[i];
          const acc = Array.isArray(entry) ? entry[1] : entry;
          if (acc && acc.id === m.accountId) {
            acc.balance = round2((acc.balance || 0) - amount);
            if (!acc.ledger) acc.ledger = [];
            acc.ledger.push({
              type: "utility_bill",
              amount: -amount,
              note: `Power ${kwh} kWh`,
              at: Date.now()
            });
            if (acc.ledger.length > 50) acc.ledger = acc.ledger.slice(-50);
            if (Array.isArray(entry)) accounts[i] = [entry[0], acc];
            found = true;
            break;
          }
        }
        if (found) {
          finance.accounts = accounts;
          bill.charged = true;
          try {
            world.setDynamicProperty("financecore:state", JSON.stringify(finance));
          } catch (e) {}
        }
      }

      m.kwh = 0;
      m.lastBillAt = Date.now();
      this.meters.set(key, m);
      results.push(bill);
    }
    this.save();
    return results;
  }

  tick() {
    this._tick++;
    const status = this.gridStatus();

    // Consume diesel fuel slowly when generating
    if (this._tick % 100 === 0) {
      for (const n of this.nodes.values()) {
        if (n.type === "generator_diesel" && n.online && !n.broken && (n.fuel || 0) > 0) {
          n.fuel = Math.max(0, (n.fuel || 0) - 1);
          if (n.fuel <= 0) n.online = false;
        }
      }
    }

    // Meter kWh accumulation when powered
    if (status.online && this._tick % 20 === 0) {
      for (const [key, m] of this.meters) {
        if (status.powered.has(key)) {
          m.kwh = round2((m.kwh || 0) + 0.05);
          this.meters.set(key, m);
        }
      }
    }

    // Overload trips random transformer
    if (status.gen > 0 && status.load > status.gen * 1.15 && this._tick % 40 === 0) {
      const candidates = [...this.nodes.values()].filter(
        (n) => (n.type === "transformer" || n.type === "substation") && !n.broken
      );
      if (candidates.length) {
        const victim = candidates[Math.floor(Math.random() * candidates.length)];
        victim.broken = true;
        victim.online = false;
      }
    }

    if (this._tick % 40 === 0) {
      this.publishBridges(status);
      this.save();
    }

    // Periodic bills
    if (this._tick % (this.settings.billIntervalTicks || 24000) === 0) {
      this.issueBills();
    }

    this.lastGridOnline = status.online;
    return status;
  }

  formatStatus() {
    const s = this.gridStatus();
    return {
      ...s,
      text:
        `Grid ${s.online ? "ONLINE" : "OFFLINE"}\n` +
        `Gen ${s.gen} · Load ${s.load} · Surplus ${s.surplus}\n` +
        `Nodes powered ${s.powered.size}/${this.nodes.size}`
    };
  }
}
