-- An optional product description for each item, written by the GOM and shown to joiners on the item.
ALTER TABLE items ADD COLUMN description TEXT NULL AFTER title;
