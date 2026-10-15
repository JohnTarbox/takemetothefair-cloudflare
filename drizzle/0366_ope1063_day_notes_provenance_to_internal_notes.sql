-- OPE-1063 — move operator/provenance prose out of the PUBLIC event_days.notes.
--
-- The OPE-1063 render fix stops the collapsed "Daily:" line from discarding
-- day notes, which would publish 76 notes that were written as operator
-- provenance ("Source: … fetched …", "Confirmed via …", "Hours estimated",
-- a private vendor contact's name). Reviewed by hand against prod on
-- 2026-10-15: 69 class-(b) provenance rows + 7 class-(c) visitor-ambiguous
-- rows ("Public hours, single-day event" filler, "Vendor setup from 7:30am.").
--
-- Per row: the FULL original note is moved to internal_notes (appended after a
-- newline when internal_notes already holds text), and notes becomes either
-- NULL (17 rows) or the visitor-facing part of the original (59 mixed
-- rows). No content is deleted — every original string survives verbatim in
-- internal_notes.
--
-- Bulk-mutation discipline (docs/bulk-mutation-discipline.md):
--   single-writer — applied once by the deploy's migrate step.
--   idempotent    — every statement is keyed on id AND notes = '<exact prod
--                   text>'. After it runs, notes no longer equals that text, so a
--                   re-run changes 0 rows; on an empty (CI) database it matches
--                   nothing.
--   read-back     — expect 76 rows changed. Afterwards:
--                   SELECT COUNT(*) FROM event_days WHERE id IN (<ids>) AND
--                   internal_notes LIKE '%' || <original> || '%'  → 76.
--   rollback      — scripts/rollback/0366_ope1063_day_notes_provenance.rollback.sql
--                   (keyed on the post-state, so it is equally idempotent).

-- america-250-brass-band-concert-june-29 2026-06-29 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Concert at 7 PM per Exeter 250 calendar. Food trucks typically set up ahead of concert; window covers pre-show food service through cleanup.'
      ELSE internal_notes || char(10) || 'Concert at 7 PM per Exeter 250 calendar. Food trucks typically set up ahead of concert; window covers pre-show food service through cleanup.'
    END,
    notes = 'Concert at 7 PM. Food trucks typically set up ahead of the concert.'
WHERE id = '01f745fe-c6eb-4f3d-a8bd-bfefd6d710a6'
  AND notes = 'Concert at 7 PM per Exeter 250 calendar. Food trucks typically set up ahead of concert; window covers pre-show food service through cleanup.';

-- america-250-tune-and-fork-concert-july-7 2026-07-07 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Concert at 5 PM per Exeter 250 calendar. Window covers pre-show food trucks through cleanup.'
      ELSE internal_notes || char(10) || 'Concert at 5 PM per Exeter 250 calendar. Window covers pre-show food trucks through cleanup.'
    END,
    notes = 'Concert at 5 PM.'
WHERE id = '4f378eb8-da5f-4eec-ad03-5f1711e6983b'
  AND notes = 'Concert at 5 PM per Exeter 250 calendar. Window covers pre-show food trucks through cleanup.';

-- america-250-tune-and-fork-concert-june-30 2026-06-30 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Concert at 5 PM per Exeter 250 calendar. Window covers pre-show food trucks through cleanup.'
      ELSE internal_notes || char(10) || 'Concert at 5 PM per Exeter 250 calendar. Window covers pre-show food trucks through cleanup.'
    END,
    notes = 'Concert at 5 PM.'
WHERE id = 'e0b6e6a9-97e6-4564-b676-116b3a6549eb'
  AND notes = 'Concert at 5 PM per Exeter 250 calendar. Window covers pre-show food trucks through cleanup.';

-- american-independence-festival-2026 2026-07-11 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Saturday, 10am-4pm. Per Exeter 250 commission calendar. Confirmed via exeternh.gov/250cc on 2026-05-11.'
      ELSE internal_notes || char(10) || 'Saturday, 10am-4pm. Per Exeter 250 commission calendar. Confirmed via exeternh.gov/250cc on 2026-05-11.'
    END,
    notes = 'Saturday, 10am-4pm.'
WHERE id = 'fd9d5d86-6534-4a98-b7f1-1ac84a3855fc'
  AND notes = 'Saturday, 10am-4pm. Per Exeter 250 commission calendar. Confirmed via exeternh.gov/250cc on 2026-05-11.';

-- applecrest-farm-blueberry-festival 2026-07-25 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Reunion Hill). Source: applecrest.com/festivals-and-happenings/'
      ELSE internal_notes || char(10) || 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Reunion Hill). Source: applecrest.com/festivals-and-happenings/'
    END,
    notes = 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Reunion Hill).'
WHERE id = 'evd_dc1e1240-c06f-43dd-94c1-c5d31cccb303_2026-07-25'
  AND notes = 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Reunion Hill). Source: applecrest.com/festivals-and-happenings/';

-- applecrest-farm-blueberry-festival 2026-07-26 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Cedar Mountain Bluegrass). Source: applecrest.com/festivals-and-happenings/'
      ELSE internal_notes || char(10) || 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Cedar Mountain Bluegrass). Source: applecrest.com/festivals-and-happenings/'
    END,
    notes = 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Cedar Mountain Bluegrass).'
WHERE id = 'evd_dc1e1240-c06f-43dd-94c1-c5d31cccb303_2026-07-26'
  AND notes = 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Cedar Mountain Bluegrass). Source: applecrest.com/festivals-and-happenings/';

-- bangor-sunday-farmers-market-2026-08-23 2026-08-23 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Sunday. Per bangorfarmersmarket.org: "Every Sunday May to November, 11:00 AM to 1:30 PM," summer location Abbot Square. Accepts cash, SNAP/EBT, cards and Bumper Crop gift certificates.'
      ELSE internal_notes || char(10) || 'Sunday. Per bangorfarmersmarket.org: "Every Sunday May to November, 11:00 AM to 1:30 PM," summer location Abbot Square. Accepts cash, SNAP/EBT, cards and Bumper Crop gift certificates.'
    END,
    notes = 'Sunday. Every Sunday May to November, 11:00 AM to 1:30 PM; summer location Abbott Square. Accepts cash, SNAP/EBT, cards and Bumper Crop gift certificates.'
WHERE id = 'evd_b184ec471c18587cbb3eb61c3645ee31_2026-08-23'
  AND notes = 'Sunday. Per bangorfarmersmarket.org: "Every Sunday May to November, 11:00 AM to 1:30 PM," summer location Abbot Square. Accepts cash, SNAP/EBT, cards and Bumper Crop gift certificates.';

-- blueberry-festival-at-the-apple-barn 2026-07-25 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN '10:00am-5:00pm confirmed. Source: Bennington Banner 2026-07-15 (quotes organizer press release and owner Sarah Albright); theapplebarn.com is client-side rendered and returns an empty body to text fetches. Note an earlier secondary source said 4pm — the July 15 2026 piece says 5pm and was used.'
      ELSE internal_notes || char(10) || '10:00am-5:00pm confirmed. Source: Bennington Banner 2026-07-15 (quotes organizer press release and owner Sarah Albright); theapplebarn.com is client-side rendered and returns an empty body to text fetches. Note an earlier secondary source said 4pm — the July 15 2026 piece says 5pm and was used.'
    END,
    notes = NULL
