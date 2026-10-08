-- "Price to be confirmed": an item can be hosted before its price is final. While it's TBC the stored price is just a placeholder (0) and must
-- never be used; claims on it are marked price_tbc, cost nothing, and cannot be secured. Setting the price clears the marks.
ALTER TABLE items  ADD COLUMN price_tbc TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE claims ADD COLUMN price_tbc TINYINT(1) NOT NULL DEFAULT 0;
