-- A person's handles share their credit: when credit on one handle can pay for what another handle owes, it is MOVED between them with a pair of ledger entries
-- (out of one, into the other), so each handle's own books still balance and the reason is visible.
ALTER TABLE credit_ledger MODIFY kind ENUM('credit','applied','removed','tip','forfeited','transfer_in','transfer_out') NOT NULL;
