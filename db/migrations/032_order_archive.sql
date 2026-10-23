-- ARCHIVE: a closed (or cancelled) group order that is truly finished can be tucked away by hand. Nothing is deleted or changed for anyone — it just moves out of the Closed list (and the day-to-day pickers)
-- into a folded "Archived" list. It can be un-archived at any time.
ALTER TABLE group_orders ADD COLUMN archived_at TIMESTAMP NULL, ADD KEY ix_go_archived (archived_at);