WHERE id = 'evd_6967c83c-8357-4544-9b5d-2244ce3cb04c_2026-07-25'
  AND notes = '10:00am-5:00pm confirmed. Source: Bennington Banner 2026-07-15 (quotes organizer press release and owner Sarah Albright); theapplebarn.com is client-side rendered and returns an empty body to text fetches. Note an earlier secondary source said 4pm — the July 15 2026 piece says 5pm and was used.';

-- bondville-fair-winhall 2026-08-28 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Friday. Organizer (bondvillefair.org): "Gates Open at 10:00AM Daily / Rides Open at 11:00AM Daily". Closing time NOT PUBLISHED — left null rather than estimated. Friday admission $10 before 5:00PM, $20 after 5:00PM, so the fair clearly runs into the evening.'
      ELSE internal_notes || char(10) || 'Friday. Organizer (bondvillefair.org): "Gates Open at 10:00AM Daily / Rides Open at 11:00AM Daily". Closing time NOT PUBLISHED — left null rather than estimated. Friday admission $10 before 5:00PM, $20 after 5:00PM, so the fair clearly runs into the evening.'
    END,
    notes = 'Friday. Gates 10:00AM, rides 11:00AM. Admission $10 before 5:00PM, $20 after 5:00PM.'
WHERE id = 'evd_24a27819-e627-4f76-a150-df9669996738_2026-08-28'
  AND notes = 'Friday. Organizer (bondvillefair.org): "Gates Open at 10:00AM Daily / Rides Open at 11:00AM Daily". Closing time NOT PUBLISHED — left null rather than estimated. Friday admission $10 before 5:00PM, $20 after 5:00PM, so the fair clearly runs into the evening.';

-- bondville-fair-winhall 2026-08-29 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Saturday. Gates 10:00AM, rides 11:00AM. Admission $25 Saturday. Closing time NOT PUBLISHED.'
      ELSE internal_notes || char(10) || 'Saturday. Gates 10:00AM, rides 11:00AM. Admission $25 Saturday. Closing time NOT PUBLISHED.'
    END,
    notes = 'Saturday. Gates 10:00AM, rides 11:00AM. Admission $25 Saturday.'
WHERE id = 'evd_24a27819-e627-4f76-a150-df9669996738_2026-08-29'
  AND notes = 'Saturday. Gates 10:00AM, rides 11:00AM. Admission $25 Saturday. Closing time NOT PUBLISHED.';

-- bondville-fair-winhall 2026-08-30 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Sunday. Gates 10:00AM, rides 11:00AM. Admission $20 Sunday. Closing time NOT PUBLISHED.'
      ELSE internal_notes || char(10) || 'Sunday. Gates 10:00AM, rides 11:00AM. Admission $20 Sunday. Closing time NOT PUBLISHED.'
    END,
    notes = 'Sunday. Gates 10:00AM, rides 11:00AM. Admission $20 Sunday.'
WHERE id = 'evd_24a27819-e627-4f76-a150-df9669996738_2026-08-30'
  AND notes = 'Sunday. Gates 10:00AM, rides 11:00AM. Admission $20 Sunday. Closing time NOT PUBLISHED.';

-- brattleboro-area-farmers-market-2026-08-22 2026-08-22 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Saturday. Per brattleboroareafarmersmarket.com: "Join us every Saturday 9am-2pm", "from May to October", at 570 Western Ave (Route 9), Brattleboro VT 05301. Organizer states no season end date; the May 2 - Oct 31 window circulating elsewhere is from the Brattleboro Reformer, not the organizer.'
      ELSE internal_notes || char(10) || 'Saturday. Per brattleboroareafarmersmarket.com: "Join us every Saturday 9am-2pm", "from May to October", at 570 Western Ave (Route 9), Brattleboro VT 05301. Organizer states no season end date; the May 2 - Oct 31 window circulating elsewhere is from the Brattleboro Reformer, not the organizer.'
    END,
    notes = 'Saturday. Every Saturday 9am-2pm, May to October, at 570 Western Ave (Route 9), Brattleboro.'
WHERE id = 'evd_7f72d7eed1db0ad5d3444631d936d9d9_2026-08-22'
  AND notes = 'Saturday. Per brattleboroareafarmersmarket.com: "Join us every Saturday 9am-2pm", "from May to October", at 570 Western Ave (Route 9), Brattleboro VT 05301. Organizer states no season end date; the May 2 - Oct 31 window circulating elsewhere is from the Brattleboro Reformer, not the organizer.';

-- bruce-museum-45th-annual-outdoor-arts-festival-2026 2026-10-10 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Saturday — open to the public. Hours per museum festivals page.'
      ELSE internal_notes || char(10) || 'Saturday — open to the public. Hours per museum festivals page.'
    END,
    notes = 'Saturday — open to the public.'
WHERE id = 'evd_a861a1ea-fc69-40c9-99bf-783fbaba7c78_2026-10-10'
  AND notes = 'Saturday — open to the public. Hours per museum festivals page.';

-- bruce-museum-45th-annual-outdoor-arts-festival-2026 2026-10-11 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Sunday — final day. Hours per museum festivals page.'
      ELSE internal_notes || char(10) || 'Sunday — final day. Hours per museum festivals page.'
    END,
    notes = 'Sunday — final day.'
WHERE id = 'evd_a861a1ea-fc69-40c9-99bf-783fbaba7c78_2026-10-11'
  AND notes = 'Sunday — final day. Hours per museum festivals page.';

-- burlington-summer-farmers-market-2026-08-22 2026-08-22 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Saturday. Per burlingtonfarmersmarket.org: "Summer 2026 — 9:00am-2:00pm | 345 Pine St | Every Saturday May 9 - October 31, 2026." Rain or shine.'
      ELSE internal_notes || char(10) || 'Saturday. Per burlingtonfarmersmarket.org: "Summer 2026 — 9:00am-2:00pm | 345 Pine St | Every Saturday May 9 - October 31, 2026." Rain or shine.'
    END,
    notes = 'Saturday. Every Saturday May 9 - October 31, 2026, 9:00am-2:00pm at 345 Pine St. Rain or shine.'
WHERE id = 'evd_107ac9d3973ff9478c9a35cce96f32eb_2026-08-22'
  AND notes = 'Saturday. Per burlingtonfarmersmarket.org: "Summer 2026 — 9:00am-2:00pm | 345 Pine St | Every Saturday May 9 - October 31, 2026." Rain or shine.';

