import type { ComponentType } from "react";
import { InventoryCalculator } from "./InventoryCalculator";
import { Callout } from "./Callout";

/**
 * Whitelisted components that may be embedded in blog post bodies via
 * `remark-directive` syntax.
 *
 * Directive syntax (kebab-case):
 *   ::inventory-calculator
 *   :::callout{type="warning"} ...body... :::
 *
 * Keys are the directive names. Values are React components. Unknown directive
 * names fall through to react-markdown's default handling (rendered as an inert
 * unknown tag) — explicitly whitelisted here to keep post bodies safe.
 *
 * MDX-migration note: if this site later adopts MDX, each entry here maps 1:1
 * to an MDX `components` prop entry — the kebab directive name becomes a
 * PascalCase JSX tag, and the component import stays identical.
 */
export const BLOG_EMBEDS: Record<string, ComponentType<Record<string, unknown>>> = {
  "inventory-calculator": InventoryCalculator as ComponentType<Record<string, unknown>>,
  callout: Callout as ComponentType<Record<string, unknown>>,
};

export const BLOG_EMBED_NAMES = Object.keys(BLOG_EMBEDS);
