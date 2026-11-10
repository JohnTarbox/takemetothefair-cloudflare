import type { Metadata } from "next";
import Link from "next/link";
import { WebPageSchema } from "@/components/seo/WebPageSchema";
import { TEMPLATE_COLUMNS } from "@/lib/promoter-import/rows";
import {
  MAX_REQUEST_ID_LENGTH,
  MAX_SKEW_SECONDS,
  PROMOTER_API_RATE,
} from "@/lib/promoter-api/auth";

/**
 * OPE-1620 — public docs for the promoter events API: signing, endpoints,
 * errors, and a Zapier / Make recipe. The field table is built from the
 * spreadsheet template, the same list the API parses.
 */
export const revalidate = 86400;

const URL_BASE = "https://meetmeatthefair.com";
const PAGE_URL = `${URL_BASE}/help/promoters/api`;
const DESCRIPTION =
  "Send your events to Meet Me at the Fair from your own system, Zapier or Make: a signed JSON API for promoters. New events are reviewed before they appear.";

export const metadata: Metadata = {
  title: "Promoter Events API | Meet Me at the Fair",
  description: DESCRIPTION,
  alternates: { canonical: PAGE_URL },
  openGraph: {
    title: "Promoter Events API | Meet Me at the Fair",
    description: DESCRIPTION,
    url: PAGE_URL,
    siteName: "Meet Me at the Fair",
    type: "website",
    images: [`${URL_BASE}/og-default.png`],
  },
};

const CURL = `KEY_ID="mmk_your_key_id"
SECRET="your_secret"
BODY='{"external_id":"fall-fair-2027","name":"Fall Craft Fair","start_date":"2027-10-02","end_date":"2027-10-03","daily_hours":"9am-4pm","venue_name":"Town Hall","city":"Concord","state":"NH","admission":"Free"}'
TS=$(date +%s)
REQ=$(uuidgen)
SIG=$(printf '%s' "$TS.$REQ.$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

curl -sS -X POST ${URL_BASE}/api/v1/promoter/events \\
  -H "Content-Type: application/json" \\
  -H "X-MMATF-Key: $KEY_ID" \\
  -H "X-MMATF-Timestamp: $TS" \\
  -H "X-MMATF-Request-Id: $REQ" \\
  -H "X-MMATF-Signature: sha256=$SIG" \\
  --data-binary "$BODY"`;

const NODE = `import { createHmac, randomUUID } from "node:crypto";

const KEY_ID = process.env.MMATF_KEY_ID;   // mmk_...
const SECRET = process.env.MMATF_SECRET;   // never in a web page

async function mmatf(method, path, payload) {
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const requestId = randomUUID();
  const sig = createHmac("sha256", SECRET).update(\`\${ts}.\${requestId}.\${body}\`).digest("hex");
  const res = await fetch(\`${URL_BASE}\${path}\`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-MMATF-Key": KEY_ID,
      "X-MMATF-Timestamp": ts,
      "X-MMATF-Request-Id": requestId,
      "X-MMATF-Signature": \`sha256=\${sig}\`,
    },
    body: body || undefined,
  });
  return { status: res.status, json: await res.json() };
}

// Create or update by your own id
await mmatf("POST", "/api/v1/promoter/events", {
  external_id: "fall-fair-2027",
  name: "Fall Craft Fair",
  start_date: "2027-10-02",
  city: "Concord",
  state: "NH",
});
// Change one field (staged for review)
await mmatf("PATCH", "/api/v1/promoter/events/fall-fair-2027", { daily_hours: "10am-5pm" });
// Ask for a cancellation (staged for review)
await mmatf("POST", "/api/v1/promoter/events/fall-fair-2027/cancel", { reason: "Rain date moved" });
// List your events
await mmatf("GET", "/api/v1/promoter/events?limit=50");`;