-- buzzed-lightbier-festival-2026 2026-08-29 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Saturday. ORGANIZER''S OWN PAGE IS SELF-INCONSISTENT: valleybeer.io/concerts shows a "4:00 PM" listing header, but the body copy on the same page reads "Join us on August 29 starting at noon for a day of crispy beers and great company. Live music runs noon till 8 PM." Recorded the more specific body copy (noon-8 PM); the 4 PM header is the organizer''s discrepancy, not ours. Admission price NOT PUBLISHED on valleybeer.io — ticketing is off-site.'
      ELSE internal_notes || char(10) || 'Saturday. ORGANIZER''S OWN PAGE IS SELF-INCONSISTENT: valleybeer.io/concerts shows a "4:00 PM" listing header, but the body copy on the same page reads "Join us on August 29 starting at noon for a day of crispy beers and great company. Live music runs noon till 8 PM." Recorded the more specific body copy (noon-8 PM); the 4 PM header is the organizer''s discrepancy, not ours. Admission price NOT PUBLISHED on valleybeer.io — ticketing is off-site.'
    END,
    notes = 'Saturday. Live music runs noon till 8 PM.'
WHERE id = 'evd_8fc5c8fa6b337d01a55e8586bb164aa9_2026-08-29'
  AND notes = 'Saturday. ORGANIZER''S OWN PAGE IS SELF-INCONSISTENT: valleybeer.io/concerts shows a "4:00 PM" listing header, but the body copy on the same page reads "Join us on August 29 starting at noon for a day of crispy beers and great company. Live music runs noon till 8 PM." Recorded the more specific body copy (noon-8 PM); the 4 PM header is the organizer''s discrepancy, not ours. Admission price NOT PUBLISHED on valleybeer.io — ticketing is off-site.';

-- capital-city-farmers-market-2026-08-22 2026-08-22 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Saturday. Per capitalcityfarmersmarket.com: summer season at 133 State Street, Montpelier — "Every Saturday, May-October, 9am-1pm."'
      ELSE internal_notes || char(10) || 'Saturday. Per capitalcityfarmersmarket.com: summer season at 133 State Street, Montpelier — "Every Saturday, May-October, 9am-1pm."'
    END,
    notes = 'Saturday. Summer season at 133 State Street, Montpelier — every Saturday, May-October, 9am-1pm.'
WHERE id = 'evd_3aed37b5cc4f159ee19ff4dfccd1f807_2026-08-22'
  AND notes = 'Saturday. Per capitalcityfarmersmarket.com: summer season at 133 State Street, Montpelier — "Every Saturday, May-October, 9am-1pm."';

-- caravan-feisty-fall-market-2026 2026-10-11 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Hours based on prior Caravan Bath markets (10am–4pm). Rain date: Oct 18.'
      ELSE internal_notes || char(10) || 'Hours based on prior Caravan Bath markets (10am–4pm). Rain date: Oct 18.'
    END,
    notes = 'Rain date: Oct 18.'
WHERE id = '1ede1a81-51da-4da1-9647-1725c79e4185'
  AND notes = 'Hours based on prior Caravan Bath markets (10am–4pm). Rain date: Oct 18.';

-- caravan-holidaze-sale-2026 2026-12-12 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Hours estimated; confirm closer to event.'
      ELSE internal_notes || char(10) || 'Hours estimated; confirm closer to event.'
    END,
    notes = NULL
WHERE id = 'f2e31100-d526-48b6-a6fa-c45c5a6a722b'
  AND notes = 'Hours estimated; confirm closer to event.';

-- caravan-holidaze-sale-2026 2026-12-13 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Hours estimated; confirm closer to event.'
      ELSE internal_notes || char(10) || 'Hours estimated; confirm closer to event.'
    END,
    notes = NULL
WHERE id = 'ff9d59e4-4c1f-4601-8ea8-bc203b6c94e7'
  AND notes = 'Hours estimated; confirm closer to event.';

-- caravan-make-it-hot-market-at-allagash-brewing-2026 2026-07-19 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Open to public. Hours based on prior Caravan-at-Allagash markets (11am–4pm); confirm closer to event.'
      ELSE internal_notes || char(10) || 'Open to public. Hours based on prior Caravan-at-Allagash markets (11am–4pm); confirm closer to event.'
    END,
    notes = 'Open to public.'
WHERE id = 'db136c8c-2061-455c-80e1-e7d6ab8f1f7a'
  AND notes = 'Open to public. Hours based on prior Caravan-at-Allagash markets (11am–4pm); confirm closer to event.';

-- caravan-night-block-party-2026 2026-09-12 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Evening block party; hours estimated — confirm closer to event.'
      ELSE internal_notes || char(10) || 'Evening block party; hours estimated — confirm closer to event.'
    END,
    notes = 'Evening block party.'
WHERE id = '2b33899c-cb9c-4944-ab08-89d6be8e491a'
  AND notes = 'Evening block party; hours estimated — confirm closer to event.';

-- connecticut-bridal-wedding-expo-middletown-june-2026 2026-06-07 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Sunday, 11am-6pm. Confirmed via bridalshowsct-hc.com on 2026-05-10.'
      ELSE internal_notes || char(10) || 'Sunday, 11am-6pm. Confirmed via bridalshowsct-hc.com on 2026-05-10.'
    END,
    notes = 'Sunday, 11am-6pm.'
WHERE id = '3dea4171-8d2a-4290-9bc4-0b6c18bb5273'
  AND notes = 'Sunday, 11am-6pm. Confirmed via bridalshowsct-hc.com on 2026-05-10.';

-- edward-little-high-school-craft-fair 2026-10-10 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Hours not stated on the submitted flyer.'
      ELSE internal_notes || char(10) || 'Hours not stated on the submitted flyer.'
    END,
    notes = NULL
WHERE id = 'evd_568b7f76-88d9-48b9-9916-343574a1345d_2026-10-10'
  AND notes = 'Hours not stated on the submitted flyer.';

-- exeter-community-picnic-and-concert-america-250 2026-07-09 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Thursday evening, 6 PM start per Exeter 250 calendar. Approximate close.'
      ELSE internal_notes || char(10) || 'Thursday evening, 6 PM start per Exeter 250 calendar. Approximate close.'
    END,
    notes = 'Thursday evening, 6 PM start.'
WHERE id = '18040b0d-151d-4d76-bc81-49ff8c8322d3'
  AND notes = 'Thursday evening, 6 PM start per Exeter 250 calendar. Approximate close.';

-- exeter-farmers-market-america-250-edition 2026-07-09 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Thursday afternoon, 2:30 PM start per Exeter 250 calendar. Approximate close time.'
      ELSE internal_notes || char(10) || 'Thursday afternoon, 2:30 PM start per Exeter 250 calendar. Approximate close time.'
    END,
    notes = 'Thursday afternoon, 2:30 PM start.'
WHERE id = 'd03dfe23-31c7-4421-b688-1d1ca278d770'
  AND notes = 'Thursday afternoon, 2:30 PM start per Exeter 250 calendar. Approximate close time.';

-- exeter-fireworks-america-250 2026-07-11 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Fireworks at 9 PM per Exeter 250 calendar. Food trucks typically set up earlier in the evening; window covers food service through dispersal after the show.'
      ELSE internal_notes || char(10) || 'Fireworks at 9 PM per Exeter 250 calendar. Food trucks typically set up earlier in the evening; window covers food service through dispersal after the show.'
    END,
    notes = 'Fireworks at 9 PM. Food trucks typically set up earlier in the evening.'
