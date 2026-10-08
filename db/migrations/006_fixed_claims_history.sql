-- A fixed claim that ends (given up, swapped for a full set, or removed by the GOM) is kept, marked as ended, rather than
-- deleted — so a joiner's request history and the GOM's records still make sense afterwards.
ALTER TABLE fixed_claims
  ADD COLUMN ended_at  DATETIME(3) NULL,
  ADD COLUMN ended_via ENUM('removed','giveup','ot8') NULL;
