/**
 * Server-side registry of Autopilot's conversational setup wizards. Each wizard lives in its own
 * file under ./wizards/ (built from the shared pieces in ./wizardKit.ts) and covers every setting
 * its plugin has; this module is the stable entry point the bridge and Switch import from.
 */
import type { AiWizardDefinition } from "./wizardKit.js";
import { WIZARDS } from "./wizards/index.js";

export {
  ANSWER_KINDS,
  type AiWizardContext,
  type AiWizardDefinition,
  type AiWizardEmoji,
  type AiWizardEntity,
  type AiWizardTurn,
  type AnswerKind,
} from "./wizardKit.js";

/** Every Autopilot setup wizard, by id (the id the website's AiWizardModal passes). */
export const AI_WIZARDS: Record<string, AiWizardDefinition> = WIZARDS;

export function isKnownAiWizard(wizard: string): wizard is keyof typeof AI_WIZARDS {
  return Object.prototype.hasOwnProperty.call(AI_WIZARDS, wizard);
}