WHERE id = '8e0a7160-792f-40f2-b4b7-8672b9ce55b6'
  AND notes = 'Fireworks at 9 PM per Exeter 250 calendar. Food trucks typically set up earlier in the evening; window covers food service through dispersal after the show.';

-- farmington-fair 2026-09-20 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Opening day. Midway / rides open 12:00–21:00. Starbird building opens 09:00. First scheduled event 09:00 (Youth Beef Show). Miss Farmington Fair Pageant 18:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
      ELSE internal_notes || char(10) || 'Opening day. Midway / rides open 12:00–21:00. Starbird building opens 09:00. First scheduled event 09:00 (Youth Beef Show). Miss Farmington Fair Pageant 18:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
    END,
    notes = 'Opening day. Midway / rides open 12:00–21:00. Starbird building opens 09:00. First scheduled event 09:00 (Youth Beef Show). Miss Farmington Fair Pageant 18:30.'
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-20'
  AND notes = 'Opening day. Midway / rides open 12:00–21:00. Starbird building opens 09:00. First scheduled event 09:00 (Youth Beef Show). Miss Farmington Fair Pageant 18:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-21 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Agriculture Education Day — Kids Ag Day 09:00–13:00 (Franklin County Soil & Water). Midway open 15:00–21:00; ride special 17:00–21:00 $27.00 (rain date Tue or Thu). Starbird building opens 12:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
      ELSE internal_notes || char(10) || 'Agriculture Education Day — Kids Ag Day 09:00–13:00 (Franklin County Soil & Water). Midway open 15:00–21:00; ride special 17:00–21:00 $27.00 (rain date Tue or Thu). Starbird building opens 12:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
    END,
    notes = 'Agriculture Education Day — Kids Ag Day 09:00–13:00 (Franklin County Soil & Water). Midway open 15:00–21:00; ride special 17:00–21:00 $27.00 (rain date Tue or Thu). Starbird building opens 12:00.'
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-21'
  AND notes = 'Agriculture Education Day — Kids Ag Day 09:00–13:00 (Franklin County Soil & Water). Midway open 15:00–21:00; ride special 17:00–21:00 $27.00 (rain date Tue or Thu). Starbird building opens 12:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-22 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Senior Citizen (62+) & Veterans Day — $5.00 admission. Midway open 15:00–21:00. Starbird building opens 10:00. First scheduled event 10:00. NAWA Wrestling 19:00–21:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
      ELSE internal_notes || char(10) || 'Senior Citizen (62+) & Veterans Day — $5.00 admission. Midway open 15:00–21:00. Starbird building opens 10:00. First scheduled event 10:00. NAWA Wrestling 19:00–21:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
    END,
    notes = 'Senior Citizen (62+) & Veterans Day — $5.00 admission. Midway open 15:00–21:00. Starbird building opens 10:00. First scheduled event 10:00. NAWA Wrestling 19:00–21:00.'
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-22'
  AND notes = 'Senior Citizen (62+) & Veterans Day — $5.00 admission. Midway open 15:00–21:00. Starbird building opens 10:00. First scheduled event 10:00. NAWA Wrestling 19:00–21:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-23 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Ride Bracelet day. Midway open 13:00–21:00; ride special 13:00–21:00 $37.00. Starbird building opens 12:00. Monster Truck Jamboree 18:00. Youth Market Auction 18:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
      ELSE internal_notes || char(10) || 'Ride Bracelet day. Midway open 13:00–21:00; ride special 13:00–21:00 $37.00. Starbird building opens 12:00. Monster Truck Jamboree 18:00. Youth Market Auction 18:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
    END,
    notes = 'Ride Bracelet day. Midway open 13:00–21:00; ride special 13:00–21:00 $37.00. Starbird building opens 12:00. Monster Truck Jamboree 18:00. Youth Market Auction 18:30.'
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-23'
  AND notes = 'Ride Bracelet day. Midway open 13:00–21:00; ride special 13:00–21:00 $37.00. Starbird building opens 12:00. Monster Truck Jamboree 18:00. Youth Market Auction 18:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-24 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Senior Citizens (62+) & Veterans Day. Midway open 15:00–21:00. Starbird building opens 10:00. Monster Truck Show 19:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
      ELSE internal_notes || char(10) || 'Senior Citizens (62+) & Veterans Day. Midway open 15:00–21:00. Starbird building opens 10:00. Monster Truck Show 19:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
    END,
    notes = 'Senior Citizens (62+) & Veterans Day. Midway open 15:00–21:00. Starbird building opens 10:00. Monster Truck Show 19:00.'
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-24'
  AND notes = 'Senior Citizens (62+) & Veterans Day. Midway open 15:00–21:00. Starbird building opens 10:00. Monster Truck Show 19:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-25 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Midway open 15:00–22:00; ride special 17:00–22:00 $32.00. Starbird building opens 12:00. Truck & Tractor Pull 17:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
      ELSE internal_notes || char(10) || 'Midway open 15:00–22:00; ride special 17:00–22:00 $32.00. Starbird building opens 12:00. Truck & Tractor Pull 17:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
    END,
    notes = 'Midway open 15:00–22:00; ride special 17:00–22:00 $32.00. Starbird building opens 12:00. Truck & Tractor Pull 17:30.'
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-25'
  AND notes = 'Midway open 15:00–22:00; ride special 17:00–22:00 $32.00. Starbird building opens 12:00. Truck & Tractor Pull 17:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-26 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'CLOSING DAY — the organizer''s program ends here; there is no September 27 in the 2026 schedule. Midway open 10:00–22:00. Starbird building opens 09:00. Antique Tractor Pull 10:00 (may run to ~15:00). Demolition Derby 18:30. Last listed item 19:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
      ELSE internal_notes || char(10) || 'CLOSING DAY — the organizer''s program ends here; there is no September 27 in the 2026 schedule. Midway open 10:00–22:00. Starbird building opens 09:00. Antique Tractor Pull 10:00 (may run to ~15:00). Demolition Derby 18:30. Last listed item 19:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".'
    END,
    notes = 'Closing day. Midway open 10:00–22:00. Starbird building opens 09:00. Antique Tractor Pull 10:00 (may run to ~15:00). Demolition Derby 18:30.'
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-26'
  AND notes = 'CLOSING DAY — the organizer''s program ends here; there is no September 27 in the 2026 schedule. Midway open 10:00–22:00. Starbird building opens 09:00. Antique Tractor Pull 10:00 (may run to ~15:00). Demolition Derby 18:30. Last listed item 19:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- gahs-interact-club-spring-craft-fair-2026 2026-05-16 (c)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Public hours, single-day event'
      ELSE internal_notes || char(10) || 'Public hours, single-day event'
    END,
    notes = NULL
WHERE id = '69b07e26-9e43-4319-964d-8cecf103c091'
  AND notes = 'Public hours, single-day event';

-- gahs-interact-club-spring-craft-fair-2026 2026-05-16 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Vendor setup window. Interact Club members assist with unloading. Per vendor recruitment email from advisor Raye Anne DeSoto on 2026-05-11.'
      ELSE internal_notes || char(10) || 'Vendor setup window. Interact Club members assist with unloading. Per vendor recruitment email from advisor Raye Anne DeSoto on 2026-05-11.'
    END,
    notes = 'Vendor setup window. Interact Club members assist with unloading.'
