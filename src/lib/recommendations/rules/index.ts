/**
 * Rule registry. Add new rules here; the engine picks them up automatically on
 * the next scan. Per the plan file, additional rules ship in PR 3.
 */

import type { RuleDefinition } from "../engine";
import { vendorsNoDescriptionRule } from "./vendors-no-description";

export const ALL_RULES: RuleDefinition[] = [vendorsNoDescriptionRule];