const ZAPIER_CODE = `// Code by Zapier → Run JavaScript.
// Input Data: secret, external_id, name, start_date, city, state (map from your trigger)
const crypto = require("crypto");
const body = JSON.stringify({
  external_id: inputData.external_id,
  name: inputData.name,
  start_date: inputData.start_date,
  city: inputData.city,
  state: inputData.state,
});
const timestamp = String(Math.floor(Date.now() / 1000));
const requestId = crypto.randomUUID();
const signature = "sha256=" + crypto
  .createHmac("sha256", inputData.secret)
  .update(timestamp + "." + requestId + "." + body)
  .digest("hex");
output = { body, timestamp, requestId, signature };`;

const MAKE_SIG = `RequestId   {{uuid}}
Timestamp   {{formatDate(now; "X")}}
Body        {"external_id":"{{1.id}}","name":"{{1.name}}","start_date":"{{1.date}}","city":"{{1.city}}","state":"{{1.state}}"}
Signature   sha256={{sha256(Timestamp.RequestId.Body; hex; Secret)}}
            (in the editor: sha256( {{Timestamp}}.{{RequestId}}.{{Body}} ; hex ; {{Secret}} ),
             with a literal "." between the three variables)`;

const ERRORS: Array<[string, string, string]> = [
  ["401", "missing_auth_headers", "A signing header is missing or malformed."],
  ["401", "invalid_key", "The key is unknown or revoked."],
  [
    "401",
    "stale_timestamp",
    `X-MMATF-Timestamp is more than ${MAX_SKEW_SECONDS} seconds from our clock. Check the sender's clock.`,
  ],
  ["401", "bad_signature", "The signature does not match. See the signing recipe."],
  ["409", "replayed_request", "This request id was already used with this key. Send a new one."],
  [
    "409",
    "conflict_other_promoter",
    "The event matches one another organizer lists. Email us if it is yours.",
  ],
  [
    "409",
    "conflict_external_id",
    "The event matches one of yours already linked to a different external_id.",
  ],
  ["409", "in_progress", "Another request for this external_id is still running. Retry shortly."],
  ["404", "not_found", "No event with that external_id for your key."],
  ["413", "body_too_large", "The body is over 64 KB."],
  ["400", "invalid_json", "The body is not JSON."],
  ["422", "validation_failed", "error.errors lists each problem as {field, message}."],
  [
    "429",
    "rate_limited",
    `More than ${PROMOTER_API_RATE.max} requests a minute for this key. Wait for Retry-After.`,
  ],
  ["500", "internal_error", "Our side failed. Retry with a new request id."],
];

function Code({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-muted p-4 text-sm">
      <code>{children}</code>
    </pre>
  );
}