WHERE id = '48a4c03d-abdd-4045-9465-b64bc0bb7e93'
  AND notes = 'Vendor setup window. Interact Club members assist with unloading. Per vendor recruitment email from advisor Raye Anne DeSoto on 2026-05-11.';

-- general-stanton-inn-blues-music-festival-2026 2026-08-23 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Sunday, outdoor tent. Per the Inn''s own Eventbrite listing (event:start_time 2026-08-23T14:00-04:00, end 19:00-04:00). Lineup: Duke Robillard & His All Star Band, Neal Vitullo Band, Pat Halpin and the 351''s.'
      ELSE internal_notes || char(10) || 'Sunday, outdoor tent. Per the Inn''s own Eventbrite listing (event:start_time 2026-08-23T14:00-04:00, end 19:00-04:00). Lineup: Duke Robillard & His All Star Band, Neal Vitullo Band, Pat Halpin and the 351''s.'
    END,
    notes = 'Sunday, outdoor tent. Lineup: Duke Robillard & His All Star Band, Neal Vitullo Band, Pat Halpin and the 351''s.'
WHERE id = 'evd_33b42d19154fa6367f00784a964e1d04_2026-08-23'
  AND notes = 'Sunday, outdoor tent. Per the Inn''s own Eventbrite listing (event:start_time 2026-08-23T14:00-04:00, end 19:00-04:00). Lineup: Duke Robillard & His All Star Band, Neal Vitullo Band, Pat Halpin and the 351''s.';

-- hampden-county-4-h-fair-2026 2026-07-25 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Single-day fair, 9am-5pm at the Mallary Complex. Source: easternstatesexposition.com/events/2026/hamden-county-4-h-fair (host venue; the fair''s own site is dead).'
      ELSE internal_notes || char(10) || 'Single-day fair, 9am-5pm at the Mallary Complex. Source: easternstatesexposition.com/events/2026/hamden-county-4-h-fair (host venue; the fair''s own site is dead).'
    END,
    notes = 'Single-day fair, 9am-5pm at the Mallary Complex.'
WHERE id = 'evd_d4cc6a33-f6c0-43a1-b563-ca92873fded0_2026-07-25'
  AND notes = 'Single-day fair, 9am-5pm at the Mallary Complex. Source: easternstatesexposition.com/events/2026/hamden-county-4-h-fair (host venue; the fair''s own site is dead).';

-- harrys-comic-and-toy-show-franklin-august-2026 2026-08-23 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Sunday. Per mymummy.com (organizer, My Mummy Productions): "Hours 10-3pm", "Admission $5.00", August 23 2026 listed among 2026 show dates. Children under 16 free with a paid adult.'
      ELSE internal_notes || char(10) || 'Sunday. Per mymummy.com (organizer, My Mummy Productions): "Hours 10-3pm", "Admission $5.00", August 23 2026 listed among 2026 show dates. Children under 16 free with a paid adult.'
    END,
    notes = 'Sunday. Admission $5.00; children under 16 free with a paid adult.'
WHERE id = 'evd_f1bb012d-e003-4464-828e-ade83bc615f7_2026-08-23'
  AND notes = 'Sunday. Per mymummy.com (organizer, My Mummy Productions): "Hours 10-3pm", "Admission $5.00", August 23 2026 listed among 2026 show dates. Children under 16 free with a paid adult.';

-- harvest-festival-coggeshall-farm-2026 2026-09-19 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Hours confirmed on the organizer''s own event page. Demonstration schedule runs throughout: beekeeping 10am-4pm, heirloom apple tasting 10:30am-3pm, cider making 10:30am-2:30pm, horse-drawn wagon rides 11am-3pm, oxen team demonstrations at 11:30am, 12:30pm and 2pm.'
      ELSE internal_notes || char(10) || 'Hours confirmed on the organizer''s own event page. Demonstration schedule runs throughout: beekeeping 10am-4pm, heirloom apple tasting 10:30am-3pm, cider making 10:30am-2:30pm, horse-drawn wagon rides 11am-3pm, oxen team demonstrations at 11:30am, 12:30pm and 2pm.'
    END,
    notes = 'Demonstration schedule runs throughout: beekeeping 10am-4pm, heirloom apple tasting 10:30am-3pm, cider making 10:30am-2:30pm, horse-drawn wagon rides 11am-3pm, oxen team demonstrations at 11:30am, 12:30pm and 2pm.'
WHERE id = 'evd_ca0c06a2-c805-469f-a736-ad665b6be8ec_2026-09-19'
  AND notes = 'Hours confirmed on the organizer''s own event page. Demonstration schedule runs throughout: beekeeping 10am-4pm, heirloom apple tasting 10:30am-3pm, cider making 10:30am-2:30pm, horse-drawn wagon rides 11am-3pm, oxen team demonstrations at 11:30am, 12:30pm and 2pm.';

-- healthy-aging-expo-bangor-2026 2026-05-14 (c)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Public hours, single-day event'
      ELSE internal_notes || char(10) || 'Public hours, single-day event'
    END,
    notes = NULL
WHERE id = '51354ed0-ce4d-4127-a9ea-8bda3c246adc'
  AND notes = 'Public hours, single-day event';

-- heath-fair-2026 2026-08-21 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Date confirmed by organizer (heathfair.org home: "108th Annual Heath Fair August 21, 22, 23, 2026"), fetched 2026-08-20. HOURS NOT PUBLISHED FOR 2026 — organizer''s /fair-schedule/ page still serves the 2025 schedule (Aug 15-17, 2025); 2026 schedule is a Google Drive PDF only. Hours deliberately left NULL rather than carried over from 2025.'
      ELSE internal_notes || char(10) || 'Date confirmed by organizer (heathfair.org home: "108th Annual Heath Fair August 21, 22, 23, 2026"), fetched 2026-08-20. HOURS NOT PUBLISHED FOR 2026 — organizer''s /fair-schedule/ page still serves the 2025 schedule (Aug 15-17, 2025); 2026 schedule is a Google Drive PDF only. Hours deliberately left NULL rather than carried over from 2025.'
    END,
    notes = NULL
WHERE id = 'evd_8b3463b8-78f5-463f-aed8-5cae68d34d91_2026-08-21'
  AND notes = 'Date confirmed by organizer (heathfair.org home: "108th Annual Heath Fair August 21, 22, 23, 2026"), fetched 2026-08-20. HOURS NOT PUBLISHED FOR 2026 — organizer''s /fair-schedule/ page still serves the 2025 schedule (Aug 15-17, 2025); 2026 schedule is a Google Drive PDF only. Hours deliberately left NULL rather than carried over from 2025.';

-- heath-fair-2026 2026-08-22 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Date confirmed by organizer (heathfair.org home), fetched 2026-08-20. Hours not published for 2026 — see 08-21 note.'
      ELSE internal_notes || char(10) || 'Date confirmed by organizer (heathfair.org home), fetched 2026-08-20. Hours not published for 2026 — see 08-21 note.'
    END,
    notes = NULL
