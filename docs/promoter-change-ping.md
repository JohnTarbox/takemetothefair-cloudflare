# Tell us when your event page changes (draft, not published)

> **OPE-1621: held back on purpose.** This article goes into the public help
> registry (`src/lib/help-articles.ts`, slug `promoter-change-ping`) on the day
> `FEED_POLLING_ENABLED` is switched on in `mcp-server/wrangler.toml`. Until then
> a ping is recorded but triggers no read, so "we re-read it within minutes"
> would be untrue. Under OPE-1608 we only describe channels that are live.

If we read your events from your own website or calendar feed, you can tell us the moment something changes, and we will re-read it within minutes instead of waiting for our next scheduled check.

A ping is only a nudge. It never carries event details: we always go back to your page or feed and read it ourselves. That also means nobody else can change your listings by sending a ping.

## Before you start

Pings work for an address on your organization's own website that we already read as an event feed. If we don't read your site yet, [contact us](/contact) and we'll set it up. It's free.

## Send a ping

Send a POST to `https://meetmeatthefair.com/api/v1/ping` with the address of the page or feed that changed:

    curl -X POST https://meetmeatthefair.com/api/v1/ping \\
      -d "url=https://www.example-fair.org/events/harvest-festival/"

JSON works too:

    curl -X POST https://meetmeatthefair.com/api/v1/ping \\
      -H "Content-Type: application/json" \\
      -d '{"url":"https://www.example-fair.org/events/"}'

The answer is always `202` with `{"ok":true}`, whether or not the address is one we read. We don't confirm which sites we know. You'll see `400` only if the URL is missing or isn't an http(s) address, and `429` if you send too many in an hour (about 30 per site). Several pings in a few minutes are combined into one re-read, so there's no harm in pinging on every save.

## WordPress

Add this to your theme's `functions.php` or a small plugin. It pings whenever a post or page is published or updated, and when an event is saved in The Events Calendar:

    function mmatf_ping( $url ) {
        wp_remote_post( 'https://meetmeatthefair.com/api/v1/ping', array(
            'body'     => array( 'url' => $url ),
            'timeout'  => 5,
            'blocking' => false,
        ) );
    }

    function mmatf_ping_on_save( $post_id, $post ) {
        if ( wp_is_post_revision( $post_id ) || wp_is_post_autosave( $post_id ) ) {
            return;
        }
        if ( 'publish' !== $post->post_status ) {
            return;
        }
        mmatf_ping( get_permalink( $post_id ) );
    }
    add_action( 'save_post', 'mmatf_ping_on_save', 10, 2 );

    function mmatf_ping_on_event_save( $event_id ) {
        mmatf_ping( get_permalink( $event_id ) );
    }
    add_action( 'tribe_events_event_save', 'mmatf_ping_on_event_save', 10, 1 );

An event save can fire both hooks. That's fine, because the two pings are combined.

## WebSub

If your feed already announces a WebSub hub (a `rel="hub"` link, which many WordPress feed plugins add), you don't need to do anything. We subscribe to the hub and treat each of its notifications as a ping.