export default function PromoterApiDocsPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-12 space-y-10 text-foreground">
      <WebPageSchema
        name="Promoter Events API | Meet Me at the Fair"
        description={DESCRIPTION}
        url={PAGE_URL}
      />
      <header className="space-y-3">
        <p className="text-sm text-muted-foreground">
          <Link href="/help" className="underline">
            Help
          </Link>{" "}
          / For Promoters
        </p>
        <h1 className="text-4xl font-bold">Promoter Events API</h1>
        <p className="text-lg text-muted-foreground">
          Send your events to Meet Me at the Fair straight from your own website, ticketing system,
          Zapier or Make. Listing is free.
        </p>
        <div className="rounded-lg border border-border p-4">
          <strong>New events are reviewed before they appear.</strong> A new event goes in as
          pending and a person checks it. A change to an event that is already listed, and a
          cancellation, are also reviewed before they go live. The API never changes a listed event
          directly.
        </div>
      </header>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">1. Get a key</h2>
        <p>
          Claim your promoter listing, then open{" "}
          <Link href="/promoter/api-keys" className="underline">
            Promoter Portal → API Keys
          </Link>{" "}
          and create a key. You get a <em>key ID</em> (starts with <code>mmk_</code>) and a{" "}
          <em>secret</em>. The secret is shown once. Keep it on your server or in your automation
          tool&apos;s secret settings, never in a web page. Revoke a key there at any time; it stops
          working at once.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">2. Sign every request</h2>
        <p>Every request, including GET, carries four headers:</p>
        <ul className="list-disc pl-6 space-y-1">
          <li>
            <code>X-MMATF-Key</code>: your key ID.
          </li>
          <li>
            <code>X-MMATF-Timestamp</code>: the current Unix time in seconds. It must be within{" "}
            {MAX_SKEW_SECONDS} seconds of our clock.
          </li>
          <li>
            <code>X-MMATF-Request-Id</code>: a new unique value for every request (a UUID is ideal),
            1–{MAX_REQUEST_ID_LENGTH} printable characters with no spaces. A request id can be used
            once per key.
          </li>
          <li>
            <code>X-MMATF-Signature</code>: <code>sha256=</code> followed by the hex HMAC-SHA256 of{" "}
            <code>&lt;timestamp&gt;.&lt;request id&gt;.&lt;raw body&gt;</code>, keyed with your
            secret. The body is the exact bytes you send; for GET it is empty, so you sign{" "}
            <code>&lt;timestamp&gt;.&lt;request id&gt;.</code>
          </li>
        </ul>
        <h3 className="text-lg font-semibold">curl</h3>
        <Code>{CURL}</Code>
        <h3 className="text-lg font-semibold">Node.js</h3>
        <Code>{NODE}</Code>
      </section>

      <section className="space-y-4">
        <h2 className="text-2xl font-semibold">3. Endpoints</h2>
        <div>
          <h3 className="text-lg font-semibold">
            <code>POST /api/v1/promoter/events</code>
          </h3>
          <p>
            Create or update one event, keyed by <code>external_id</code>: your own id for the event
            (letters, digits and <code>. _ : ~ -</code>, up to 100 characters). Posting the same{" "}
            <code>external_id</code> again never makes a second event.
          </p>
          <ul className="list-disc pl-6 space-y-1">
            <li>
              A new <code>external_id</code> creates a pending event:{" "}
              <code>
                201 {"{"}outcome: &quot;created&quot;, status: &quot;PENDING&quot;{"}"}
              </code>
              . If it matches an event you already have with us, it is linked to that event instead.
            </li>
            <li>
              A known <code>external_id</code> stages your changes for review:{" "}
              <code>outcome: &quot;update_staged&quot;</code> with <code>changes</code>, or{" "}
              <code>&quot;unchanged&quot;</code> if nothing differs.
            </li>
            <li>A blank or null field proposes nothing. The API never clears a field.</li>
          </ul>
        </div>
        <div>
          <h3 className="text-lg font-semibold">
            <code>PATCH /api/v1/promoter/events/{"{external_id}"}</code>
          </h3>
          <p>Change only the fields you send. Staged for review. 404 if the id is unknown.</p>
        </div>
        <div>
          <h3 className="text-lg font-semibold">
            <code>POST /api/v1/promoter/events/{"{external_id}"}/cancel</code>
          </h3>
          <p>
            Ask for a cancellation, with an optional{" "}
            <code>
              {"{"}&quot;reason&quot;: &quot;…&quot;{"}"}
            </code>
            . We review it before the event is marked cancelled:{" "}
            <code>outcome: &quot;cancel_staged&quot;</code>.
          </p>
        </div>
        <div>
          <h3 className="text-lg font-semibold">
            <code>GET /api/v1/promoter/events?limit=50&amp;cursor=…</code>
          </h3>
          <p>
            Your external ids with each event&apos;s status, ordered by external id. Pass{" "}
            <code>next_cursor</code> back as <code>cursor</code> for the next page.
          </p>
        </div>
        <p>
          The machine-readable contract is at{" "}
          <a href="/api/v1/openapi.json" className="underline">
            /api/v1/openapi.json
          </a>{" "}
          (OpenAPI 3.1). Each key may make {PROMOTER_API_RATE.max} requests a minute.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">Fields</h2>
        <p>
          The same fields as the{" "}
          <Link href="/promoter/events/import" className="underline">
            spreadsheet import
          </Link>
          , as JSON. Values may be strings or numbers; <code>categories</code> may also be a list.
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2">Field</th>
              <th>Required to create</th>
              <th>Example</th>
            </tr>
          </thead>
          <tbody>
            {TEMPLATE_COLUMNS.map((c) => (
              <tr key={c.key} className="border-t border-border">
                <td className="py-2">
                  <code>{c.key}</code>
                </td>
                <td>{c.required ? "Yes" : ""}</td>
                <td>{c.example}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-muted-foreground">
          On an existing event, changes to hours, venue, address, city, state, ZIP and categories
          are not compared yet; the response lists them under <code>not_compared</code>. Email us
          those changes for now.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">Errors</h2>
        <p>
          Every error is{" "}
          <code>
            {"{"}&quot;error&quot;: {"{"}&quot;code&quot;, &quot;message&quot;, &quot;errors&quot;?
            {"}"}
            {"}"}
          </code>
          . A validation error lists each problem:{" "}
          <code>
            [{"{"}&quot;field&quot;: &quot;start_date&quot;, &quot;message&quot;: &quot;…&quot;{"}"}
            ]
          </code>
          .
        </p>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-2">HTTP</th>
              <th>code</th>
              <th>Meaning</th>
            </tr>
          </thead>
          <tbody>
            {ERRORS.map(([status, code, meaning]) => (
              <tr key={code} className="border-t border-border">
                <td className="py-2">{status}</td>
                <td>
                  <code>{code}</code>
                </td>
                <td>{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">Zapier recipe</h2>
        <ol className="list-decimal pl-6 space-y-2">
          <li>Trigger: wherever your events live (a Google Sheet row, a form, your calendar).</li>
          <li>
            Action <strong>Code by Zapier → Run JavaScript</strong>. Add the Input Data fields below
            (paste your secret as <code>secret</code>) and this code:
          </li>
        </ol>
        <Code>{ZAPIER_CODE}</Code>
        <ol className="list-decimal pl-6 space-y-2" start={3}>
          <li>
            Action <strong>Webhooks by Zapier → Custom Request</strong>: Method POST, URL{" "}
            <code>{URL_BASE}/api/v1/promoter/events</code>, Data = the Code step&apos;s{" "}
            <code>body</code> (exactly as output, unchanged), Headers:{" "}
            <code>Content-Type: application/json</code>, <code>X-MMATF-Key</code> = your key ID,{" "}
            <code>X-MMATF-Timestamp</code> = <code>timestamp</code>, <code>X-MMATF-Request-Id</code>{" "}
            = <code>requestId</code>, <code>X-MMATF-Signature</code> = <code>signature</code>.
          </li>
          <li>
            Test it. A <code>bad_signature</code> almost always means the Data was changed after
            signing (Zapier reformatting, or Unflatten turned on): send the Code step&apos;s body as
            is.
          </li>
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">Make recipe</h2>
        <ol className="list-decimal pl-6 space-y-2">
          <li>
            Add a <strong>Tools → Set multiple variables</strong> module with Secret (your secret),
            RequestId, Timestamp, Body and Signature, using Make&apos;s built-in <code>uuid</code>,{" "}
            <code>formatDate</code> and <code>sha256</code> (with a key, <code>sha256</code>{" "}
            computes the HMAC):
          </li>
        </ol>
        <Code>{MAKE_SIG}</Code>
        <ol className="list-decimal pl-6 space-y-2" start={2}>
          <li>
            Add <strong>HTTP → Make a request</strong>: Method POST, URL{" "}
            <code>{URL_BASE}/api/v1/promoter/events</code>, Body type Raw, Content type JSON,
            Request content = the Body variable, and the four <code>X-MMATF-*</code> headers from
            the variables.
          </li>
          <li>
            Build Body once and use the same variable in both the signature and the request, so the
            signed bytes and the sent bytes are identical.
          </li>
        </ol>
      </section>

      <section className="space-y-3">
        <h2 className="text-2xl font-semibold">Coming later: a listed Zapier app</h2>
        <p>
          The recipes above use Zapier&apos;s and Make&apos;s generic HTTP steps. A listed
          &quot;Meet Me at the Fair&quot; app in Zapier&apos;s directory would remove the code step:
          it needs a Zapier developer-platform integration with an authentication scheme Zapier
          supports natively (an API key or OAuth in place of the request signing above), a
          &quot;Create or update event&quot; action and a &quot;Cancel event&quot; action mapped to
          these endpoints, a test account, and Zapier&apos;s review before it is public. Tell us if
          you would use it.
        </p>
      </section>
    </div>
  );
}
