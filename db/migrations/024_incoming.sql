-- Orders the GOM (or a proxy) places with shops, so they can see what is on its way to the warehouse and which shop to chase.
-- A store order covers some copies of some items; arrivals are counted per line; each has any number of tracking numbers (to the warehouse).
CREATE TABLE gom_settings (
  k VARCHAR(40) NOT NULL PRIMARY KEY,
  v TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE store_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store VARCHAR(120) NOT NULL,
  order_ref VARCHAR(120) NULL,
  order_url VARCHAR(500) NULL,
  ordered_on DATE NOT NULL,
  proxy_id BIGINT UNSIGNED NULL,
  notes TEXT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'open',
  last_chased_on DATE NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_store_orders_status (status, ordered_on),
  CONSTRAINT fk_store_orders_proxy FOREIGN KEY (proxy_id) REFERENCES proxies (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE store_order_lines (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_order_id BIGINT UNSIGNED NOT NULL,
  item_id BIGINT UNSIGNED NOT NULL,
  qty INT UNSIGNED NOT NULL,
  arrived_qty INT UNSIGNED NOT NULL DEFAULT 0,
  note VARCHAR(200) NULL,
  KEY ix_store_lines_item (item_id),
  CONSTRAINT fk_store_lines_order FOREIGN KEY (store_order_id) REFERENCES store_orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_store_lines_item  FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE store_shipments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  store_order_id BIGINT UNSIGNED NOT NULL,
  carrier VARCHAR(40) NULL,
  tracking_no VARCHAR(40) NOT NULL,
  shipped_on DATE NULL,
  arrived_on DATE NULL,
  notes VARCHAR(200) NULL,
  CONSTRAINT fk_store_ship_order FOREIGN KEY (store_order_id) REFERENCES store_orders (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