WHERE id = 'evd_8b3463b8-78f5-463f-aed8-5cae68d34d91_2026-08-22'
  AND notes = 'Date confirmed by organizer (heathfair.org home), fetched 2026-08-20. Hours not published for 2026 — see 08-21 note.';

-- heath-fair-2026 2026-08-23 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Date confirmed by organizer (heathfair.org home), fetched 2026-08-20. Hours not published for 2026 — see 08-21 note.'
      ELSE internal_notes || char(10) || 'Date confirmed by organizer (heathfair.org home), fetched 2026-08-20. Hours not published for 2026 — see 08-21 note.'
    END,
    notes = NULL
WHERE id = 'evd_8b3463b8-78f5-463f-aed8-5cae68d34d91_2026-08-23'
  AND notes = 'Date confirmed by organizer (heathfair.org home), fetched 2026-08-20. Hours not published for 2026 — see 08-21 note.';

-- leyden-winery-seafood-event-2026 2026-08-29 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Per organizer leydenfarm.com event page: "Leyden Winery Seafood Event! - Saturday, August 29, 2026 - 6:00 PM 9:00 PM - Leyden Farm Vineyard & Winery 160 Plain Meeting House Rd West Greenwich." Organizer''s own calendar link encodes 20260829T220000Z/20260830T010000Z, corroborating 6-9 PM ET. Advance tickets only: "Tickets must be purchased before the event!"'
      ELSE internal_notes || char(10) || 'Per organizer leydenfarm.com event page: "Leyden Winery Seafood Event! - Saturday, August 29, 2026 - 6:00 PM 9:00 PM - Leyden Farm Vineyard & Winery 160 Plain Meeting House Rd West Greenwich." Organizer''s own calendar link encodes 20260829T220000Z/20260830T010000Z, corroborating 6-9 PM ET. Advance tickets only: "Tickets must be purchased before the event!"'
    END,
    notes = 'Advance tickets only — tickets must be purchased before the event.'
WHERE id = 'evd_8d7a738e084e4d24c3043afaecceba5e_2026-08-29'
  AND notes = 'Per organizer leydenfarm.com event page: "Leyden Winery Seafood Event! - Saturday, August 29, 2026 - 6:00 PM 9:00 PM - Leyden Farm Vineyard & Winery 160 Plain Meeting House Rd West Greenwich." Organizer''s own calendar link encodes 20260829T220000Z/20260830T010000Z, corroborating 6-9 PM ET. Advance tickets only: "Tickets must be purchased before the event!"';

-- marshfield-fair-2026 2026-08-21 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency). Source: marshfieldfair.org General Information (organizer, page modified 2026-08-13), fetched 2026-08-20.'
      ELSE internal_notes || char(10) || 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency). Source: marshfieldfair.org General Information (organizer, page modified 2026-08-13), fetched 2026-08-20.'
    END,
    notes = 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency).'
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-21'
  AND notes = 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency). Source: marshfieldfair.org General Information (organizer, page modified 2026-08-13), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-22 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
      ELSE internal_notes || char(10) || 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
    END,
    notes = 'Gates noon–10pm every day.'
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-22'
  AND notes = 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-23 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates noon–10pm every day. Family Day — 25% off ride tickets on-site. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
      ELSE internal_notes || char(10) || 'Gates noon–10pm every day. Family Day — 25% off ride tickets on-site. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
    END,
    notes = 'Gates noon–10pm every day. Family Day — 25% off ride tickets on-site.'
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-23'
  AND notes = 'Gates noon–10pm every day. Family Day — 25% off ride tickets on-site. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-24 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
      ELSE internal_notes || char(10) || 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
    END,
    notes = 'Gates noon–10pm every day.'
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-24'
  AND notes = 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-25 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates noon–10pm every day. Senior Citizen Day — seniors 62+ free. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
      ELSE internal_notes || char(10) || 'Gates noon–10pm every day. Senior Citizen Day — seniors 62+ free. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
    END,
    notes = 'Gates noon–10pm every day. Senior Citizen Day — seniors 62+ free.'
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-25'
  AND notes = 'Gates noon–10pm every day. Senior Citizen Day — seniors 62+ free. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-26 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates noon–10pm every day. 4-H & Agricultural Awareness Day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
      ELSE internal_notes || char(10) || 'Gates noon–10pm every day. 4-H & Agricultural Awareness Day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
    END,
    notes = 'Gates noon–10pm every day. 4-H & Agricultural Awareness Day.'
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-26'
  AND notes = 'Gates noon–10pm every day. 4-H & Agricultural Awareness Day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-27 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates noon–10pm every day. Children''s Day — children 12 & under free; kiddie rides 50% off. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
      ELSE internal_notes || char(10) || 'Gates noon–10pm every day. Children''s Day — children 12 & under free; kiddie rides 50% off. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
    END,
    notes = 'Gates noon–10pm every day. Children''s Day — children 12 & under free; kiddie rides 50% off.'
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-27'
  AND notes = 'Gates noon–10pm every day. Children''s Day — children 12 & under free; kiddie rides 50% off. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-28 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency). Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
      ELSE internal_notes || char(10) || 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency). Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
    END,
    notes = 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency).'
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-28'
  AND notes = 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency). Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-29 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
      ELSE internal_notes || char(10) || 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
    END,
    notes = 'Gates noon–10pm every day.'
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-29'
  AND notes = 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-30 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates noon–10pm every day. Veteran''s Day — free admission for veterans/active duty with ID (organizer page renders this date as a typo, "August 3016"; Aug 30 is the fair''s final Sunday). Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
      ELSE internal_notes || char(10) || 'Gates noon–10pm every day. Veteran''s Day — free admission for veterans/active duty with ID (organizer page renders this date as a typo, "August 3016"; Aug 30 is the fair''s final Sunday). Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.'
    END,
    notes = 'Gates noon–10pm every day. Veteran''s Day — free admission for veterans/active duty with ID.'
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-30'
  AND notes = 'Gates noon–10pm every day. Veteran''s Day — free admission for veterans/active duty with ID (organizer page renders this date as a typo, "August 3016"; Aug 30 is the fair''s final Sunday). Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- nect-great-pumpkin-festival-2026 2026-10-17 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Saturday — single-day festival. Hours not yet confirmed for 2026: the organizer page still shows a stale "Saturday, October 19th, 10:00AM–3:00PM" that cannot be a 2026 date, so no hours have been carried over.'
      ELSE internal_notes || char(10) || 'Saturday — single-day festival. Hours not yet confirmed for 2026: the organizer page still shows a stale "Saturday, October 19th, 10:00AM–3:00PM" that cannot be a 2026 date, so no hours have been carried over.'
    END,
    notes = 'Saturday — single-day festival.'
WHERE id = 'evd_4e7210bf-e4aa-4b98-8dfc-eb4182942988_2026-10-17'
  AND notes = 'Saturday — single-day festival. Hours not yet confirmed for 2026: the organizer page still shows a stale "Saturday, October 19th, 10:00AM–3:00PM" that cannot be a 2026 date, so no hours have been carried over.';

