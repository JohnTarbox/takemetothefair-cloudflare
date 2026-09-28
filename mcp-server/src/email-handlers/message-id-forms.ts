/**
 * Moved out of email-handler.ts (OPE-1214) so the thread-reply-ack guard can
 * look a reply's parent up in the send ledger without importing the whole
 * inbound pipeline. email-handler.ts re-exports it under the same name.
 *
 * The referenced Message-IDs spelled as STORED, for an `IN (…)` lookup.
 *
 * `inbound_emails.message_id` and `email_send_ledger.provider_message_id` keep
 * the header's own case and angle brackets (`<DM3PPF334…>`), and D1's `IN`
 * compares case-sensitively. `parseMessageIdList` lower-cases and strips the
 * brackets — right for the resolver's comparison, wrong as a query key: a
 * lookup built from it matched only ids that were already lower-case and
 * bracketless, so the cross-sender header tier was silently dead. Both
 * bracketed and bare forms are queried, case preserved.
 *
 * Capped at MAX_REFERENCED_IDS (×2 forms, under D1's 100 bound parameters):
 * the In-Reply-To id plus the NEWEST References, which is where the parent is.
 */
const MAX_REFERENCED_IDS = 40;
export function storedMessageIdForms(
  inReplyTo: string | null | undefined,
  references: string | null | undefined
): string[] {
  const grab = (h: string | null | undefined) =>
    (h ?? "").match(/<[^<>\s]+>/g) ?? (h ?? "").split(/\s+/).filter(Boolean);
  const irt = grab(inReplyTo);
  const refs = grab(references);
  const ids = [...new Set([...irt.slice(0, 1), ...refs.reverse()])].slice(0, MAX_REFERENCED_IDS);
  return [
    ...new Set(
      ids.flatMap((raw) => {
        const bare = raw.replace(/^</, "").replace(/>$/, "");
        return bare ? [`<${bare}>`, bare] : [];
      })
    ),
  ];
}
