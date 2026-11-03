-- ROLLBACK for drizzle/0366_ope1063_day_notes_provenance_to_internal_notes.sql.
-- NOT a migration — run by hand (Cloudflare MCP d1_database_query) only if the
-- forward move must be undone. Keyed on the exact post-state, so it touches a
-- row only if nobody has edited it since; a re-run changes 0 rows.
-- Expected: 76 rows changed.

-- america-250-brass-band-concert-june-29 2026-06-29
UPDATE event_days
SET notes = 'Concert at 7 PM per Exeter 250 calendar. Food trucks typically set up ahead of concert; window covers pre-show food service through cleanup.',
    internal_notes = NULL
WHERE id = '01f745fe-c6eb-4f3d-a8bd-bfefd6d710a6'
  AND notes = 'Concert at 7 PM. Food trucks typically set up ahead of the concert.'
  AND internal_notes = 'Concert at 7 PM per Exeter 250 calendar. Food trucks typically set up ahead of concert; window covers pre-show food service through cleanup.';

-- america-250-tune-and-fork-concert-july-7 2026-07-07
UPDATE event_days
SET notes = 'Concert at 5 PM per Exeter 250 calendar. Window covers pre-show food trucks through cleanup.',
    internal_notes = NULL
WHERE id = '4f378eb8-da5f-4eec-ad03-5f1711e6983b'
  AND notes = 'Concert at 5 PM.'
  AND internal_notes = 'Concert at 5 PM per Exeter 250 calendar. Window covers pre-show food trucks through cleanup.';

-- america-250-tune-and-fork-concert-june-30 2026-06-30
UPDATE event_days
SET notes = 'Concert at 5 PM per Exeter 250 calendar. Window covers pre-show food trucks through cleanup.',
    internal_notes = NULL
WHERE id = 'e0b6e6a9-97e6-4564-b676-116b3a6549eb'
  AND notes = 'Concert at 5 PM.'
  AND internal_notes = 'Concert at 5 PM per Exeter 250 calendar. Window covers pre-show food trucks through cleanup.';

-- american-independence-festival-2026 2026-07-11
UPDATE event_days
SET notes = 'Saturday, 10am-4pm. Per Exeter 250 commission calendar. Confirmed via exeternh.gov/250cc on 2026-05-11.',
    internal_notes = NULL
WHERE id = 'fd9d5d86-6534-4a98-b7f1-1ac84a3855fc'
  AND notes = 'Saturday, 10am-4pm.'
  AND internal_notes = 'Saturday, 10am-4pm. Per Exeter 250 commission calendar. Confirmed via exeternh.gov/250cc on 2026-05-11.';

-- applecrest-farm-blueberry-festival 2026-07-25
UPDATE event_days
SET notes = 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Reunion Hill). Source: applecrest.com/festivals-and-happenings/',
    internal_notes = NULL
WHERE id = 'evd_dc1e1240-c06f-43dd-94c1-c5d31cccb303_2026-07-25'
  AND notes = 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Reunion Hill).'
  AND internal_notes = 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Reunion Hill). Source: applecrest.com/festivals-and-happenings/';

-- applecrest-farm-blueberry-festival 2026-07-26
UPDATE event_days
SET notes = 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Cedar Mountain Bluegrass). Source: applecrest.com/festivals-and-happenings/',
    internal_notes = NULL
WHERE id = 'evd_dc1e1240-c06f-43dd-94c1-c5d31cccb303_2026-07-26'
  AND notes = 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Cedar Mountain Bluegrass).'
  AND internal_notes = 'Farm Market and Pick Your Own 8am-6pm; Creamery 12pm-9pm; live music 11am-3pm (Cedar Mountain Bluegrass). Source: applecrest.com/festivals-and-happenings/';

-- bangor-sunday-farmers-market-2026-08-23 2026-08-23
UPDATE event_days
SET notes = 'Sunday. Per bangorfarmersmarket.org: "Every Sunday May to November, 11:00 AM to 1:30 PM," summer location Abbot Square. Accepts cash, SNAP/EBT, cards and Bumper Crop gift certificates.',
    internal_notes = NULL
WHERE id = 'evd_b184ec471c18587cbb3eb61c3645ee31_2026-08-23'
  AND notes = 'Sunday. Every Sunday May to November, 11:00 AM to 1:30 PM; summer location Abbott Square. Accepts cash, SNAP/EBT, cards and Bumper Crop gift certificates.'
  AND internal_notes = 'Sunday. Per bangorfarmersmarket.org: "Every Sunday May to November, 11:00 AM to 1:30 PM," summer location Abbot Square. Accepts cash, SNAP/EBT, cards and Bumper Crop gift certificates.';

-- blueberry-festival-at-the-apple-barn 2026-07-25
UPDATE event_days
SET notes = '10:00am-5:00pm confirmed. Source: Bennington Banner 2026-07-15 (quotes organizer press release and owner Sarah Albright); theapplebarn.com is client-side rendered and returns an empty body to text fetches. Note an earlier secondary source said 4pm — the July 15 2026 piece says 5pm and was used.',
    internal_notes = NULL
WHERE id = 'evd_6967c83c-8357-4544-9b5d-2244ce3cb04c_2026-07-25'
  AND notes IS NULL
  AND internal_notes = '10:00am-5:00pm confirmed. Source: Bennington Banner 2026-07-15 (quotes organizer press release and owner Sarah Albright); theapplebarn.com is client-side rendered and returns an empty body to text fetches. Note an earlier secondary source said 4pm — the July 15 2026 piece says 5pm and was used.';

-- bondville-fair-winhall 2026-08-28
UPDATE event_days
SET notes = 'Friday. Organizer (bondvillefair.org): "Gates Open at 10:00AM Daily / Rides Open at 11:00AM Daily". Closing time NOT PUBLISHED — left null rather than estimated. Friday admission $10 before 5:00PM, $20 after 5:00PM, so the fair clearly runs into the evening.',
    internal_notes = NULL
WHERE id = 'evd_24a27819-e627-4f76-a150-df9669996738_2026-08-28'
  AND notes = 'Friday. Gates 10:00AM, rides 11:00AM. Admission $10 before 5:00PM, $20 after 5:00PM.'
  AND internal_notes = 'Friday. Organizer (bondvillefair.org): "Gates Open at 10:00AM Daily / Rides Open at 11:00AM Daily". Closing time NOT PUBLISHED — left null rather than estimated. Friday admission $10 before 5:00PM, $20 after 5:00PM, so the fair clearly runs into the evening.';

