# Funnel-outage recovery — a fix is not done when the bug is fixed

**Applies to any blocker on `/register`, `/claim` or `/suggest-event`.**

## The rule

When you close a funnel-blocking defect, the ticket is **not done** until the
blocked cohort has been enumerated and a decision recorded — contact them, or
explicitly decide not to. Write the decision on the ticket either way.

This is a checklist item on the fix, deliberately, not a follow-up ticket. A
separate ticket is one nobody files.

## Why this exists

We are good at fixing these fast and had **no mechanism at all** for the people
who hit one.

OPE-150 (Turnstile widget never rendered, 2026-07-08) was filed within hours and
fixed the next evening. A real prospect — a commercial exhibitor on the revenue
path — emailed `support@` _during_ the outage saying she could not complete the
security check. The bug was fixed 3.5 hours after she wrote. **51 days later she
still had no account**, and had emailed twice more about vendoring at a fair that
has since happened.

Nobody did anything wrong at the ticket level. The gap is that _"the bug is
fixed"_ and _"the people it hurt are whole again"_ were treated as the same
event. They are not.

Three funnel outages (OPE-150, OPE-173, OPE-361) produced zero recovery passes
between them.

## Why the cohort is invisible without help

A registration-blocking bug's victims are, by construction, exactly the people
with **no `users` row**. You cannot find them by querying the thing they failed
to create. The only possible traces are:

1. **Inbound email** — only the small fraction who bother to write.
2. **Funnel telemetry** — which for the OPE-150 window does not exist. Every
   `register_view` / `register_submitted` series in `analytics_events` begins
   **2026-08-16**, five weeks after that outage.

So for OPE-150 and OPE-173 the cohort is **not reconstructable at any price**.
That is not a gap to close retroactively; it is a fact to record.

## The step

1. **Enumerate.**
   `GET /api/admin/registration-attempts?since=<ISO>&until=<ISO>` (admin only).
   Returns attempts in the window whose email still has **no** `users` row and
   that nobody has closed out.
2. **Read the coverage note on the response.** An empty result before the
   OPE-634 deploy means _nothing was recorded_, **not** _nobody was blocked_.
   Say which on the ticket.
3. **Decide, and write it down.** Contacting them, or deciding not to, are both
   acceptable. Silence is not.
4. **Close them out** by setting `recovered_at` / `recovery_note` on the rows,
   so the queue can actually be emptied. A queue that cannot reach zero gets
   ignored.

## ⚠️ Sending is gated

Contacting a cohort of people who failed to sign up weeks or months ago is
customer-facing outbound. It needs John's issue-level approval every time, per
OPE-6. The enumeration is built; **it is not wired to any sender**, and it
should not be.

Note also that there is no clean transport for this today — see OPE-595
(`send_vendor_email` needs a recipient override) and OPE-642 (whether approved
drafts send at all).
