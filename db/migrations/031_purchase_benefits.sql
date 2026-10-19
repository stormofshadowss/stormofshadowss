-- PURCHASE BENEFITS ("spend £X on these items and get N photocards"), per group order. An offer says how much must be spent (on the ticked items, on a person's SECURED claims),
-- how many bonus copies each full amount earns (repeating), and which free item the bonus is a claim on. The GOM sees who qualifies and presses a button to add them;
-- the bonus claims are tagged with the offer (claims.benefit_offer_id) so "already given" is always known.
CREATE TABLE benefit_offers (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id         BIGINT UNSIGNED NOT NULL,
  title            VARCHAR(120) NOT NULL,
  spend_threshold  DECIMAL(10,2) NOT NULL,
  quantity         INT UNSIGNED NOT NULL,
  bonus_item_id    BIGINT UNSIGNED NOT NULL,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_benefit_order (order_id),
  CONSTRAINT fk_benefit_order FOREIGN KEY (order_id) REFERENCES group_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_benefit_bonus FOREIGN KEY (bonus_item_id) REFERENCES items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE benefit_offer_items (
  offer_id BIGINT UNSIGNED NOT NULL,
  item_id  BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (offer_id, item_id),
  CONSTRAINT fk_boi_offer FOREIGN KEY (offer_id) REFERENCES benefit_offers (id) ON DELETE CASCADE,
  CONSTRAINT fk_boi_item  FOREIGN KEY (item_id)  REFERENCES items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE claims ADD COLUMN benefit_offer_id BIGINT UNSIGNED NULL, ADD KEY ix_claims_benefit (benefit_offer_id),
  ADD CONSTRAINT fk_claims_benefit FOREIGN KEY (benefit_offer_id) REFERENCES benefit_offers (id) ON DELETE SET NULL;