-- bondville-fair-winhall 2026-08-29
UPDATE event_days
SET notes = 'Saturday. Gates 10:00AM, rides 11:00AM. Admission $25 Saturday. Closing time NOT PUBLISHED.',
    internal_notes = NULL
WHERE id = 'evd_24a27819-e627-4f76-a150-df9669996738_2026-08-29'
  AND notes = 'Saturday. Gates 10:00AM, rides 11:00AM. Admission $25 Saturday.'
  AND internal_notes = 'Saturday. Gates 10:00AM, rides 11:00AM. Admission $25 Saturday. Closing time NOT PUBLISHED.';

-- bondville-fair-winhall 2026-08-30
UPDATE event_days
SET notes = 'Sunday. Gates 10:00AM, rides 11:00AM. Admission $20 Sunday. Closing time NOT PUBLISHED.',
    internal_notes = NULL
WHERE id = 'evd_24a27819-e627-4f76-a150-df9669996738_2026-08-30'
  AND notes = 'Sunday. Gates 10:00AM, rides 11:00AM. Admission $20 Sunday.'
  AND internal_notes = 'Sunday. Gates 10:00AM, rides 11:00AM. Admission $20 Sunday. Closing time NOT PUBLISHED.';

-- brattleboro-area-farmers-market-2026-08-22 2026-08-22
UPDATE event_days
SET notes = 'Saturday. Per brattleboroareafarmersmarket.com: "Join us every Saturday 9am-2pm", "from May to October", at 570 Western Ave (Route 9), Brattleboro VT 05301. Organizer states no season end date; the May 2 - Oct 31 window circulating elsewhere is from the Brattleboro Reformer, not the organizer.',
    internal_notes = NULL
WHERE id = 'evd_7f72d7eed1db0ad5d3444631d936d9d9_2026-08-22'
  AND notes = 'Saturday. Every Saturday 9am-2pm, May to October, at 570 Western Ave (Route 9), Brattleboro.'
  AND internal_notes = 'Saturday. Per brattleboroareafarmersmarket.com: "Join us every Saturday 9am-2pm", "from May to October", at 570 Western Ave (Route 9), Brattleboro VT 05301. Organizer states no season end date; the May 2 - Oct 31 window circulating elsewhere is from the Brattleboro Reformer, not the organizer.';

-- bruce-museum-45th-annual-outdoor-arts-festival-2026 2026-10-10
UPDATE event_days
SET notes = 'Saturday — open to the public. Hours per museum festivals page.',
    internal_notes = NULL
WHERE id = 'evd_a861a1ea-fc69-40c9-99bf-783fbaba7c78_2026-10-10'
  AND notes = 'Saturday — open to the public.'
  AND internal_notes = 'Saturday — open to the public. Hours per museum festivals page.';

-- bruce-museum-45th-annual-outdoor-arts-festival-2026 2026-10-11
UPDATE event_days
SET notes = 'Sunday — final day. Hours per museum festivals page.',
    internal_notes = NULL
WHERE id = 'evd_a861a1ea-fc69-40c9-99bf-783fbaba7c78_2026-10-11'
  AND notes = 'Sunday — final day.'
  AND internal_notes = 'Sunday — final day. Hours per museum festivals page.';

-- burlington-summer-farmers-market-2026-08-22 2026-08-22
UPDATE event_days
SET notes = 'Saturday. Per burlingtonfarmersmarket.org: "Summer 2026 — 9:00am-2:00pm | 345 Pine St | Every Saturday May 9 - October 31, 2026." Rain or shine.',
    internal_notes = NULL
WHERE id = 'evd_107ac9d3973ff9478c9a35cce96f32eb_2026-08-22'
  AND notes = 'Saturday. Every Saturday May 9 - October 31, 2026, 9:00am-2:00pm at 345 Pine St. Rain or shine.'
  AND internal_notes = 'Saturday. Per burlingtonfarmersmarket.org: "Summer 2026 — 9:00am-2:00pm | 345 Pine St | Every Saturday May 9 - October 31, 2026." Rain or shine.';

-- buzzed-lightbier-festival-2026 2026-08-29
UPDATE event_days
SET notes = 'Saturday. ORGANIZER''S OWN PAGE IS SELF-INCONSISTENT: valleybeer.io/concerts shows a "4:00 PM" listing header, but the body copy on the same page reads "Join us on August 29 starting at noon for a day of crispy beers and great company. Live music runs noon till 8 PM." Recorded the more specific body copy (noon-8 PM); the 4 PM header is the organizer''s discrepancy, not ours. Admission price NOT PUBLISHED on valleybeer.io — ticketing is off-site.',
    internal_notes = NULL
WHERE id = 'evd_8fc5c8fa6b337d01a55e8586bb164aa9_2026-08-29'
  AND notes = 'Saturday. Live music runs noon till 8 PM.'
  AND internal_notes = 'Saturday. ORGANIZER''S OWN PAGE IS SELF-INCONSISTENT: valleybeer.io/concerts shows a "4:00 PM" listing header, but the body copy on the same page reads "Join us on August 29 starting at noon for a day of crispy beers and great company. Live music runs noon till 8 PM." Recorded the more specific body copy (noon-8 PM); the 4 PM header is the organizer''s discrepancy, not ours. Admission price NOT PUBLISHED on valleybeer.io — ticketing is off-site.';

-- capital-city-farmers-market-2026-08-22 2026-08-22
UPDATE event_days
SET notes = 'Saturday. Per capitalcityfarmersmarket.com: summer season at 133 State Street, Montpelier — "Every Saturday, May-October, 9am-1pm."',
    internal_notes = NULL
WHERE id = 'evd_3aed37b5cc4f159ee19ff4dfccd1f807_2026-08-22'
  AND notes = 'Saturday. Summer season at 133 State Street, Montpelier — every Saturday, May-October, 9am-1pm.'
  AND internal_notes = 'Saturday. Per capitalcityfarmersmarket.com: summer season at 133 State Street, Montpelier — "Every Saturday, May-October, 9am-1pm."';

