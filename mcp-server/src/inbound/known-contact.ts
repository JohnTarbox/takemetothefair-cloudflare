/**
 * OPE-1510 — is this sender someone we already have a relationship with?
 *
 * John's ruling: a known contact is a `promoter_contacts` row that is not
 * `rejected`, a claimed vendor or performer account email, or a stored contact
 * email on a promoter, venue, vendor or performer.
 *
 * Unlike `resolveSenderIdentity` (report-only, and deliberately loose: domains
 * and brand names), the contact lane BRANCHES on this answer, so every basis is
 * the exact address. A shared domain must never cost someone their ack.
 *
 * A rejected promoter contact is an unknown sender. That outranks a stored
 * email, because a rejection is a person's decision about this address and a
 * stored email is only a column someone once filled in.
 */
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { isSystemSender } from "@takemetothefair/utils";
import { normalizeEmailAddress } from "@takemetothefair/db-schema";
import { performers, promoterContacts, promoters, users, vendors, venues } from "../schema.js";
import type { Db } from "../db.js";
import { isOperatorAddress } from "../test-addresses.js";

export type KnownContactBasis =
  | "promoter-contact"
  | "claimed-vendor-account"
  | "claimed-performer-account"
  | "promoter-contact-email"
  | "venue-contact-email"
  | "vendor-contact-email"
  | "performer-contact-email";

export interface KnownContact {
  basis: KnownContactBasis;
  entityType: "promoter" | "venue" | "vendor" | "performer";
  entityId: string;
  /** The person's name, when the record holds one. */
  personName: string | null;
}

export async function resolveKnownContact(
  db: Db,
  fromAddress: string | null | undefined
): Promise<KnownContact | null> {
  const from = normalizeEmailAddress(fromAddress ?? "");
  if (!from || isSystemSender(from) || isOperatorAddress(from)) return null;

  const contacts = await db
    .select({
      promoterId: promoterContacts.promoterId,
      status: promoterContacts.status,
      name: promoterContacts.name,
    })
    .from(promoterContacts)
    .where(sql`lower(${promoterContacts.email}) = ${from}`);
  const live = contacts.find((c) => c.status !== "rejected");
  if (live) {
    return {
      basis: "promoter-contact",
      entityType: "promoter",
      entityId: live.promoterId,
      personName: live.name ?? null,
    };
  }
  if (contacts.length > 0) return null;

  const accounts = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(sql`lower(${users.email}) = ${from}`)
    .limit(5);
  if (accounts.length > 0) {
    const ids = accounts.map((a) => a.id);
    const [vendor] = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          eq(vendors.claimed, true),
          isNull(vendors.deletedAt),
          or(inArray(vendors.userId, ids), inArray(vendors.claimedBy, ids))
        )
      )
      .limit(1);
    if (vendor) {
      return {
        basis: "claimed-vendor-account",
        entityType: "vendor",
        entityId: vendor.id,
        personName: accounts[0].name ?? null,
      };
    }
    const [performer] = await db
      .select({ id: performers.id })
      .from(performers)
      .where(
        and(
          eq(performers.claimed, true),
          isNull(performers.deletedAt),
          or(inArray(performers.userId, ids), inArray(performers.claimedBy, ids))
        )
      )
      .limit(1);
    if (performer) {
      return {
        basis: "claimed-performer-account",
        entityType: "performer",
        entityId: performer.id,
        personName: accounts[0].name ?? null,
      };
    }
  }

  const [promoter, venue, vendor, performer] = await Promise.all([
    db
      .select({ id: promoters.id })
      .from(promoters)
      .where(sql`lower(${promoters.contactEmail}) = ${from}`)
      .limit(1),
    db
      .select({ id: venues.id })
      .from(venues)
      .where(sql`lower(${venues.contactEmail}) = ${from}`)
      .limit(1),
    db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(isNull(vendors.deletedAt), sql`lower(${vendors.contactEmail}) = ${from}`))
      .limit(1),
    db
      .select({ id: performers.id })
      .from(performers)
      .where(and(isNull(performers.deletedAt), sql`lower(${performers.contactEmail}) = ${from}`))
      .limit(1),
  ]);
  const stored = (
    basis: KnownContactBasis,
    entityType: KnownContact["entityType"],
    entityId: string
  ): KnownContact => ({ basis, entityType, entityId, personName: null });
  if (promoter[0]) return stored("promoter-contact-email", "promoter", promoter[0].id);
  if (venue[0]) return stored("venue-contact-email", "venue", venue[0].id);
  if (vendor[0]) return stored("vendor-contact-email", "vendor", vendor[0].id);
  if (performer[0]) return stored("performer-contact-email", "performer", performer[0].id);
  return null;
}
