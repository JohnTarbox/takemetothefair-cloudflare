# Unsubscribe secret — introduce, retire, rotate (OPE-1346)

One-click unsubscribe links in outbound footers are signed with a secret and
verified by the main app. **CAN-SPAM requires a delivered link to keep working
for 30 days after the send**, so a key may only stop being _accepted_ once
every link signed with it is older than that.

Signing and verifying are separate rules (`packages/utils/src/email-unsubscribe.ts`):

|                                         | secrets, in order                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| **sign** (MCP Worker, footers)          | `UNSUBSCRIBE_SECRET`, else `INTERNAL_API_KEY`. Never `UNSUBSCRIBE_SECRET_PREVIOUS`.      |
| **verify** (main app, `/unsubscribe/*`) | `UNSUBSCRIBE_SECRET`, `INTERNAL_API_KEY` (unless retired), `UNSUBSCRIBE_SECRET_PREVIOUS` |

The two Workers must hold the **same** `UNSUBSCRIBE_SECRET`: the MCP Worker signs,
the main app verifies.

Before any step: run from the repo root with the project's `.env` sourced, and
confirm `npx wrangler whoami` shows **John Tarbox - Account `e6011e48…`**.

## (a) Introduce a dedicated `UNSUBSCRIBE_SECRET`

One value is generated and piped into both Workers. It is never printed.

```bash
set -a; . ./.env; set +a; npx wrangler whoami
openssl rand -hex 32 \
  | tee >(npx wrangler secret put UNSUBSCRIBE_SECRET --name meetmeatthefair-app >&2) \
  | (cd mcp-server && npx wrangler secret put UNSUBSCRIBE_SECRET --name meetmeatthefair-mcp)
```

Effect: new mail is signed with it. Every link already delivered still verifies
through `INTERNAL_API_KEY`. Nothing breaks.

Check: names only, never values.

```bash
npx wrangler secret list --name meetmeatthefair-app | grep -c UNSUBSCRIBE_SECRET
(cd mcp-server && npx wrangler secret list --name meetmeatthefair-mcp | grep -c UNSUBSCRIBE_SECRET)
```

## (b) Wait 30+ days

Mail signed with `INTERNAL_API_KEY` stops being sent at step (a). After 30 days
the newest such link is out of its CAN-SPAM window.

## (c) Retire `INTERNAL_API_KEY` from unsubscribe verification

```bash
echo 1 | npx wrangler secret put UNSUBSCRIBE_RETIRE_INTERNAL_KEY --name meetmeatthefair-app
```

Effect: `/unsubscribe/*` stops accepting links signed with `INTERNAL_API_KEY`, so
that key no longer guards anything a recipient holds and **can be rotated**. The
switch is ignored while `UNSUBSCRIBE_SECRET` is unset, so it can never leave the
system with no signer.

## Rotating `UNSUBSCRIBE_SECRET` itself later

1. Put the **current** value into `UNSUBSCRIBE_SECRET_PREVIOUS` on the main app,
   so links signed with it keep verifying.
2. Set a new `UNSUBSCRIBE_SECRET` on both Workers, using step (a)'s command.
3. After 30+ days, delete `UNSUBSCRIBE_SECRET_PREVIOUS`.

⚠️ Step 1 needs the current value, and Cloudflare will not reveal a secret. There
is no ordering of these keys that keeps old links working without it: the main
app verifies with what it holds. If the value is lost, either rotate only after
30 days with no outbound mail, or accept that links delivered in the last 30
days will read "Invalid unsubscribe link". If you want rotation to stay
possible, store the value from step (a) in a password manager at the time,
for example by piping it to `pass insert -m mmatf/unsubscribe-secret` as a third
`tee` target.

The newsletter is unaffected throughout. It signs with
`NEWSLETTER_UNSUBSCRIBE_SECRET || AUTH_SECRET` (`src/lib/email/newsletter-unsubscribe-token.ts`).