-- caravan-feisty-fall-market-2026 2026-10-11
UPDATE event_days
SET notes = 'Hours based on prior Caravan Bath markets (10am–4pm). Rain date: Oct 18.',
    internal_notes = NULL
WHERE id = '1ede1a81-51da-4da1-9647-1725c79e4185'
  AND notes = 'Rain date: Oct 18.'
  AND internal_notes = 'Hours based on prior Caravan Bath markets (10am–4pm). Rain date: Oct 18.';

-- caravan-holidaze-sale-2026 2026-12-12
UPDATE event_days
SET notes = 'Hours estimated; confirm closer to event.',
    internal_notes = NULL
WHERE id = 'f2e31100-d526-48b6-a6fa-c45c5a6a722b'
  AND notes IS NULL
  AND internal_notes = 'Hours estimated; confirm closer to event.';

-- caravan-holidaze-sale-2026 2026-12-13
UPDATE event_days
SET notes = 'Hours estimated; confirm closer to event.',
    internal_notes = NULL
WHERE id = 'ff9d59e4-4c1f-4601-8ea8-bc203b6c94e7'
  AND notes IS NULL
  AND internal_notes = 'Hours estimated; confirm closer to event.';

-- caravan-make-it-hot-market-at-allagash-brewing-2026 2026-07-19
UPDATE event_days
SET notes = 'Open to public. Hours based on prior Caravan-at-Allagash markets (11am–4pm); confirm closer to event.',
    internal_notes = NULL
WHERE id = 'db136c8c-2061-455c-80e1-e7d6ab8f1f7a'
  AND notes = 'Open to public.'
  AND internal_notes = 'Open to public. Hours based on prior Caravan-at-Allagash markets (11am–4pm); confirm closer to event.';

-- caravan-night-block-party-2026 2026-09-12
UPDATE event_days
SET notes = 'Evening block party; hours estimated — confirm closer to event.',
    internal_notes = NULL
WHERE id = '2b33899c-cb9c-4944-ab08-89d6be8e491a'
  AND notes = 'Evening block party.'
  AND internal_notes = 'Evening block party; hours estimated — confirm closer to event.';

-- connecticut-bridal-wedding-expo-middletown-june-2026 2026-06-07
UPDATE event_days
SET notes = 'Sunday, 11am-6pm. Confirmed via bridalshowsct-hc.com on 2026-05-10.',
    internal_notes = 'OPE-1088 2026-09-20: a conflicting duplicate (11:00-17:00, uncited) was removed; this row kept because it carries the only provenance ("Confirmed via bridalshowsct-hc.com on 2026-05-10"). RE-CONFIRMATION WAS NOT POSSIBLE: the organizer page has rolled over to the October 2026 show ("Sunday 11 am - 5 pm") and no Wayback snapshot exists for that domain. Past event; if the 17:00 close is ever shown correct, this row is the one to fix.'
WHERE id = '3dea4171-8d2a-4290-9bc4-0b6c18bb5273'
  AND notes = 'Sunday, 11am-6pm.'
  AND internal_notes = 'OPE-1088 2026-09-20: a conflicting duplicate (11:00-17:00, uncited) was removed; this row kept because it carries the only provenance ("Confirmed via bridalshowsct-hc.com on 2026-05-10"). RE-CONFIRMATION WAS NOT POSSIBLE: the organizer page has rolled over to the October 2026 show ("Sunday 11 am - 5 pm") and no Wayback snapshot exists for that domain. Past event; if the 17:00 close is ever shown correct, this row is the one to fix.' || char(10) || 'Sunday, 11am-6pm. Confirmed via bridalshowsct-hc.com on 2026-05-10.';

-- edward-little-high-school-craft-fair 2026-10-10
UPDATE event_days
SET notes = 'Hours not stated on the submitted flyer.',
    internal_notes = 'OPE-1259 pass 25, 2026-10-05. Organizer page https://www.phoenixnlkarate.org/ (read via fetch summarizer, quote as relayed): "October 10th: 1st Annual Fall Craft Fair Fundraiser at Edward Little High School to benefit PNLK. 10:00am-3:00pm".'
WHERE id = 'evd_568b7f76-88d9-48b9-9916-343574a1345d_2026-10-10'
  AND notes IS NULL
  AND internal_notes = 'OPE-1259 pass 25, 2026-10-05. Organizer page https://www.phoenixnlkarate.org/ (read via fetch summarizer, quote as relayed): "October 10th: 1st Annual Fall Craft Fair Fundraiser at Edward Little High School to benefit PNLK. 10:00am-3:00pm".' || char(10) || 'Hours not stated on the submitted flyer.';

-- exeter-community-picnic-and-concert-america-250 2026-07-09
UPDATE event_days
SET notes = 'Thursday evening, 6 PM start per Exeter 250 calendar. Approximate close.',
    internal_notes = NULL
WHERE id = '18040b0d-151d-4d76-bc81-49ff8c8322d3'
  AND notes = 'Thursday evening, 6 PM start.'
  AND internal_notes = 'Thursday evening, 6 PM start per Exeter 250 calendar. Approximate close.';

-- exeter-farmers-market-america-250-edition 2026-07-09
UPDATE event_days
SET notes = 'Thursday afternoon, 2:30 PM start per Exeter 250 calendar. Approximate close time.',
    internal_notes = NULL
WHERE id = 'd03dfe23-31c7-4421-b688-1d1ca278d770'
  AND notes = 'Thursday afternoon, 2:30 PM start.'
  AND internal_notes = 'Thursday afternoon, 2:30 PM start per Exeter 250 calendar. Approximate close time.';

-- exeter-fireworks-america-250 2026-07-11
UPDATE event_days
SET notes = 'Fireworks at 9 PM per Exeter 250 calendar. Food trucks typically set up earlier in the evening; window covers food service through dispersal after the show.',
    internal_notes = NULL
WHERE id = '8e0a7160-792f-40f2-b4b7-8672b9ce55b6'
  AND notes = 'Fireworks at 9 PM. Food trucks typically set up earlier in the evening.'
  AND internal_notes = 'Fireworks at 9 PM per Exeter 250 calendar. Food trucks typically set up earlier in the evening; window covers food service through dispersal after the show.';

