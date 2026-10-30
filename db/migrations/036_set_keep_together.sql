-- A claim now REMEMBERS that it was placed "together" (the person chose to keep their parts in one set), so that when someone drops out of an unsecured set and a person from a LATER set is moved up to fill the gap,
-- nobody who asked to stay together is split up. Claims that already exist can't tell us what was chosen, so anyone holding 2 or more parts in the same set is treated as "keep together" — never split by mistake.
ALTER TABLE claims ADD COLUMN keep_together TINYINT(1) NOT NULL DEFAULT 0;
UPDATE claims c JOIN (SELECT joiner_id, set_id FROM claims WHERE set_id IS NOT NULL AND status <> 'cancelled' GROUP BY joiner_id, set_id HAVING COUNT(*) >= 2) g
    ON g.joiner_id = c.joiner_id AND g.set_id = c.set_id SET c.keep_together = 1 WHERE c.status <> 'cancelled';
