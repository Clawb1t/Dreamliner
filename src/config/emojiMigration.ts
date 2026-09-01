/** Old Dreamliner default emoji markup → current defaults. */
export const LEGACY_EMOJI_REPLACEMENTS: Record<string, string> = {
  "<:checked:1524379445379465276>": "<:icons_Correct:1544417199798886530>",
  "<:redcheck:1524379423757959208>": "<:icons_Wrong:1544417460638457937>",
  "<:greycheck:1524379394372669553>": "<:icons_generalinfo:1544417795335389254>",
  "<:lowwarning:1524379341000151170>": "<:icons_exclamation:1544417272376852490>",
  "<:unchecked:1524379366996312104>": "<:icons_disable:1544417870652379277>",
  // 2025 emoji-pack switch: the old "blurplecheck/redcheck/greycheck/warning" default set and the
  // "dl_*" logging-category set were replaced by the new "icons_*" application emoji pack. Mapped
  // here (not just in the schema defaults) so guilds that saved the old defaults as an explicit
  // override — or copied one into another config key — still pick up the new look automatically.
  "<:blurplecheck:1533947878668763278>": "<:icons_Correct:1544417199798886530>",
  "<:redcheck:1533947951481749504>": "<:icons_Wrong:1544417460638457937>",
  "<:greycheck:1533948078615298148>": "<:icons_generalinfo:1544417795335389254>",
  "<:warning:1533948583995244734>": "<:icons_exclamation:1544417272376852490>",
  "<:dl_action:1540811113711665203>": "<:icons_slashcmd:1544417581765501059>",
  "<:dl_create:1540811386790346793>": "<:icons_plus:1544417389872156732>",
  "<:dl_delete:1540811399993757816>": "<:icons_trash:1544418246705418332>",
  "<:dl_edit:1540811455249645668>": "<:icons_edit:1544417261115281441>",
  "<:dl_emoji:1540811163284144169>": "<:icons_createemoji:1544417838511423538>",
  "<:dl_join:1540811526447824976>": "<:icons_djoin:1544417221902864524>",
  "<:dl_leave:1540811513802133554>": "<:icons_dleave:1544417225430274058>",
  "<:dl_voice:1540811146380972144>": "<:icons_voice:1544418279760601158>",
  "<:dl_unban:1540811470391214111>": "<:icons_unbanmember:1544417814549495899>",
  "<:dl_serverupdate:1540811181290160328>": "<:icons_updateserver:1544417824074768584>",
  "<:dl_moderation_default:1540811132242239651>": "<:icons_moderationlow:1544418102001799328>",
  "<:dl_moderation_moderate:1540811497184297040>": "<:icons_moderationmedium:1544418103494971402>",
  "<:dl_moderation_severe:1540811485079671046>": "<:icons_moderationhighest:1544418100663812167>",
  "<:dl_remove:1541487407939981352>": "<:icons_delete:1544417209458102292>",
  "<:dotblurple:1542696072843886644>": "<:icons_square:1544418208549970101>",
  "<:coin:1543696697685844048>": "<:icons_coin:1544417186951598130>",
};

/**
 * Remap legacy emoji strings anywhere in a guild's fully-merged config — not just the top-level
 * `emojis` block. `configYaml` is a full merged snapshot (defaults baked in at save time), so
 * every guild that has ever saved a config has old emoji IDs stored as literal values throughout
 * (`emojis.*`, `logging.emojis.*`, any plugin's own emoji field) — a change to the schema
 * defaults alone only reaches guilds with no stored config at all. This walks the whole tree so
 * every stored old ID gets replaced, not just the 5 keys under `emojis`.
 */
export function migrateLegacyEmojisInGuildConfig<T>(data: T): { data: T; changed: boolean } {
  const migrated = migrateLegacyEmojisInObject(data);
  return { data: migrated.value as T, changed: migrated.changed };
}

/** Remap legacy emoji strings anywhere in a parsed user-overrides object. */
export function migrateLegacyEmojisInObject(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const replacement = LEGACY_EMOJI_REPLACEMENTS[value];
    return replacement ? { value: replacement, changed: true } : { value, changed: false };
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const migrated = migrateLegacyEmojisInObject(item);
      if (migrated.changed) changed = true;
      return migrated.value;
    });
    return { value: next, changed };
  }

  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const migrated = migrateLegacyEmojisInObject(child);
      if (migrated.changed) changed = true;
      next[key] = migrated.value;
    }
    return { value: next, changed };
  }

  return { value, changed: false };
}