-- farmington-fair 2026-09-20
UPDATE event_days
SET notes = 'Opening day. Midway / rides open 12:00–21:00. Starbird building opens 09:00. First scheduled event 09:00 (Youth Beef Show). Miss Farmington Fair Pageant 18:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".',
    internal_notes = NULL
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-20'
  AND notes = 'Opening day. Midway / rides open 12:00–21:00. Starbird building opens 09:00. First scheduled event 09:00 (Youth Beef Show). Miss Farmington Fair Pageant 18:30.'
  AND internal_notes = 'Opening day. Midway / rides open 12:00–21:00. Starbird building opens 09:00. First scheduled event 09:00 (Youth Beef Show). Miss Farmington Fair Pageant 18:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-21
UPDATE event_days
SET notes = 'Agriculture Education Day — Kids Ag Day 09:00–13:00 (Franklin County Soil & Water). Midway open 15:00–21:00; ride special 17:00–21:00 $27.00 (rain date Tue or Thu). Starbird building opens 12:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".',
    internal_notes = NULL
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-21'
  AND notes = 'Agriculture Education Day — Kids Ag Day 09:00–13:00 (Franklin County Soil & Water). Midway open 15:00–21:00; ride special 17:00–21:00 $27.00 (rain date Tue or Thu). Starbird building opens 12:00.'
  AND internal_notes = 'Agriculture Education Day — Kids Ag Day 09:00–13:00 (Franklin County Soil & Water). Midway open 15:00–21:00; ride special 17:00–21:00 $27.00 (rain date Tue or Thu). Starbird building opens 12:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-22
UPDATE event_days
SET notes = 'Senior Citizen (62+) & Veterans Day — $5.00 admission. Midway open 15:00–21:00. Starbird building opens 10:00. First scheduled event 10:00. NAWA Wrestling 19:00–21:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".',
    internal_notes = NULL
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-22'
  AND notes = 'Senior Citizen (62+) & Veterans Day — $5.00 admission. Midway open 15:00–21:00. Starbird building opens 10:00. First scheduled event 10:00. NAWA Wrestling 19:00–21:00.'
  AND internal_notes = 'Senior Citizen (62+) & Veterans Day — $5.00 admission. Midway open 15:00–21:00. Starbird building opens 10:00. First scheduled event 10:00. NAWA Wrestling 19:00–21:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-23
UPDATE event_days
SET notes = 'Ride Bracelet day. Midway open 13:00–21:00; ride special 13:00–21:00 $37.00. Starbird building opens 12:00. Monster Truck Jamboree 18:00. Youth Market Auction 18:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".',
    internal_notes = NULL
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-23'
  AND notes = 'Ride Bracelet day. Midway open 13:00–21:00; ride special 13:00–21:00 $37.00. Starbird building opens 12:00. Monster Truck Jamboree 18:00. Youth Market Auction 18:30.'
  AND internal_notes = 'Ride Bracelet day. Midway open 13:00–21:00; ride special 13:00–21:00 $37.00. Starbird building opens 12:00. Monster Truck Jamboree 18:00. Youth Market Auction 18:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-24
UPDATE event_days
SET notes = 'Senior Citizens (62+) & Veterans Day. Midway open 15:00–21:00. Starbird building opens 10:00. Monster Truck Show 19:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".',
    internal_notes = NULL
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-24'
  AND notes = 'Senior Citizens (62+) & Veterans Day. Midway open 15:00–21:00. Starbird building opens 10:00. Monster Truck Show 19:00.'
  AND internal_notes = 'Senior Citizens (62+) & Veterans Day. Midway open 15:00–21:00. Starbird building opens 10:00. Monster Truck Show 19:00. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-25
UPDATE event_days
SET notes = 'Midway open 15:00–22:00; ride special 17:00–22:00 $32.00. Starbird building opens 12:00. Truck & Tractor Pull 17:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".',
    internal_notes = NULL
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-25'
  AND notes = 'Midway open 15:00–22:00; ride special 17:00–22:00 $32.00. Starbird building opens 12:00. Truck & Tractor Pull 17:30.'
  AND internal_notes = 'Midway open 15:00–22:00; ride special 17:00–22:00 $32.00. Starbird building opens 12:00. Truck & Tractor Pull 17:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- farmington-fair 2026-09-26
UPDATE event_days
SET notes = 'CLOSING DAY — the organizer''s program ends here; there is no September 27 in the 2026 schedule. Midway open 10:00–22:00. Starbird building opens 09:00. Antique Tractor Pull 10:00 (may run to ~15:00). Demolition Derby 18:30. Last listed item 19:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".',
    internal_notes = NULL
WHERE id = 'evd_451e08a3-91cd-43f7-b52e-6dc116aaa416_2026-09-26'
  AND notes = 'Closing day. Midway open 10:00–22:00. Starbird building opens 09:00. Antique Tractor Pull 10:00 (may run to ~15:00). Demolition Derby 18:30.'
  AND internal_notes = 'CLOSING DAY — the organizer''s program ends here; there is no September 27 in the 2026 schedule. Midway open 10:00–22:00. Starbird building opens 09:00. Antique Tractor Pull 10:00 (may run to ~15:00). Demolition Derby 18:30. Last listed item 19:30. GATE HOURS NOT PUBLISHED by the organizer — open/close deliberately left null rather than inferred from the midway window. Source: organizer''s 2026 "Fair Schedule of Events".';

-- gahs-interact-club-spring-craft-fair-2026 2026-05-16
UPDATE event_days
SET notes = 'Public hours, single-day event',
    internal_notes = NULL
WHERE id = '69b07e26-9e43-4319-964d-8cecf103c091'
  AND notes IS NULL
  AND internal_notes = 'Public hours, single-day event';

-- gahs-interact-club-spring-craft-fair-2026 2026-05-16
UPDATE event_days
SET notes = 'Vendor setup window. Interact Club members assist with unloading. Per vendor recruitment email from advisor Raye Anne DeSoto on 2026-05-11.',
    internal_notes = NULL
WHERE id = '48a4c03d-abdd-4045-9465-b64bc0bb7e93'
  AND notes = 'Vendor setup window. Interact Club members assist with unloading.'
  AND internal_notes = 'Vendor setup window. Interact Club members assist with unloading. Per vendor recruitment email from advisor Raye Anne DeSoto on 2026-05-11.';

