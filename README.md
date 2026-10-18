# PowerCore

Realistic **power grid** for Minecraft Bedrock **1.26+**.

Generation → poles / transformers / substations → meters → bills.

## Features (v1.0.0)

- **Diesel generator** (fuel, refuel)
- **Solar array** (daytime output)
- **Power poles**, **transformers**, **substations**
- **Utility meters** (kWh accumulation when powered)
- **Grid control panel** (status, issue bills, rates)
- **Multimeter** item
- **Fuses** to repair tripped gear
- **Overload** can trip transformers/substations
- **FinanceCore bridge** — bill linked account ids
- **CarrierCore bridge** — publishes `gridOnline` for other packs

## Install

1. Download the `.mcaddon` from [Releases](https://github.com/blocklogic-studios/powercore/releases)
2. Enable **PowerCore Resources** + **PowerCore Behavior**
3. Turn on **Beta APIs**

Optional: **FinanceCore** (meter → account billing), **CarrierCore** (read power bridge).

## Quick start

1. Place a **diesel generator** or **solar array**
2. Place **power poles** toward your base (≤ ~24 blocks apart)
3. Place a **meter** at the load
4. Click equipment to register it on the grid
5. **Control panel** → grid status / issue bills
6. On a meter → link `acc_####` from FinanceCore

## Studio

[Blocklogic Studio](https://github.com/blocklogic-studios)
