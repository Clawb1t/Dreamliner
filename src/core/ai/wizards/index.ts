/**
 * Autopilot setup wizards, one file per plugin, each covering every setting that plugin has.
 * Adding Autopilot to a new dashboard page is one new file here plus an entry below.
 */
import type { AiWizardDefinition } from "../wizardKit.js";
import { activityRewardsWizard } from "./activityRewards.js";
import { appealsWizard } from "./appeals.js";
import { autodeleteWizard } from "./autodelete.js";
import { automodWizard } from "./automod.js";
import { autoreactionsWizard } from "./autoreactions.js";
import { autorepliesWizard } from "./autoreplies.js";
import { autoroleWizard } from "./autorole.js";
import { autothreadsWizard } from "./autothreads.js";
import { boosterRolesWizard } from "./boosterRoles.js";
import { companionWizard } from "./companion.js";
import { countersWizard } from "./counters.js";
import { countingWizard } from "./counting.js";
import { giveawaysWizard } from "./giveaways.js";
import { imagesWizard } from "./images.js";
import { inviteTrackerWizard } from "./inviteTracker.js";
import { memberIdentityWizard } from "./memberIdentity.js";
import { passportWizard } from "./passport.js";
import { persistWizard } from "./persist.js";
import { rolePanelsWizard } from "./rolePanels.js";
import { roleRulesWizard } from "./roleRules.js";
import { slowmodeWizard } from "./slowmode.js";
import { starboardWizard } from "./starboard.js";
import { suggestionsWizard } from "./suggestions.js";
import { tagsWizard } from "./tags.js";
import { teamControlWizard } from "./teamControl.js";
import { ticketsWizard } from "./tickets.js";
import { welcomeWizard } from "./welcome.js";

export const WIZARDS: Record<string, AiWizardDefinition> = {
  activity_rewards_setup: activityRewardsWizard,
  appeals_setup: appealsWizard,
  autodelete_setup: autodeleteWizard,
  automod_setup: automodWizard,
  autoreactions_setup: autoreactionsWizard,
  autoreplies_setup: autorepliesWizard,
  autorole_setup: autoroleWizard,
  autothreads_setup: autothreadsWizard,
  booster_roles_setup: boosterRolesWizard,
  companion_hub_setup: companionWizard,
  counters_setup: countersWizard,
  counting_setup: countingWizard,
  giveaways_setup: giveawaysWizard,
  images_setup: imagesWizard,
  invite_tracker_setup: inviteTrackerWizard,
  member_identity_setup: memberIdentityWizard,
  passport_setup: passportWizard,
  persist_setup: persistWizard,
  role_panel_setup: rolePanelsWizard,
  role_rules_setup: roleRulesWizard,
  slowmode_setup: slowmodeWizard,
  starboard_setup: starboardWizard,
  suggestions_setup: suggestionsWizard,
  tags_setup: tagsWizard,
  team_control_setup: teamControlWizard,
  tickets_setup: ticketsWizard,
  welcome_setup: welcomeWizard,
};