-- general-stanton-inn-blues-music-festival-2026 2026-08-23
UPDATE event_days
SET notes = 'Sunday, outdoor tent. Per the Inn''s own Eventbrite listing (event:start_time 2026-08-23T14:00-04:00, end 19:00-04:00). Lineup: Duke Robillard & His All Star Band, Neal Vitullo Band, Pat Halpin and the 351''s.',
    internal_notes = NULL
WHERE id = 'evd_33b42d19154fa6367f00784a964e1d04_2026-08-23'
  AND notes = 'Sunday, outdoor tent. Lineup: Duke Robillard & His All Star Band, Neal Vitullo Band, Pat Halpin and the 351''s.'
  AND internal_notes = 'Sunday, outdoor tent. Per the Inn''s own Eventbrite listing (event:start_time 2026-08-23T14:00-04:00, end 19:00-04:00). Lineup: Duke Robillard & His All Star Band, Neal Vitullo Band, Pat Halpin and the 351''s.';

-- hampden-county-4-h-fair-2026 2026-07-25
UPDATE event_days
SET notes = 'Single-day fair, 9am-5pm at the Mallary Complex. Source: easternstatesexposition.com/events/2026/hamden-county-4-h-fair (host venue; the fair''s own site is dead).',
    internal_notes = NULL
WHERE id = 'evd_d4cc6a33-f6c0-43a1-b563-ca92873fded0_2026-07-25'
  AND notes = 'Single-day fair, 9am-5pm at the Mallary Complex.'
  AND internal_notes = 'Single-day fair, 9am-5pm at the Mallary Complex. Source: easternstatesexposition.com/events/2026/hamden-county-4-h-fair (host venue; the fair''s own site is dead).';

-- harrys-comic-and-toy-show-franklin-august-2026 2026-08-23
UPDATE event_days
SET notes = 'Sunday. Per mymummy.com (organizer, My Mummy Productions): "Hours 10-3pm", "Admission $5.00", August 23 2026 listed among 2026 show dates. Children under 16 free with a paid adult.',
    internal_notes = NULL
WHERE id = 'evd_f1bb012d-e003-4464-828e-ade83bc615f7_2026-08-23'
  AND notes = 'Sunday. Admission $5.00; children under 16 free with a paid adult.'
  AND internal_notes = 'Sunday. Per mymummy.com (organizer, My Mummy Productions): "Hours 10-3pm", "Admission $5.00", August 23 2026 listed among 2026 show dates. Children under 16 free with a paid adult.';

-- harvest-festival-coggeshall-farm-2026 2026-09-19
UPDATE event_days
SET notes = 'Hours confirmed on the organizer''s own event page. Demonstration schedule runs throughout: beekeeping 10am-4pm, heirloom apple tasting 10:30am-3pm, cider making 10:30am-2:30pm, horse-drawn wagon rides 11am-3pm, oxen team demonstrations at 11:30am, 12:30pm and 2pm.',
    internal_notes = NULL
WHERE id = 'evd_ca0c06a2-c805-469f-a736-ad665b6be8ec_2026-09-19'
  AND notes = 'Demonstration schedule runs throughout: beekeeping 10am-4pm, heirloom apple tasting 10:30am-3pm, cider making 10:30am-2:30pm, horse-drawn wagon rides 11am-3pm, oxen team demonstrations at 11:30am, 12:30pm and 2pm.'
  AND internal_notes = 'Hours confirmed on the organizer''s own event page. Demonstration schedule runs throughout: beekeeping 10am-4pm, heirloom apple tasting 10:30am-3pm, cider making 10:30am-2:30pm, horse-drawn wagon rides 11am-3pm, oxen team demonstrations at 11:30am, 12:30pm and 2pm.';

-- healthy-aging-expo-bangor-2026 2026-05-14
UPDATE event_days
SET notes = 'Public hours, single-day event',
    internal_notes = NULL
WHERE id = '51354ed0-ce4d-4127-a9ea-8bda3c246adc'
  AND notes IS NULL
  AND internal_notes = 'Public hours, single-day event';

-- heath-fair-2026 2026-08-21
UPDATE event_days
SET notes = 'Date confirmed by organizer (heathfair.org home: "108th Annual Heath Fair August 21, 22, 23, 2026"), fetched 2026-08-20. HOURS NOT PUBLISHED FOR 2026 — organizer''s /fair-schedule/ page still serves the 2025 schedule (Aug 15-17, 2025); 2026 schedule is a Google Drive PDF only. Hours deliberately left NULL rather than carried over from 2025.',
    internal_notes = NULL
WHERE id = 'evd_8b3463b8-78f5-463f-aed8-5cae68d34d91_2026-08-21'
  AND notes IS NULL
  AND internal_notes = 'Date confirmed by organizer (heathfair.org home: "108th Annual Heath Fair August 21, 22, 23, 2026"), fetched 2026-08-20. HOURS NOT PUBLISHED FOR 2026 — organizer''s /fair-schedule/ page still serves the 2025 schedule (Aug 15-17, 2025); 2026 schedule is a Google Drive PDF only. Hours deliberately left NULL rather than carried over from 2025.';

-- heath-fair-2026 2026-08-22
UPDATE event_days
SET notes = 'Date confirmed by organizer (heathfair.org home), fetched 2026-08-20. Hours not published for 2026 — see 08-21 note.',
    internal_notes = NULL
WHERE id = 'evd_8b3463b8-78f5-463f-aed8-5cae68d34d91_2026-08-22'
  AND notes IS NULL
  AND internal_notes = 'Date confirmed by organizer (heathfair.org home), fetched 2026-08-20. Hours not published for 2026 — see 08-21 note.';

-- heath-fair-2026 2026-08-23
UPDATE event_days
SET notes = 'Date confirmed by organizer (heathfair.org home), fetched 2026-08-20. Hours not published for 2026 — see 08-21 note.',
    internal_notes = NULL
WHERE id = 'evd_8b3463b8-78f5-463f-aed8-5cae68d34d91_2026-08-23'
  AND notes IS NULL
  AND internal_notes = 'Date confirmed by organizer (heathfair.org home), fetched 2026-08-20. Hours not published for 2026 — see 08-21 note.';