-- newport-folk-festival-2026 2026-07-24 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates 10:00am; music from 11:00am; parking and shuttles 8:00am; box office 9:00am; beer and wine gardens 12:00pm. No published close time. No re-entry. Source: newportfolk.org/info'
      ELSE internal_notes || char(10) || 'Gates 10:00am; music from 11:00am; parking and shuttles 8:00am; box office 9:00am; beer and wine gardens 12:00pm. No published close time. No re-entry. Source: newportfolk.org/info'
    END,
    notes = 'Gates 10:00am; music from 11:00am; parking and shuttles 8:00am; box office 9:00am; beer and wine gardens 12:00pm. No published close time. No re-entry.'
WHERE id = 'evd_f668d8df-b317-4c71-aa11-c338fb7495d9_2026-07-24'
  AND notes = 'Gates 10:00am; music from 11:00am; parking and shuttles 8:00am; box office 9:00am; beer and wine gardens 12:00pm. No published close time. No re-entry. Source: newportfolk.org/info';

-- newport-folk-festival-2026 2026-07-25 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates 10:00am; music from 11:00am. No published close time. No re-entry. Source: newportfolk.org/info'
      ELSE internal_notes || char(10) || 'Gates 10:00am; music from 11:00am. No published close time. No re-entry. Source: newportfolk.org/info'
    END,
    notes = 'Gates 10:00am; music from 11:00am. No published close time. No re-entry.'
WHERE id = 'evd_f668d8df-b317-4c71-aa11-c338fb7495d9_2026-07-25'
  AND notes = 'Gates 10:00am; music from 11:00am. No published close time. No re-entry. Source: newportfolk.org/info';

-- newport-folk-festival-2026 2026-07-26 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Gates 10:00am; music from 11:00am. No published close time. No re-entry. Source: newportfolk.org/info'
      ELSE internal_notes || char(10) || 'Gates 10:00am; music from 11:00am. No published close time. No re-entry. Source: newportfolk.org/info'
    END,
    notes = 'Gates 10:00am; music from 11:00am. No published close time. No re-entry.'
WHERE id = 'evd_f668d8df-b317-4c71-aa11-c338fb7495d9_2026-07-26'
  AND notes = 'Gates 10:00am; music from 11:00am. No published close time. No re-entry. Source: newportfolk.org/info';

-- north-haven-holiday-welcome-craft-festival-2026 2026-11-15 (c)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Vendor setup from 7:30am.'
      ELSE internal_notes || char(10) || 'Vendor setup from 7:30am.'
    END,
    notes = NULL
WHERE id = 'evd_23df1ef6-5b06-4fa7-8eed-2668adc82e86_2026-11-15'
  AND notes = 'Vendor setup from 7:30am.';

-- people-plus-senior-health-expo 2026-10-08 (c)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Senior health expo — single day event'
      ELSE internal_notes || char(10) || 'Senior health expo — single day event'
    END,
    notes = NULL
WHERE id = 'b83d4b87-d32f-4b90-b98a-3a0e42d4b2fb'
  AND notes = 'Senior health expo — single day event';

-- puerto-rican-festival-woonsocket-2026 2026-08-29 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Per organizer All Things Tropical''s own Eventeny listing (eventeny.com/events/woonsocketprfest-24020/): Aug 29 2026, 12:00 PM - 5:00 PM. Corroborated by a named-source interview with owner Joely Ilarraza (Valley Breeze, updated 2026-08-22): "on Aug. 29 from noon to 5 p.m." NOTE: the two sources AGREE on time but DISAGREE on venue (Eventeny: River Island Park; Valley Breeze, newer: World War II Memorial Park) - venue left unchanged pending confirmation, discrepancy filed.'
      ELSE internal_notes || char(10) || 'Per organizer All Things Tropical''s own Eventeny listing (eventeny.com/events/woonsocketprfest-24020/): Aug 29 2026, 12:00 PM - 5:00 PM. Corroborated by a named-source interview with owner Joely Ilarraza (Valley Breeze, updated 2026-08-22): "on Aug. 29 from noon to 5 p.m." NOTE: the two sources AGREE on time but DISAGREE on venue (Eventeny: River Island Park; Valley Breeze, newer: World War II Memorial Park) - venue left unchanged pending confirmation, discrepancy filed.'
    END,
    notes = NULL
WHERE id = 'evd_00d540cf28dab33f26fd5bc774ad9326_2026-08-29'
  AND notes = 'Per organizer All Things Tropical''s own Eventeny listing (eventeny.com/events/woonsocketprfest-24020/): Aug 29 2026, 12:00 PM - 5:00 PM. Corroborated by a named-source interview with owner Joely Ilarraza (Valley Breeze, updated 2026-08-22): "on Aug. 29 from noon to 5 p.m." NOTE: the two sources AGREE on time but DISAGREE on venue (Eventeny: River Island Park; Valley Breeze, newer: World War II Memorial Park) - venue left unchanged pending confirmation, discrepancy filed.';

-- revolutionary-fair 2026-08-22 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Hours from the organizer''s event poster (rf.jpg): "Saturday August 22nd 4PM-6PM, Old Town House". Consistent with the Facebook listing''s "Duration: 2 hr".'
      ELSE internal_notes || char(10) || 'Hours from the organizer''s event poster (rf.jpg): "Saturday August 22nd 4PM-6PM, Old Town House". Consistent with the Facebook listing''s "Duration: 2 hr".'
    END,
    notes = NULL
WHERE id = 'evd_13f7f7a4-fae4-4272-b1b3-8262bf531195_2026-08-22'
  AND notes = 'Hours from the organizer''s event poster (rf.jpg): "Saturday August 22nd 4PM-6PM, Old Town House". Consistent with the Facebook listing''s "Duration: 2 hr".';

-- rhode-island-bridal-and-wedding-expo-fall-2026 2026-11-01 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Sunday, 1pm-5pm. Confirmed via bridalshowsri.com on 2026-05-10.'
      ELSE internal_notes || char(10) || 'Sunday, 1pm-5pm. Confirmed via bridalshowsri.com on 2026-05-10.'
    END,
    notes = 'Sunday, 1pm-5pm.'
WHERE id = '5c4b7173-8913-4a63-acb1-f6ddd1306937'
  AND notes = 'Sunday, 1pm-5pm. Confirmed via bridalshowsri.com on 2026-05-10.';

-- rutland-downtown-summer-farmers-market-2026-08-22 2026-08-22 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Saturday. Per vtfarmersmarket.org/markets/summer/: "OPEN EVERY SATURDAY 9am - 2pm", "Second Saturday in May to the Last Saturday in October", at Depot Park, Downtown Rutland. Organizer also notes the Saturday downtown market is run by two market groups, so this page is authoritative for the VFM half only.'
      ELSE internal_notes || char(10) || 'Saturday. Per vtfarmersmarket.org/markets/summer/: "OPEN EVERY SATURDAY 9am - 2pm", "Second Saturday in May to the Last Saturday in October", at Depot Park, Downtown Rutland. Organizer also notes the Saturday downtown market is run by two market groups, so this page is authoritative for the VFM half only.'
    END,
    notes = 'Saturday. Open every Saturday 9am - 2pm, second Saturday in May to the last Saturday in October, at Depot Park, Downtown Rutland.'
