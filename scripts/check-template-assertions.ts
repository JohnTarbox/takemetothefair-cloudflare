/**
 * OPE-771 — CI guard: every ReplyKind is present in the template-assertion
 * registry, and every registered assertion has a predicate.
 *
 * This is the durable half of the ticket. The registry itself catches a false
 * claim at send time; THIS catches the registry going quietly out of date,
 * which is how a guard ends up covering less every month while still passing.
 *
 * Two failure modes, both of which look like success without this check:
 *
 *  1. A new reply kind is added to the `ReplyKind` union and nobody remembers
 *     `template-assertions.ts`. The send-time check returns "no violations" for
 *     an unregistered kind — correct behaviour (suppressing mail on a registry
 *     slip is worse than a clumsy ack, per the OPE-706 ruling) but only safe
 *     BECAUSE this check exists.
 *  2. An assertion is added with a claim and no predicate, which reads as
 *     covered and tests nothing.
 *
 * Run by `npm run lint`, alongside the other check-*.ts guards.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const TYPES = join(ROOT, "mcp-server", "src", "email-handlers", "types.ts");
const REGISTRY = join(ROOT, "mcp-server", "src", "email-handlers", "template-assertions.ts");

/** Pull the ReplyKind union members out of the type declaration. */
function replyKinds(): string[] {
  const src = readFileSync(TYPES, "utf8");
  const start = src.indexOf("export type ReplyKind");
  if (start === -1) throw new Error("ReplyKind union not found in types.ts");
  // The union ends at the first line that is a bare `;` terminator.
  const end = src.indexOf("\n\n", start);
  const block = src.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/^\s*\|\s*"([^"]+)"/gm)].map((m) => m[1]);
}

/** Registry keys, read from the source so this needs no runtime import. */
function registeredKinds(): string[] {
  const src = readFileSync(REGISTRY, "utf8");
  const start = src.indexOf("export const TEMPLATE_ASSERTIONS");
  if (start === -1) throw new Error("TEMPLATE_ASSERTIONS not found");
  const end = src.indexOf("\n};", start);
  const block = src.slice(start, end);
  return [...block.matchAll(/^\s{2}(?:"([a-z0-9-]+)"|([a-z][a-zA-Z0-9]*)):\s*\[/gm)].map(
    (m) => m[1] ?? m[2]
  );
}

function main() {
  const kinds = replyKinds();
  const registered = new Set(registeredKinds());

  // Positive landmark FIRST. If either parser stops matching, every assertion
  // below passes over an empty list and this guard reports a clean bill of
  // health for files it never understood.
  if (kinds.length < 15) {
    console.error(
      `Template-assertion guard FAILED (OPE-771):\n\n  Parsed only ${kinds.length} ReplyKind members from types.ts.\n  The union has ~23. The parser has stopped matching — fix it rather than\n  trusting the result below.\n`
    );
    process.exit(1);
  }
  if (registered.size < 15) {
    console.error(
      `Template-assertion guard FAILED (OPE-771):\n\n  Parsed only ${registered.size} registry keys from template-assertions.ts.\n  The parser has stopped matching.\n`
    );
    process.exit(1);
  }

  const missing = kinds.filter((k) => !registered.has(k));
  if (missing.length > 0) {
    console.error(
      `Template-assertion guard FAILED (OPE-771):\n\n` +
        `  These ReplyKinds are not in TEMPLATE_ASSERTIONS:\n` +
        missing.map((m) => `      ${m}`).join("\n") +
        `\n\n  Add each one. If a template makes no factual claim about the inbound,\n` +
        `  map it to [] — that is a reviewed answer and says somebody looked.\n` +
        `  An ABSENT key is not the same thing, and is what this check exists to\n` +
        `  catch: OPE-453, OPE-706 and OPE-460 were three shipped templates that\n` +
        `  asserted something a column on the same row contradicted.\n`
    );
    process.exit(1);
  }

  // An assertion with a claim and no predicate reads as covered and tests
  // nothing — the inert-control shape, in a guard.
  //
  // Counted from the IMPLEMENTATIONS only. The `TemplateAssertion` interface
  // above them also declares `falsifiedBy: (facts: …)`, and counting it made
  // this check report 10 claims against 11 predicates on its very first run —
  // a guard failing on its own parser rather than on the thing it guards.
  const full = readFileSync(REGISTRY, "utf8");
  const implStart = full.indexOf("const OWN_DOMAIN");
  if (implStart === -1) throw new Error("could not find the start of the implementations");
  const src = full.slice(implStart);
  const claims = (src.match(/claim:\s*"/g) ?? []).length;
  const predicates = (src.match(/falsifiedBy:\s*\(/g) ?? []).length;
  if (claims !== predicates) {
    console.error(
      `Template-assertion guard FAILED (OPE-771):\n\n` +
        `  ${claims} claim(s) but ${predicates} predicate(s) in template-assertions.ts.\n` +
        `  Every claim needs the predicate that would falsify it — a claim without\n` +
        `  one is exactly the defect this registry exists to prevent.\n`
    );
    process.exit(1);
  }

  const withPredicates = kinds.filter((k) => registered.has(k)).length;
  console.log(
    `Template-assertion guard passed — ${kinds.length} reply kinds, ${withPredicates} registered, ` +
      `${claims} claims each with a predicate.`
  );
}

main();