-- leyden-winery-seafood-event-2026 2026-08-29
UPDATE event_days
SET notes = 'Per organizer leydenfarm.com event page: "Leyden Winery Seafood Event! - Saturday, August 29, 2026 - 6:00 PM 9:00 PM - Leyden Farm Vineyard & Winery 160 Plain Meeting House Rd West Greenwich." Organizer''s own calendar link encodes 20260829T220000Z/20260830T010000Z, corroborating 6-9 PM ET. Advance tickets only: "Tickets must be purchased before the event!"',
    internal_notes = NULL
WHERE id = 'evd_8d7a738e084e4d24c3043afaecceba5e_2026-08-29'
  AND notes = 'Advance tickets only — tickets must be purchased before the event.'
  AND internal_notes = 'Per organizer leydenfarm.com event page: "Leyden Winery Seafood Event! - Saturday, August 29, 2026 - 6:00 PM 9:00 PM - Leyden Farm Vineyard & Winery 160 Plain Meeting House Rd West Greenwich." Organizer''s own calendar link encodes 20260829T220000Z/20260830T010000Z, corroborating 6-9 PM ET. Advance tickets only: "Tickets must be purchased before the event!"';

-- marshfield-fair-2026 2026-08-21
UPDATE event_days
SET notes = 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency). Source: marshfieldfair.org General Information (organizer, page modified 2026-08-13), fetched 2026-08-20.',
    internal_notes = NULL
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-21'
  AND notes = 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency).'
  AND internal_notes = 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency). Source: marshfieldfair.org General Information (organizer, page modified 2026-08-13), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-22
UPDATE event_days
SET notes = 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.',
    internal_notes = NULL
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-22'
  AND notes = 'Gates noon–10pm every day.'
  AND internal_notes = 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-23
UPDATE event_days
SET notes = 'Gates noon–10pm every day. Family Day — 25% off ride tickets on-site. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.',
    internal_notes = NULL
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-23'
  AND notes = 'Gates noon–10pm every day. Family Day — 25% off ride tickets on-site.'
  AND internal_notes = 'Gates noon–10pm every day. Family Day — 25% off ride tickets on-site. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-24
UPDATE event_days
SET notes = 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.',
    internal_notes = NULL
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-24'
  AND notes = 'Gates noon–10pm every day.'
  AND internal_notes = 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-25
UPDATE event_days
SET notes = 'Gates noon–10pm every day. Senior Citizen Day — seniors 62+ free. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.',
    internal_notes = NULL
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-25'
  AND notes = 'Gates noon–10pm every day. Senior Citizen Day — seniors 62+ free.'
  AND internal_notes = 'Gates noon–10pm every day. Senior Citizen Day — seniors 62+ free. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-26
UPDATE event_days
SET notes = 'Gates noon–10pm every day. 4-H & Agricultural Awareness Day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.',
    internal_notes = NULL
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-26'
  AND notes = 'Gates noon–10pm every day. 4-H & Agricultural Awareness Day.'
  AND internal_notes = 'Gates noon–10pm every day. 4-H & Agricultural Awareness Day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-27
UPDATE event_days
SET notes = 'Gates noon–10pm every day. Children''s Day — children 12 & under free; kiddie rides 50% off. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.',
    internal_notes = NULL
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-27'
  AND notes = 'Gates noon–10pm every day. Children''s Day — children 12 & under free; kiddie rides 50% off.'
  AND internal_notes = 'Gates noon–10pm every day. Children''s Day — children 12 & under free; kiddie rides 50% off. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-28
UPDATE event_days
SET notes = 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency). Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.',
    internal_notes = NULL
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-28'
  AND notes = 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency).'
  AND internal_notes = 'Gates noon–10pm every day. Marshfield Resident''s Day (noon–6, $8 w/ proof of residency). Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-29
UPDATE event_days
SET notes = 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.',
    internal_notes = NULL
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-29'
  AND notes = 'Gates noon–10pm every day.'
  AND internal_notes = 'Gates noon–10pm every day. Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- marshfield-fair-2026 2026-08-30
UPDATE event_days
SET notes = 'Gates noon–10pm every day. Veteran''s Day — free admission for veterans/active duty with ID (organizer page renders this date as a typo, "August 3016"; Aug 30 is the fair''s final Sunday). Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.',
    internal_notes = NULL
WHERE id = 'evd_e4c60af5-68ff-4f31-9d37-4bd62b55c51e_2026-08-30'
  AND notes = 'Gates noon–10pm every day. Veteran''s Day — free admission for veterans/active duty with ID.'
  AND internal_notes = 'Gates noon–10pm every day. Veteran''s Day — free admission for veterans/active duty with ID (organizer page renders this date as a typo, "August 3016"; Aug 30 is the fair''s final Sunday). Source: marshfieldfair.org General Information (organizer), fetched 2026-08-20.';

-- nect-great-pumpkin-festival-2026 2026-10-17
UPDATE event_days
SET notes = 'Saturday — single-day festival. Hours not yet confirmed for 2026: the organizer page still shows a stale "Saturday, October 19th, 10:00AM–3:00PM" that cannot be a 2026 date, so no hours have been carried over.',
    internal_notes = 'Looked 2026-10-14 ~04:20Z (analyst-claude-desktop, OPE-1259 pass 103): putnamct.us /visit-us/concerts-and-events and /departments/parks-and-recreation give "Great Pumpkin Fest ~ October 17th, 2026" with no hours. discoverputnam.com/great-pumpkin-festival is a stale page ("Saturday, October 23 10:00AM - 3:00PM" = a prior edition); ctexaminer listing is 2025 (Oct 19, 10-3). putnam.recdesk.com is JS-only. No 2026 hours published; prior editions ran 10-3 — re-check closer to the day.'
WHERE id = 'evd_4e7210bf-e4aa-4b98-8dfc-eb4182942988_2026-10-17'
  AND notes = 'Saturday — single-day festival.'
  AND internal_notes = 'Looked 2026-10-14 ~04:20Z (analyst-claude-desktop, OPE-1259 pass 103): putnamct.us /visit-us/concerts-and-events and /departments/parks-and-recreation give "Great Pumpkin Fest ~ October 17th, 2026" with no hours. discoverputnam.com/great-pumpkin-festival is a stale page ("Saturday, October 23 10:00AM - 3:00PM" = a prior edition); ctexaminer listing is 2025 (Oct 19, 10-3). putnam.recdesk.com is JS-only. No 2026 hours published; prior editions ran 10-3 — re-check closer to the day.' || char(10) || 'Saturday — single-day festival. Hours not yet confirmed for 2026: the organizer page still shows a stale "Saturday, October 19th, 10:00AM–3:00PM" that cannot be a 2026 date, so no hours have been carried over.';

