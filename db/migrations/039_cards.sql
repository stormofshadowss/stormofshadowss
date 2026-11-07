-- CARDS: single photocards sold from SPREAD PHOTOS ("boards"). A bundle (like a group order) holds boards; a board is one photo with a box drawn over each card; each box has a price and a quantity.
--   card_types   — kinds of card with a default price (POB, lucky draw, …); a card follows its type's price unless it has its own (price_override).
--   card_bundles — a collection of boards for one artist group. on_hand = 1: the cards are in hand (claims confirm at once, paid ones go straight to "ready to pack"); on_hand = 0: not in hand yet,
--                  so it goes through the normal ordering / shipping process like a group order.
--   card_boards  — one spread photo. image_id is the web copy (2400 px, in `images`); source_file is the full-size copy (up to 6000 px) the card crops are cut from.
--   card_boxes   — one card: its place on the photo as FRACTIONS of the photo's width / height (so it works at any zoom), its price, how many copies, and its own cropped picture (crop_file).
CREATE TABLE card_types (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(60) NOT NULL,
  default_price DECIMAL(10,2) NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_card_types_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE card_bundles (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_id    BIGINT UNSIGNED NULL,
  title       VARCHAR(160) NOT NULL,
  description TEXT NULL,
  on_hand     TINYINT(1) NOT NULL DEFAULT 1,
  closes_on   DATE NULL,
  pay_days    INT NOT NULL DEFAULT 5,
  status      ENUM('draft','open','closed') NOT NULL DEFAULT 'draft',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_card_bundles_group (group_id, status),
  CONSTRAINT fk_card_bundles_group FOREIGN KEY (group_id) REFERENCES artist_groups(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE card_boards (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bundle_id   BIGINT UNSIGNED NOT NULL,
  title       VARCHAR(120) NOT NULL,
  image_id    BIGINT UNSIGNED NULL,
  source_file VARCHAR(80) NULL,
  width       INT UNSIGNED NOT NULL,
  height      INT UNSIGNED NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  KEY ix_card_boards_bundle (bundle_id, sort_order),
  CONSTRAINT fk_card_boards_bundle FOREIGN KEY (bundle_id) REFERENCES card_bundles(id) ON DELETE CASCADE,
  CONSTRAINT fk_card_boards_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE card_boxes (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  board_id       BIGINT UNSIGNED NOT NULL,
  number         INT UNSIGNED NOT NULL,
  x              DECIMAL(8,6) NOT NULL,
  y              DECIMAL(8,6) NOT NULL,
  w              DECIMAL(8,6) NOT NULL,
  h              DECIMAL(8,6) NOT NULL,
  type_id        BIGINT UNSIGNED NULL,
  price          DECIMAL(10,2) NOT NULL,
  price_override TINYINT(1) NOT NULL DEFAULT 0,
  qty            INT UNSIGNED NOT NULL DEFAULT 1,
  note           VARCHAR(255) NULL,
  crop_file      VARCHAR(80) NULL,
  KEY ix_card_boxes_board (board_id, number),
  KEY ix_card_boxes_type (type_id),
  CONSTRAINT fk_card_boxes_board FOREIGN KEY (board_id) REFERENCES card_boards(id) ON DELETE CASCADE,
  CONSTRAINT fk_card_boxes_type FOREIGN KEY (type_id) REFERENCES card_types(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
