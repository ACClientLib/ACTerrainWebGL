import type { WorldObjectData, WorldObjectScalarProperties } from "../lib/acdatclient";
import names from "./itemnames.json";

export type ItemSpellText = Record<string, readonly string[]>;

const damageTypes = ["Slashing", "Piercing", "Bludgeoning", "Cold", "Fire", "Acid", "Electric", "Health", "Stamina", "Mana", "Nether"];
const attributes = ["", "Strength", "Endurance", "Coordination", "Quickness", "Focus", "Self"];
const vitals = ["", "Maximum Health", "Health", "Maximum Stamina", "Stamina", "Maximum Mana", "Mana"];
const number = (value: unknown): string => Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 });
const percent = (value: unknown): string => `${number(Number(value) * 100)}%`;
const name = (group: keyof typeof names, value: unknown): string => (names[group] as Record<string, string>)[String(value)] ?? String(value);

// Only describe properties available in the dataset. Live ownership, effective
// combat values and hosted-item profiles cannot be inferred from a raw weenie.
export function itemAppraisalText(object: WorldObjectData, spells: ItemSpellText = {}): string {
  const { int: i, float: f, bool: b, string: s } = object;
  const lines: string[] = [];
  const add = (label: string, value: unknown) => {
    if (value != null && value !== "") {
      lines.push(`${label}: ${value}`);
    }
  };
  const fields = (properties: WorldObjectScalarProperties, entries: Record<string, string>, format = number) => {
    for (const [key, label] of Object.entries(entries)) {
      if (properties[key] != null) {
        add(label, format(properties[key]));
      }
    }
  };
  add("Value", i.Value == null ? "???" : number(i.Value));
  add("Burden", i.EncumbranceVal == null ? "Unknown" : number(i.EncumbranceVal));
  if (i.MaterialType != null) {
    add("Material", name("MaterialType", i.MaterialType));
  }
  if (i.ItemWorkmanship != null) {
    const count = Number(i.NumItemsInMaterial ?? 1);
    add("Workmanship", number(Number(i.ItemWorkmanship) / (count > 0 ? count : 1)));
  }
  fields(i, { NumItemsInMaterial: "Salvaged items", NumTimesTinkered: "Times tinkered" });
  if (b.AppraisalHasAllowedWielder) {
    add("Wield requirement", s.CraftsmanName ?? "the original owner");
  }
  if (b.AppraisalHasAllowedActivator) {
    lines.push(`This item can only be activated by ${s.CraftsmanName ?? "the original owner"}.`);
  }
  if (!b.AppraisalHasAllowedWielder && !b.AppraisalHasAllowedActivator) {
    add("Created by", s.CraftsmanName);
  }
  if (Number(i.AccountRequirements) === 1) {
    lines.push("Use requires Throne of Destiny.");
  }
  if (b.AutowieldLeft) {
    lines.push("This item is tethered to the left side.");
  }
  for (const key of ["TinkerName", "ImbuerName"]) {
    add(key === "TinkerName" ? "Tinkered by" : "Imbued by", s[key]);
  }
  const imbued = ["Critical Strike", "Crippling Blow", "Armor Rending", "Slash Rending", "Pierce Rending", "Bludgeon Rending", "Acid Rending", "Cold Rending", "Electric Rending", "Fire Rending", "+1 Melee Defense", "+1 Missile Defense", "+1 Magic Defense"];
  const imbuedMask = ["ImbuedEffect", "ImbuedEffect2", "ImbuedEffect3", "ImbuedEffect4", "ImbuedEffect5"].reduce((mask, key) => mask | Number(i[key]), 0);
  add("Imbued effects", imbued.filter((_, bit) => (imbuedMask & (1 << bit)) !== 0).join(", "));
  if (imbuedMask < 0) {
    lines.push("Phantasmal");
  }
  for (const [key, label] of Object.entries({ AbsorbMagicDamage: "Magic Absorbing", CriticalMultiplier: "Crushing Blow", CriticalFrequency: "Biting Strike", IgnoreArmor: "Armor Cleaving" })) {
    if (f[key] != null) {
      lines.push(label);
    }
  }
  if (f.ResistanceModifier != null && i.ResistanceModifierType != null) {
    add("Resistance Cleaving", damageTypes.filter((_, bit) => (Number(i.ResistanceModifierType) & (1 << bit)) !== 0).join(", "));
  }
  if (Number(i.ResistMagic) >= 9999) {
    lines.push("Unenchantable");
  }
  for (const [key, label] of Object.entries({ Ivoryable: "Ivoryable", Dyable: "Dyeable" })) {
    if (b[key]) {
      lines.push(label);
    }
  }
  if (object.did.ProcSpell != null) {
    lines.push("Cast on Strike");
  }
  if (Number(i.Cleaving) > 0) {
    lines.push(`Cleave: ${number(i.Cleaving)} enemies in front arc.`);
  }
  if (i.SlayerCreatureType != null) {
    add("Slayer", name("CreatureType", i.SlayerCreatureType));
  }
  if (f.CooldownDuration != null) {
    add("Cooldown when used", `${number(f.CooldownDuration)} seconds`);
  }
  if (i.WeaponSkill != null) {
    add("Skill", name("Skill", i.WeaponSkill));
  }
  if (i.Damage != null) {
    const maximum = Number(i.Damage);
    add("Damage", f.DamageVariance == null ? number(maximum) : `${number(maximum * (1 - Number(f.DamageVariance)))} – ${number(maximum)}`);
  }
  if (i.DamageType != null) {
    add("Damage type", damageTypes.filter((_, bit) => (Number(i.DamageType) & (1 << bit)) !== 0).join(", "));
  }
  fields(i, { ElementalDamageBonus: "Elemental damage bonus", WeaponTime: "Speed", ArmorLevel: (Number(i.ValidLocations) & 0x200000) !== 0 ? "Base shield level" : "Armor level" });
  if (i.AmmoType != null) {
    add("Ammunition", ({ 1: "Arrows", 2: "Bolts", 4: "Atlatl darts" } as Record<string, string>)[String(i.AmmoType)] ?? i.AmmoType);
  }
  fields(f, { DamageMod: "Damage multiplier", MaximumVelocity: "Missile velocity" });
  for (const [key, label] of Object.entries({ WeaponOffense: "Attack bonus", WeaponDefense: "Melee defense bonus", WeaponMissileDefense: "Missile defense bonus", WeaponMagicDefense: "Magic defense bonus", ManaConversionMod: "Mana conversion bonus", ElementalDamageMod: "Elemental spell damage bonus vs. monsters" })) {
    if (f[key] != null) {
      add(label, percent(Number(f[key]) - (key === "ManaConversionMod" ? 0 : 1)));
    }
  }
  if (f.ElementalDamageMod != null) {
    add("Elemental spell damage bonus vs. players", percent((Number(f.ElementalDamageMod) - 1) * 0.5));
  }
  for (const type of ["Slash", "Pierce", "Bludgeon", "Cold", "Fire", "Acid", "Electric", "Nether"]) {
    if (f[`ArmorModVs${type}`] != null) {
      add(`Armor modifier vs. ${type.toLowerCase()}`, number(f[`ArmorModVs${type}`]));
    }
  }
  fields(i, { ItemsCapacity: "Item capacity", ContainersCapacity: "Container capacity", AppraisalPages: "Filled pages", AppraisalMaxPages: "Maximum pages" });
  if (b.Locked != null) {
    lines.push(b.Locked ? "Locked" : "Unlocked");
  }
  fields(i, { ResistLockpick: "Lockpick resistance", AppraisalLockpickSuccessPercent: "Lockpick success (%)", LockpickMod: "Lockpick skill bonus" });
  fields(i, { MinLevel: "Minimum level", MaxLevel: "Maximum level" });
  if (Number(i.UseRequiresLevel) > 0) {
    lines.push(`Use requires level ${number(i.UseRequiresLevel)}.`);
  }
  if (Number(i.UseRequiresSkill) && Number(i.UseRequiresSkillLevel)) {
    lines.push(`Use requires ${name("Skill", i.UseRequiresSkill)} of at least ${number(i.UseRequiresSkillLevel)}.`);
  }
  if (Number(i.UseRequiresSkillSpec)) {
    lines.push(`Use requires specialized ${name("Skill", i.UseRequiresSkillSpec)}.`);
  }
  if (Number(i.HeritageSpecificArmor)) {
    add("Wield requirement", name("HeritageGroup", i.HeritageSpecificArmor));
  }
  add("Destination", s.AppraisalPortalDestination);
  for (const [mask, label] of [[2, "Player killers may not use this portal."], [4, "PK Lite players may not use this portal."], [8, "Non-player killers may not use this portal."], [16, "This portal cannot be summoned."], [32, "This portal cannot be recalled to."]] as const) {
    if ((Number(i.PortalBitmask) & mask) !== 0) {
      lines.push(label);
    }
  }
  if (f.HealkitMod != null) {
    fields(i, { BoostValue: "Healing skill bonus" });
  } else if (i.BoostValue != null && i.BoosterEnum != null) {
    const boost = Number(i.BoostValue);
    lines.push(`${boost < 0 ? "Depletes" : "Restores"} ${number(Math.abs(boost))} ${(vitals[Number(i.BoosterEnum)] ?? "points").toLowerCase()}.`);
  }
  fields(f, { HealkitMod: "Restoration bonus" }, percent);
  if (Object.keys(object.spells).length === 0) {
    fields(f, { ItemEfficiency: "Mana efficiency", ManaStoneDestroyChance: "Destruction chance" }, percent);
  }
  fields(i, { ItemCurMana: Object.keys(object.spells).length === 0 ? "Stored mana" : "Current mana", ItemMaxMana: "Maximum mana", ItemManaCost: "Mana cost", ItemSpellcraft: "Spellcraft", ItemDifficulty: "Arcane Lore required", ItemSkillLevelLimit: "Activation skill required", NumKeys: "Keys" });
  if (i.AppraisalItemSkill != null) {
    add("Activation skill", name("Skill", i.AppraisalItemSkill));
  }
  if (Number(i.ItemAllegianceRankLimit) > 0) {
    add("Activation allegiance rank", number(i.ItemAllegianceRankLimit));
  }
  if (Number(i.HeritageGroup)) {
    add("Activation heritage", name("HeritageGroup", i.HeritageGroup));
  }
  for (const [key, levelKey, labels] of [
    ["ItemAttributeLimit", "ItemAttributeLevelLimit", attributes],
    ["ItemAttribute2ndLimit", "ItemAttribute2ndLevelLimit", vitals],
  ] as const) {
    if (i[key] != null && Number(i[levelKey]) > 0) {
      add("Activation requirement", `${labels[Number(i[key])] ?? "Unknown"}: ${number(i[levelKey])}`);
    }
  }
  if (f.ManaRate != null && Number(f.ManaRate) !== 0) {
    add("Mana cost", `1 point per ${Math.round(Math.abs(1 / Number(f.ManaRate)))} seconds`);
  }
  if (b.UnlimitedUse) {
    add("Uses remaining", "Unlimited");
  } else if (i.Structure != null) {
    add("Uses remaining", number(i.Structure));
  }
  for (const suffix of ["", "2", "3", "4"]) {
    const requirement = Number(i[`WieldRequirements${suffix}`]);
    const skill = i[`WieldSkillType${suffix}`];
    const difficulty = i[`WieldDifficulty${suffix}`];
    if (!requirement || difficulty == null) {
      continue;
    }
    let label: string;
    switch (requirement) {
      case 1:
      case 2:
        label = `${requirement === 2 ? "Base " : ""}${name("Skill", skill)}`;
        break;
      case 3:
      case 4:
        label = `${requirement === 4 ? "Base " : ""}${attributes[Number(skill)] ?? "Attribute"}`;
        break;
      case 5:
      case 6:
        label = `${requirement === 6 ? "Base " : ""}${vitals[Number(skill)] ?? "Vital"}`;
        break;
      case 7:
        label = "Level";
        break;
      case 8:
        add("Wield requirement", `${Number(difficulty) === 3 ? "specialized" : "trained"} ${name("Skill", skill)}`);
        continue;
      case 9:
      case 10:
        label = ({ 287: "Standing with the Celestial Hand", 288: "Standing with the Eldrytch Web", 289: "Standing with the Radiant Blood" } as Record<string, string>)[String(skill)] ?? "unknown quality";
        break;
      case 12:
        add("Wield requirement", name("HeritageGroup", difficulty));
        continue;
      case 11:
        add("Wield requirement", name("CreatureType", difficulty));
        continue;
      default:
        continue;
    }
    add("Wield requirement", `${label} ${number(difficulty)}`);
  }
  if (i.EquipmentSetId != null) {
    add("Set", name("EquipmentSet", i.EquipmentSetId));
  }
  fields(i, { DamageRating: "Damage rating", DamageResistRating: "Damage resistance rating", CritRating: "Critical rating", CritDamageRating: "Critical damage rating", CritResistRating: "Critical resistance rating", CritDamageResistRating: "Critical damage resistance rating", HealingBoostRating: "Healing boost rating", Vitality: "Vitality", RareId: "Rare", ItemMaxLevel: "Maximum item level" });
  fields(i, { Overpower: "Overpower %", OverpowerResist: "Overpower reduction %", PKDamageRating: "PK damage rating", PKDamageResistRating: "PK damage resistance rating", NetherResistRating: "Nether resistance rating", LifeResistRating: "Life resistance rating" });
  const baseXp = BigInt(object.int64.ItemBaseXp ?? 0);
  const totalXp = BigInt(object.int64.ItemTotalXp ?? 0);
  const xpStyle = Number(i.ItemXpStyle);
  const maxLevel = Number(i.ItemMaxLevel);
  if (baseXp > 0n && maxLevel > 0 && xpStyle >= 1 && xpStyle <= 3) {
    // ExperienceSystem supports fixed, doubling and linearly increasing costs.
    let level = 0;
    let threshold = 0n;
    let cost = baseXp;
    while (level < maxLevel && totalXp >= threshold + cost) {
      threshold += cost;
      level++;
      cost = xpStyle === 2 ? cost * 2n : xpStyle === 3 ? cost + baseXp : baseXp;
    }
    add("Item level", `${level} / ${maxLevel}`);
    add("Item XP", `${totalXp.toLocaleString("en-US")} / ${(level === maxLevel ? threshold : threshold + cost).toLocaleString("en-US")}`);
  }
  if (Number(i.CloakWeaveProc) === 2) {
    lines.push("This cloak has a chance to reduce an incoming attack by 200 damage.");
  }
  if (b.RareUsesTimer) {
    lines.push("Using this rare item prevents use of another timed rare for 3 minutes.");
  }
  if (Number(i.Attuned) === 1 || Number(i.Attuned) === 2) {
    lines.push("Attuned");
  }
  const bonded = ({ "-2": "Destroyed on Death", "-1": "Dropped on Death", "1": "Bonded" } as Record<string, string>)[String(i.Bonded)];
  if (bonded) {
    lines.push(bonded);
  }
  if (b.Retained) {
    lines.push("Retained");
  }
  const spellIds = Object.keys(object.spells);
  if (spellIds.length > 0) {
    lines.push("", "Spells:", ...spellIds.map((id) => spells[id]?.[0] ?? `Spell ${id}`));
  }
  if (object.did.Spell != null) {
    const spell = spells[String(object.did.Spell)];
    lines.push("", spell?.[0] ?? `Spell ${object.did.Spell}`);
    if (spell?.[1]) {
      lines.push(spell[1]);
    }
  }
  for (const description of [s.LongDesc ?? s.ShortDesc, s.Use]) {
    if (description) {
      lines.push("", String(description));
    }
  }
  return lines.join("\n").trim();
}