-- newport-folk-festival-2026 2026-07-24
UPDATE event_days
SET notes = 'Gates 10:00am; music from 11:00am; parking and shuttles 8:00am; box office 9:00am; beer and wine gardens 12:00pm. No published close time. No re-entry. Source: newportfolk.org/info',
    internal_notes = NULL
WHERE id = 'evd_f668d8df-b317-4c71-aa11-c338fb7495d9_2026-07-24'
  AND notes = 'Gates 10:00am; music from 11:00am; parking and shuttles 8:00am; box office 9:00am; beer and wine gardens 12:00pm. No published close time. No re-entry.'
  AND internal_notes = 'Gates 10:00am; music from 11:00am; parking and shuttles 8:00am; box office 9:00am; beer and wine gardens 12:00pm. No published close time. No re-entry. Source: newportfolk.org/info';

-- newport-folk-festival-2026 2026-07-25
UPDATE event_days
SET notes = 'Gates 10:00am; music from 11:00am. No published close time. No re-entry. Source: newportfolk.org/info',
    internal_notes = NULL
WHERE id = 'evd_f668d8df-b317-4c71-aa11-c338fb7495d9_2026-07-25'
  AND notes = 'Gates 10:00am; music from 11:00am. No published close time. No re-entry.'
  AND internal_notes = 'Gates 10:00am; music from 11:00am. No published close time. No re-entry. Source: newportfolk.org/info';

-- newport-folk-festival-2026 2026-07-26
UPDATE event_days
SET notes = 'Gates 10:00am; music from 11:00am. No published close time. No re-entry. Source: newportfolk.org/info',
    internal_notes = NULL
WHERE id = 'evd_f668d8df-b317-4c71-aa11-c338fb7495d9_2026-07-26'
  AND notes = 'Gates 10:00am; music from 11:00am. No published close time. No re-entry.'
  AND internal_notes = 'Gates 10:00am; music from 11:00am. No published close time. No re-entry. Source: newportfolk.org/info';

-- north-haven-holiday-welcome-craft-festival-2026 2026-11-15
UPDATE event_days
SET notes = 'Vendor setup from 7:30am.',
    internal_notes = NULL
WHERE id = 'evd_23df1ef6-5b06-4fa7-8eed-2668adc82e86_2026-11-15'
  AND notes IS NULL
  AND internal_notes = 'Vendor setup from 7:30am.';

-- people-plus-senior-health-expo 2026-10-08
UPDATE event_days
SET notes = 'Senior health expo — single day event',
    internal_notes = 'Hours 9am–1pm per https://peopleplusmaine.org/events/senior-health-expo/ and Expo Guide 2026 PDF cover, read 2026-10-01 (OPE-1259). Was 09:00–14:00.'
WHERE id = 'b83d4b87-d32f-4b90-b98a-3a0e42d4b2fb'
  AND notes IS NULL
  AND internal_notes = 'Hours 9am–1pm per https://peopleplusmaine.org/events/senior-health-expo/ and Expo Guide 2026 PDF cover, read 2026-10-01 (OPE-1259). Was 09:00–14:00.' || char(10) || 'Senior health expo — single day event';

-- puerto-rican-festival-woonsocket-2026 2026-08-29
UPDATE event_days
SET notes = 'Per organizer All Things Tropical''s own Eventeny listing (eventeny.com/events/woonsocketprfest-24020/): Aug 29 2026, 12:00 PM - 5:00 PM. Corroborated by a named-source interview with owner Joely Ilarraza (Valley Breeze, updated 2026-08-22): "on Aug. 29 from noon to 5 p.m." NOTE: the two sources AGREE on time but DISAGREE on venue (Eventeny: River Island Park; Valley Breeze, newer: World War II Memorial Park) - venue left unchanged pending confirmation, discrepancy filed.',
    internal_notes = NULL
WHERE id = 'evd_00d540cf28dab33f26fd5bc774ad9326_2026-08-29'
  AND notes IS NULL
  AND internal_notes = 'Per organizer All Things Tropical''s own Eventeny listing (eventeny.com/events/woonsocketprfest-24020/): Aug 29 2026, 12:00 PM - 5:00 PM. Corroborated by a named-source interview with owner Joely Ilarraza (Valley Breeze, updated 2026-08-22): "on Aug. 29 from noon to 5 p.m." NOTE: the two sources AGREE on time but DISAGREE on venue (Eventeny: River Island Park; Valley Breeze, newer: World War II Memorial Park) - venue left unchanged pending confirmation, discrepancy filed.';

-- revolutionary-fair 2026-08-22
UPDATE event_days
SET notes = 'Hours from the organizer''s event poster (rf.jpg): "Saturday August 22nd 4PM-6PM, Old Town House". Consistent with the Facebook listing''s "Duration: 2 hr".',
    internal_notes = NULL
WHERE id = 'evd_13f7f7a4-fae4-4272-b1b3-8262bf531195_2026-08-22'
  AND notes IS NULL
  AND internal_notes = 'Hours from the organizer''s event poster (rf.jpg): "Saturday August 22nd 4PM-6PM, Old Town House". Consistent with the Facebook listing''s "Duration: 2 hr".';

-- rhode-island-bridal-and-wedding-expo-fall-2026 2026-11-01
UPDATE event_days
SET notes = 'Sunday, 1pm-5pm. Confirmed via bridalshowsri.com on 2026-05-10.',
    internal_notes = NULL
WHERE id = '5c4b7173-8913-4a63-acb1-f6ddd1306937'
  AND notes = 'Sunday, 1pm-5pm.'
  AND internal_notes = 'Sunday, 1pm-5pm. Confirmed via bridalshowsri.com on 2026-05-10.';

-- rutland-downtown-summer-farmers-market-2026-08-22 2026-08-22
UPDATE event_days
SET notes = 'Saturday. Per vtfarmersmarket.org/markets/summer/: "OPEN EVERY SATURDAY 9am - 2pm", "Second Saturday in May to the Last Saturday in October", at Depot Park, Downtown Rutland. Organizer also notes the Saturday downtown market is run by two market groups, so this page is authoritative for the VFM half only.',
    internal_notes = NULL
