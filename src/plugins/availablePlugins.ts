import type { DreamlinerPlugin } from "../core/types.js";
import { configPlugin } from "../plugins/config/index.js";
import { utilityPlugin } from "../plugins/utility/index.js";
import { infractionPlugin } from "../plugins/infraction/index.js";
import { autorolePlugin } from "../plugins/autorole/index.js";
import { starboardPlugin } from "../plugins/starboard/index.js";
import { logsPlugin } from "../plugins/logs/index.js";
import { automodPlugin } from "../plugins/automod/index.js";
import { censorPlugin } from "../plugins/censor/index.js";
import { adminPlugin } from "../plugins/admin/index.js";
import { persistPlugin } from "../plugins/persist/index.js";
import { slowmodePlugin } from "../plugins/slowmode/index.js";
import { nameHistoryPlugin } from "../plugins/name_history/index.js";
import { usernameSaverPlugin } from "../plugins/username_saver/index.js";
import { locateUserPlugin } from "../plugins/locate_user/index.js";
import { statsPlugin } from "../plugins/stats/index.js";
import { customEventsPlugin } from "../plugins/custom_events/index.js";
import { commandAliasesPlugin } from "../plugins/command_aliases/index.js";
import { rolesPlugin } from "../plugins/roles/index.js";
import { reactionRolesPlugin } from "../plugins/reaction_roles/index.js";
import { roleButtonsPlugin } from "../plugins/role_buttons/index.js";
import { selfGrantableRolesPlugin } from "../plugins/self_grantable_roles/index.js";
import { pingableRolesPlugin } from "../plugins/pingable_roles/index.js";
import { roleManagerPlugin } from "../plugins/role_manager/index.js";
import { welcomeMessagePlugin } from "../plugins/welcome_message/index.js";
import { tagsPlugin } from "../plugins/tags/index.js";
import { postPlugin } from "../plugins/post/index.js";
import { autodeletePlugin } from "../plugins/autodelete/index.js";
import { autoreactionsPlugin } from "../plugins/autoreactions/index.js";
import { remindersPlugin } from "../plugins/reminders/index.js";
import { countersPlugin } from "../plugins/counters/index.js";
import { companionChannelsPlugin } from "../plugins/companion_channels/index.js";

export const availablePlugins: DreamlinerPlugin[] = [
  configPlugin,
  utilityPlugin,
  infractionPlugin,
  autorolePlugin,
  starboardPlugin,
  logsPlugin,
  automodPlugin,
  censorPlugin,
  adminPlugin,
  persistPlugin,
  slowmodePlugin,
  nameHistoryPlugin,
  usernameSaverPlugin,
  locateUserPlugin,
  statsPlugin,
  customEventsPlugin,
  commandAliasesPlugin,
  rolesPlugin,
  reactionRolesPlugin,
  roleButtonsPlugin,
  selfGrantableRolesPlugin,
  pingableRolesPlugin,
  roleManagerPlugin,
  welcomeMessagePlugin,
  tagsPlugin,
  postPlugin,
  autodeletePlugin,
  autoreactionsPlugin,
  remindersPlugin,
  countersPlugin,
  companionChannelsPlugin,
];

export function getAllSlashCommands() {
  return availablePlugins.flatMap((p) => p.slashCommands);
}
