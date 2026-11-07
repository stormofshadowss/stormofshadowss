-- CARDS, slice 2: a PUBLISHED bundle is backed by a real group order, and each card (box) by a real item in it, so claims, payments, the Claims tab, packing and (for cards not on hand) the whole ordering process just work.
--   group_orders.is_cards — marks those orders: they are kept out of the normal public order list and can only be changed from the Cards tab.
--   card_bundles.order_id  — the group order behind a published bundle.
--   card_boxes.item_id     — the item behind a card; purchase_limit = its copies, so "copies left" is just the item's purchase limit minus claims.
--   card_boxes.crop_image_id — the card's own picture as an `images` row (items point at it, so the picture follows the claim everywhere).
ALTER TABLE group_orders ADD COLUMN is_cards TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE card_bundles ADD COLUMN order_id BIGINT UNSIGNED NULL, ADD UNIQUE KEY uq_card_bundles_order (order_id), ADD CONSTRAINT fk_card_bundles_order FOREIGN KEY (order_id) REFERENCES group_orders(id) ON DELETE SET NULL;
ALTER TABLE card_boxes ADD COLUMN item_id BIGINT UNSIGNED NULL, ADD COLUMN crop_image_id BIGINT UNSIGNED NULL, ADD UNIQUE KEY uq_card_boxes_item (item_id),
  ADD CONSTRAINT fk_card_boxes_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE SET NULL, ADD CONSTRAINT fk_card_boxes_cropimg FOREIGN KEY (crop_image_id) REFERENCES images(id) ON DELETE SET NULL;