WHERE id = 'evd_a78aad52887f1942399dcd550aeb41b3_2026-08-22'
  AND notes = 'Saturday. Open every Saturday 9am - 2pm, second Saturday in May to the last Saturday in October, at Depot Park, Downtown Rutland.'
  AND internal_notes = 'Saturday. Per vtfarmersmarket.org/markets/summer/: "OPEN EVERY SATURDAY 9am - 2pm", "Second Saturday in May to the Last Saturday in October", at Depot Park, Downtown Rutland. Organizer also notes the Saturday downtown market is run by two market groups, so this page is authoritative for the VFM half only.';

-- seymour-pumpkin-festival-2026 2026-09-20
UPDATE event_days
SET notes = 'Sunday — single-day festival. Hours per organizer homepage.',
    internal_notes = NULL
WHERE id = 'evd_2ca81f07-275a-450f-9351-9e90dbd59326_2026-09-20'
  AND notes = 'Sunday — single-day festival.'
  AND internal_notes = 'Sunday — single-day festival. Hours per organizer homepage.';

-- shelton-autumn-craft-festival-2026 2026-11-07
UPDATE event_days
SET notes = 'Vendor setup from 7:30am.',
    internal_notes = NULL
WHERE id = 'evd_60754050-c1ec-4639-a8c2-5cd69389452f_2026-11-07'
  AND notes IS NULL
  AND internal_notes = 'Vendor setup from 7:30am.';

-- shelton-holiday-craft-festival-2026 2026-12-05
UPDATE event_days
SET notes = 'Vendor setup from 7:30am.',
    internal_notes = NULL
WHERE id = 'evd_3e4c17b8-6e33-47fb-9f56-ca0fcf031f59_2026-12-05'
  AND notes IS NULL
  AND internal_notes = 'Vendor setup from 7:30am.';

-- southbury-autumn-craft-festival-2026 2026-11-22
UPDATE event_days
SET notes = 'Vendor setup from 7:30am.',
    internal_notes = NULL
WHERE id = 'evd_7ac7d9fa-2ebb-4e38-ab80-8266b30b4ed1_2026-11-22'
  AND notes IS NULL
  AND internal_notes = 'Vendor setup from 7:30am.';

-- stafford-applefest-2026 2026-09-26
UPDATE event_days
SET notes = '11am - 4pm verified from Explore Stafford CT official page',
    internal_notes = NULL
WHERE id = '98dc94f5-a9f8-406c-81fd-fc438b164d42'
  AND notes IS NULL
  AND internal_notes = '11am - 4pm verified from Explore Stafford CT official page';

-- summer-craft-fair-maine-coast-mall-2026 2026-08-01
UPDATE event_days
SET notes = 'Day 1 (Saturday) — open to the public. Tentative hours 9:00 AM–5:00 PM per vendor contact John Cronin; NOT yet confirmed with the organizer. Hours field held blank until confirmed.',
    internal_notes = NULL
WHERE id = 'evd_5bb7e537-851e-4182-9687-499074646ebe_2026-08-01'
  AND notes = 'Day 1 (Saturday) — open to the public.'
  AND internal_notes = 'Day 1 (Saturday) — open to the public. Tentative hours 9:00 AM–5:00 PM per vendor contact John Cronin; NOT yet confirmed with the organizer. Hours field held blank until confirmed.';

-- summer-craft-fair-maine-coast-mall-2026 2026-08-02
UPDATE event_days
SET notes = 'Day 2 (Sunday) — open to the public. Tentative hours 9:00 AM–3:00 PM per vendor contact John Cronin; NOT yet confirmed with the organizer. Hours field held blank until confirmed.',
    internal_notes = NULL
WHERE id = 'evd_5bb7e537-851e-4182-9687-499074646ebe_2026-08-02'
  AND notes = 'Day 2 (Sunday) — open to the public.'
  AND internal_notes = 'Day 2 (Sunday) — open to the public. Tentative hours 9:00 AM–3:00 PM per vendor contact John Cronin; NOT yet confirmed with the organizer. Hours field held blank until confirmed.';

-- vermont-cheesemakers-festival-2026 2026-09-20
UPDATE event_days
SET notes = 'General admission 11:30am–4:00pm. Industry/trade admission 10:00–11:30am. Hours confirmed via vtcheese.com / shelburnefarms.org.',
    internal_notes = NULL
WHERE id = 'evd_46cf7e4e-4702-42f7-b25f-0d2fca309d54_2026-09-20'
  AND notes = 'General admission 11:30am–4:00pm. Industry/trade admission 10:00–11:30am.'
  AND internal_notes = 'General admission 11:30am–4:00pm. Industry/trade admission 10:00–11:30am. Hours confirmed via vtcheese.com / shelburnefarms.org.';

-- wethersfield-cornfest-2026 2026-09-12
UPDATE event_days
SET notes = 'Saturday — single-day festival. Hours from Connecticut Public''s Aug 2026 roundup, not the organizer; verify before publishing widely.',
    internal_notes = NULL
WHERE id = 'evd_7c6218fe-f6cd-437d-b7e2-517347a7fc92_2026-09-12'
  AND notes = 'Saturday — single-day festival.'
  AND internal_notes = 'Saturday — single-day festival. Hours from Connecticut Public''s Aug 2026 roundup, not the organizer; verify before publishing widely.';

-- wokq-chowder-festival-2026 2026-06-06
UPDATE event_days
SET notes = 'Festival runs from 11:30 AM until the chowder runs out (typically by 2 PM). Schema.org-confirmed times.',
    internal_notes = NULL
WHERE id = '6ba58915-2643-4a18-8d6f-f4fb64d45034'
  AND notes = 'Festival runs from 11:30 AM until the chowder runs out (typically by 2 PM).'
  AND internal_notes = 'Festival runs from 11:30 AM until the chowder runs out (typically by 2 PM). Schema.org-confirmed times.';

-- yankee-peddler-day-2026-berlin 2026-05-30
UPDATE event_days
SET notes = 'Rain or shine. Verified via Patch and Town of Berlin sources.',
    internal_notes = NULL
WHERE id = '9a37a6d4-e241-4397-9b70-25a55f43fcbf'
  AND notes = 'Rain or shine.'
  AND internal_notes = 'Rain or shine. Verified via Patch and Town of Berlin sources.';
