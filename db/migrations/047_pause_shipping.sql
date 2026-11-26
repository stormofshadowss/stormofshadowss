-- PAUSING A SHIPPING REQUEST: the joiner parks an unpacked request (it leaves the packing queue; their items stay) and resumes it later.
-- paused_at: since when (NULL = not paused). Resumed within 30 days it keeps its place in the queue (requested_at is untouched); after that it goes to the end.
-- pause_reminded_at: the ONE reminder email sent once it has been paused for 30 days (cleared each time it is paused again).
ALTER TABLE parcels ADD COLUMN paused_at DATETIME(3) NULL, ADD COLUMN pause_reminded_at DATETIME(3) NULL;
