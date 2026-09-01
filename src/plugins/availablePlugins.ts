import type { DreamlinerPlugin } from "../core/types.js";
import { configPlugin } from "../plugins/config/index.js";
import { utilityPlugin } from "../plugins/utility/index.js";
import { infractionPlugin } from "../plugins/infraction/index.js";
import { autorolePlugin } from "../plugins/autorole/index.js";
import { memberIdentityPlugin } from "../plugins/member_identity/index.js";
import { translationPlugin } from "../plugins/translation/index.js";
import { starboardPlugin } from "../plugins/starboard/index.js";
import { logsPlugin } from "../plugins/logs/index.js";
import { automodPlugin } from "../plugins/automod/index.js";
import { persistPlugin } from "../plugins/persist/index.js";
import { slowmodePlugin } from "../plugins/slowmode/index.js";
import { nameHistoryPlugin } from "../plugins/name_history/index.js";
import { usernameSaverPlugin } from "../plugins/username_saver/index.js";
import { locateUserPlugin } from "../plugins/locate_user/index.js";
import { statsPlugin } from "../plugins/stats/index.js";
import { rolesPlugin } from "../plugins/roles/index.js";
import { reactionRolesPlugin } from "../plugins/reaction_roles/index.js";
import { rolePanelsPlugin } from "../plugins/role_panels/index.js";
import { roleButtonsPlugin } from "../plugins/role_buttons/index.js";
import { selfGrantableRolesPlugin } from "../plugins/self_grantable_roles/index.js";
import { welcomeMessagePlugin } from "../plugins/welcome_message/index.js";
import { tagsPlugin } from "../plugins/tags/index.js";
import { autodeletePlugin } from "../plugins/autodelete/index.js";
import { autoreactionsPlugin } from "../plugins/autoreactions/index.js";
import { autorepliesPlugin } from "../plugins/autoreplies/index.js";
import { autothreadsPlugin } from "../plugins/autothreads/index.js";
import { remindersPlugin } from "../plugins/reminders/index.js";
import { countersPlugin } from "../plugins/counters/index.js";
import { companionChannelsPlugin } from "../plugins/companion_channels/index.js";
import { dreamCommandsPlugin } from "../plugins/dream_commands/index.js";
import { botCustomisationPlugin } from "../plugins/bot_customisation/index.js";
import { reviewsPlugin } from "../plugins/reviews/index.js";
import { suggestionsPlugin } from "../plugins/suggestions/index.js";
import { scamProtectPlugin } from "../plugins/scam_protect/index.js";
import { passportPlugin } from "../plugins/passport/index.js";
import { economyPlugin } from "../plugins/economy/index.js";
import { animePlugin } from "../plugins/anime/index.js";
import { ticketsPlugin } from "../plugins/tickets/index.js";
import { socialPlugin } from "../plugins/social/index.js";
import { ttsPlugin } from "../plugins/tts/index.js";
import { debugPlugin } from "../plugins/debug/index.js";

export const availablePlugins: DreamlinerPlugin[] = [
  configPlugin,
  utilityPlugin,
  infractionPlugin,
  autorolePlugin,
  memberIdentityPlugin,
  translationPlugin,
  starboardPlugin,
  logsPlugin,
  automodPlugin,
  scamProtectPlugin,
  passportPlugin,
  economyPlugin,
  animePlugin,
  persistPlugin,
  slowmodePlugin,
  nameHistoryPlugin,
  usernameSaverPlugin,
  locateUserPlugin,
  statsPlugin,
  rolesPlugin,
  reactionRolesPlugin,
  rolePanelsPlugin,
  roleButtonsPlugin,
  selfGrantableRolesPlugin,
  welcomeMessagePlugin,
  tagsPlugin,
  autodeletePlugin,
  autoreactionsPlugin,
  autorepliesPlugin,
  autothreadsPlugin,
  remindersPlugin,
  countersPlugin,
  companionChannelsPlugin,
  dreamCommandsPlugin,
  botCustomisationPlugin,
  reviewsPlugin,
  suggestionsPlugin,
  ticketsPlugin,
  socialPlugin,
  ttsPlugin,
  debugPlugin,
];

export function getAllSlashCommands() {
  return availablePlugins.flatMap((p) => p.slashCommands);
}
