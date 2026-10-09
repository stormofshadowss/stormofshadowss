-- A proxy that is the GOM themself: orders using it have no proxy payment to track, so they are left out of "items to pay a proxy for".
ALTER TABLE proxies ADD COLUMN is_self TINYINT(1) NOT NULL DEFAULT 0;
