-- OPE-635 — record the one settled draft as `superseded` rather than `discarded`.
--
-- Background: reply 4b6283d6 was approved 2026-08-17, sat undelivered for 13
-- days because nothing drains the approved queue, and was finally delivered by
-- hand through `reply_to_inbound_email` (message 73a7d935…, delivered). The
-- queued copy then could not be closed out — `review_pending_reply` refused to
-- re-review a settled draft — so on 2026-08-30, at John's explicit instruction,
-- it was neutralised with a raw D1 UPDATE to `discarded` plus an explanation in
-- `review_note`. `discarded` was simply the only terminal value the enum had.
--
-- This restates that row in the vocabulary that now exists. It is a relabel of
-- one already-settled row: no mail is sent, nothing is deleted, and the row was
-- already terminal before and after.
--
-- Safe to run on an EMPTY database: a WHERE that matches nothing updates
-- nothing, so a fresh CI D1 built from migrations is unaffected. Idempotent: the
-- second run matches no rows because `status` is no longer 'discarded'.
UPDATE pending_email_replies
   SET status = 'superseded'
 WHERE id = '4b6283d6-a261-4a7d-91af-71e9bebedc85'
   AND status = 'discarded'
   AND sent_message_id = '73a7d935d6496cc5c40209632f0f4c82';

-- Deliberately NOT touching 66e61290 and d1504a33.
--
-- Both read "Superseded — …" in `review_note` and both are genuinely that. But
-- neither has a `sent_message_id`, and `supersede` now REQUIRES one, reconciled
-- against `email_send_ledger`. Promoting them would mint `superseded` rows that
-- the tool itself could never produce — an invariant that holds everywhere
-- except in the rows a migration wrote is not an invariant.
--
-- They also share an inbound (f4a99ffb) with 4b6283d6, so no single ledger send
-- attributes cleanly to one of them. Their prose note already records what
-- happened, which is the honest amount of certainty available. `discarded` +
-- note is a true statement about them; `superseded` with a guessed message id
-- would not be.