WHERE id = 'evd_a78aad52887f1942399dcd550aeb41b3_2026-08-22'
  AND notes = 'Saturday. Per vtfarmersmarket.org/markets/summer/: "OPEN EVERY SATURDAY 9am - 2pm", "Second Saturday in May to the Last Saturday in October", at Depot Park, Downtown Rutland. Organizer also notes the Saturday downtown market is run by two market groups, so this page is authoritative for the VFM half only.';

-- seymour-pumpkin-festival-2026 2026-09-20 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Sunday — single-day festival. Hours per organizer homepage.'
      ELSE internal_notes || char(10) || 'Sunday — single-day festival. Hours per organizer homepage.'
    END,
    notes = 'Sunday — single-day festival.'
WHERE id = 'evd_2ca81f07-275a-450f-9351-9e90dbd59326_2026-09-20'
  AND notes = 'Sunday — single-day festival. Hours per organizer homepage.';

-- shelton-autumn-craft-festival-2026 2026-11-07 (c)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Vendor setup from 7:30am.'
      ELSE internal_notes || char(10) || 'Vendor setup from 7:30am.'
    END,
    notes = NULL
WHERE id = 'evd_60754050-c1ec-4639-a8c2-5cd69389452f_2026-11-07'
  AND notes = 'Vendor setup from 7:30am.';

-- shelton-holiday-craft-festival-2026 2026-12-05 (c)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Vendor setup from 7:30am.'
      ELSE internal_notes || char(10) || 'Vendor setup from 7:30am.'
    END,
    notes = NULL
WHERE id = 'evd_3e4c17b8-6e33-47fb-9f56-ca0fcf031f59_2026-12-05'
  AND notes = 'Vendor setup from 7:30am.';

-- southbury-autumn-craft-festival-2026 2026-11-22 (c)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Vendor setup from 7:30am.'
      ELSE internal_notes || char(10) || 'Vendor setup from 7:30am.'
    END,
    notes = NULL
WHERE id = 'evd_7ac7d9fa-2ebb-4e38-ab80-8266b30b4ed1_2026-11-22'
  AND notes = 'Vendor setup from 7:30am.';

-- stafford-applefest-2026 2026-09-26 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN '11am - 4pm verified from Explore Stafford CT official page'
      ELSE internal_notes || char(10) || '11am - 4pm verified from Explore Stafford CT official page'
    END,
    notes = NULL
WHERE id = '98dc94f5-a9f8-406c-81fd-fc438b164d42'
  AND notes = '11am - 4pm verified from Explore Stafford CT official page';

-- summer-craft-fair-maine-coast-mall-2026 2026-08-01 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Day 1 (Saturday) — open to the public. Tentative hours 9:00 AM–5:00 PM per vendor contact John Cronin; NOT yet confirmed with the organizer. Hours field held blank until confirmed.'
      ELSE internal_notes || char(10) || 'Day 1 (Saturday) — open to the public. Tentative hours 9:00 AM–5:00 PM per vendor contact John Cronin; NOT yet confirmed with the organizer. Hours field held blank until confirmed.'
    END,
    notes = 'Day 1 (Saturday) — open to the public.'
WHERE id = 'evd_5bb7e537-851e-4182-9687-499074646ebe_2026-08-01'
  AND notes = 'Day 1 (Saturday) — open to the public. Tentative hours 9:00 AM–5:00 PM per vendor contact John Cronin; NOT yet confirmed with the organizer. Hours field held blank until confirmed.';

-- summer-craft-fair-maine-coast-mall-2026 2026-08-02 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Day 2 (Sunday) — open to the public. Tentative hours 9:00 AM–3:00 PM per vendor contact John Cronin; NOT yet confirmed with the organizer. Hours field held blank until confirmed.'
      ELSE internal_notes || char(10) || 'Day 2 (Sunday) — open to the public. Tentative hours 9:00 AM–3:00 PM per vendor contact John Cronin; NOT yet confirmed with the organizer. Hours field held blank until confirmed.'
    END,
    notes = 'Day 2 (Sunday) — open to the public.'
WHERE id = 'evd_5bb7e537-851e-4182-9687-499074646ebe_2026-08-02'
  AND notes = 'Day 2 (Sunday) — open to the public. Tentative hours 9:00 AM–3:00 PM per vendor contact John Cronin; NOT yet confirmed with the organizer. Hours field held blank until confirmed.';

-- vermont-cheesemakers-festival-2026 2026-09-20 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'General admission 11:30am–4:00pm. Industry/trade admission 10:00–11:30am. Hours confirmed via vtcheese.com / shelburnefarms.org.'
      ELSE internal_notes || char(10) || 'General admission 11:30am–4:00pm. Industry/trade admission 10:00–11:30am. Hours confirmed via vtcheese.com / shelburnefarms.org.'
    END,
    notes = 'General admission 11:30am–4:00pm. Industry/trade admission 10:00–11:30am.'
WHERE id = 'evd_46cf7e4e-4702-42f7-b25f-0d2fca309d54_2026-09-20'
  AND notes = 'General admission 11:30am–4:00pm. Industry/trade admission 10:00–11:30am. Hours confirmed via vtcheese.com / shelburnefarms.org.';

-- wethersfield-cornfest-2026 2026-09-12 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Saturday — single-day festival. Hours from Connecticut Public''s Aug 2026 roundup, not the organizer; verify before publishing widely.'
      ELSE internal_notes || char(10) || 'Saturday — single-day festival. Hours from Connecticut Public''s Aug 2026 roundup, not the organizer; verify before publishing widely.'
    END,
    notes = 'Saturday — single-day festival.'
WHERE id = 'evd_7c6218fe-f6cd-437d-b7e2-517347a7fc92_2026-09-12'
  AND notes = 'Saturday — single-day festival. Hours from Connecticut Public''s Aug 2026 roundup, not the organizer; verify before publishing widely.';

-- wokq-chowder-festival-2026 2026-06-06 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Festival runs from 11:30 AM until the chowder runs out (typically by 2 PM). Schema.org-confirmed times.'
      ELSE internal_notes || char(10) || 'Festival runs from 11:30 AM until the chowder runs out (typically by 2 PM). Schema.org-confirmed times.'
    END,
    notes = 'Festival runs from 11:30 AM until the chowder runs out (typically by 2 PM).'
WHERE id = '6ba58915-2643-4a18-8d6f-f4fb64d45034'
  AND notes = 'Festival runs from 11:30 AM until the chowder runs out (typically by 2 PM). Schema.org-confirmed times.';

-- yankee-peddler-day-2026-berlin 2026-05-30 (b)
UPDATE event_days
SET internal_notes = CASE
      WHEN internal_notes IS NULL OR internal_notes = '' THEN 'Rain or shine. Verified via Patch and Town of Berlin sources.'
      ELSE internal_notes || char(10) || 'Rain or shine. Verified via Patch and Town of Berlin sources.'
    END,
    notes = 'Rain or shine.'
WHERE id = '9a37a6d4-e241-4397-9b70-25a55f43fcbf'
  AND notes = 'Rain or shine. Verified via Patch and Town of Berlin sources.';
