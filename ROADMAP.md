# What's left to build, in the order I'd do it

The preview (`public/preview.html`) already does all of this with sample data; "porting" means
making each piece real: stored in MariaDB, safe when two people click at once, and tested the way
the money and sign-in code is. Each phase ends with tests against a real database.

## Decisions already made (and how they carry over)

**Fixed claims across several sets.** Two people fixed on Bang Chan each get their *own* Bang Chan slot,
so they land in different sets (Set 1 and Set 2). Fixed claimers on *other* members fill those same
early sets, so you never open more sets than the busiest member needs. A general joiner's claim skips
every reserved slot. If one fixed person gives up, only *their* set's slot reopens, and the next
claim (general or fixed) takes the earliest free slot. In the database, `set_slots` has
`UNIQUE(set_id, member_name)` so two people can't hold one slot even if they click at the same
instant, and placement runs in a transaction that locks the item first. (Tested in the preview;
the SQL version comes with phase 1.)

**Taking several of the same part.** In the shop, each part of a set has a −/+ stepper, so someone can take 3 washi
tapes and 1 diary in a single submit. A set holds one of each part, so repeats spread across sets: Diary + tape go in
Set 1, tape in Set 2, tape in Set 3 (new sets open automatically). The shop shows "where they'll go" before they commit.
"Keep together" works round by round: one of each part in one set, then the next one of each in the next. Placement is a
single pure function (`planSetPlacement` in the preview) used for both the preview line and the real placement; phase 1 ports
it as-is, with the item row locked while it runs. Submitting a basket also now stamps the person's handle on each slot — before
this, set parts submitted from the shop were never attributed to anyone.

**Sets with parts at different prices.** A set's "members" can be any parts: photocards, a Diary,
washi tape. A part's price is `item_members.price`, falling back to the item's price. Each
joiner's claim for a part carries *that part's* price, and the whole-set total is the sum. Already in
the schema and catalogue API; the claiming logic arrives with phase 1.

**"Every part must be claimed".** `items.requires_full_set`. Such a set can't be secured until every
slot is held, there is no 7/8 option, and there is nothing to split or raffle. The preview already enforces
this in both the button and the action behind it.

**Cancelled claims and blocked handles.** Cancelling returns what was paid as credit; a blocked handle's
payments are recorded as forfeited instead; deleting an account erases personal details but keeps the order
history and flags anyone who still owes money. Done (`lib/cancel.js`). Cancelling a set calls the same function once
per claim, so phase 1 gets this for free.

**Personalised Lomo name.** Recorded per parcel: the name they typed, otherwise their delivery name
(`parcels.lomo_name`, `lomo_source`). Done.

## Phases

1. **Member sets and fixed claims** (`item_sets`, `set_slots`, `fixed_claims`, `fixed_requests`).
   Preview: `addSetClaims`, `addFixedClaim`, `removeFixedClaim`, `performFixedChange`, the secure / split / raffle actions.
   Needs the locking rules above, and refunding paid money to credit when a set is cancelled.
2. **Inbound boxes** (`boxes`, `box_items`): EMS/customs split by weight, back-solving unweighed items,
   the box lifecycle with undo. `splitAmount` is already ported and tested; `resolveBoxWeights`, `addToCost`/`removeFromCost` are next.
3. **Direct assignment** for private/off-site GOs: single add plus bulk paste (`@handle, description, cost`).
4. **Proxy payments** (`proxy_payments`): candidates, per-item proxy and pay-by auto-fill, raffle tracking.
5. **Shop stock** (`leftover_items`): claims, "confirmed payment" moving items to ready-to-pack.
6. **Images**: upload endpoint (resize, store in a volume, `images` table); the compose file needs one more volume.
7. **Dashboards**: a **Block this handle** button and the flagged list (blocked, and deleted-account people who still owe), the Overdue tab (payments past their date, storage deadlines by size bucket, proxy payments) and the Claims tab grouping (GO → buyer, completed archived). These are mostly queries.
8. **Credit log extras**: convert unspent credit to tip; override balance. (Remove is done.)
9. **The screens**: point the preview's pages at this API instead of its in-memory arrays. This is the largest piece; do My Orders first (read-only), then payments, then shipping, then admin.
10. **Optional**: email notifications (shipped, payment verified, overdue reminders); auto-complete a parcel N days after shipping; importing existing orders from your spreadsheets.

## Defaults I'll use unless you say otherwise

1. **Basket holds:** none are needed — set parts are only taken at the moment of submitting, so an abandoned tab can't block anything.
2. **A fixed claimer leaving an all-parts set after it is secured** leaves a hole for you to fill by hand, exactly as
   with ordinary sets (blocking it would trap people in a claim they can't leave).
