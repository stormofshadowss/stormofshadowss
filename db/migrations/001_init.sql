-- StormOfShadowss — initial schema (MariaDB 10.11+, InnoDB, utf8mb4)
--
-- Design notes
--  * Everything the preview matched by *name* is a real foreign key here
--    (claim -> item -> order, claim -> set slot, payment -> claims it paid, ...).
--  * Money is DECIMAL(10,2). Each claim has up to four cost lines
--    (initials / ems / customs / doms) in claim_costs, each with cost + paid.
--  * A joiner's credit is never a stored number: it is the sum of credit_ledger,
--    so there is always a dated, reasoned history behind every balance.
--  * Slot ownership is enforced by the database (UNIQUE set_id+member), so two
--    people cannot take the same slot even if they click at the same instant.

-- ───────────────────────── people & sign-in ─────────────────────────

CREATE TABLE accounts (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email         VARCHAR(254) NOT NULL,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_login_at DATETIME(3) NULL,
  UNIQUE KEY uq_accounts_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A "joiner" is an Instagram handle. Anyone can claim as a handle without
-- signing in; account_id stays NULL until a signed-in person is linked to it.
CREATE TABLE joiners (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  instagram_handle VARCHAR(30) NOT NULL,          -- lower-case, no @
  account_id       BIGINT UNSIGNED NULL,
  -- Blocked ("blacklisted") by the GOM: can't place new claims, and when one of their claims is
  -- cancelled, what they'd paid is NOT returned as credit (it is recorded as forfeited instead).
  is_blocked       BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_reason   VARCHAR(255) NULL,
  blocked_at       DATETIME(3) NULL,
  -- Set when the person deleted their account. If money is still owed or held, the GOM is told.
  account_deleted_at DATETIME(3) NULL,
  created_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_joiners_handle (instagram_handle),
  KEY ix_joiners_account (account_id),
  CONSTRAINT fk_joiners_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One-time sign-in links. Only a hash is stored, never the token itself.
CREATE TABLE login_tokens (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(254) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  ip         VARCHAR(45) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  used_at    DATETIME(3) NULL,
  UNIQUE KEY uq_login_tokens_hash (token_hash),
  KEY ix_login_tokens_email (email, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sessions (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id   BIGINT UNSIGNED NOT NULL,
  token_hash   CHAR(64) NOT NULL,
  user_agent   VARCHAR(255) NULL,
  ip           VARCHAR(45) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at   DATETIME(3) NOT NULL,
  UNIQUE KEY uq_sessions_hash (token_hash),
  KEY ix_sessions_account (account_id),
  CONSTRAINT fk_sessions_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "I am @handle": needs the GOM's one-time OK when that handle already has
-- orders, payments or an address (so nobody can sign in as someone else's handle).
CREATE TABLE handle_link_requests (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id  BIGINT UNSIGNED NOT NULL,
  joiner_id   BIGINT UNSIGNED NOT NULL,
  status      ENUM('pending','approved','declined','withdrawn') NOT NULL DEFAULT 'pending',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at DATETIME(3) NULL,
  KEY ix_hlr_status (status),
  KEY ix_hlr_joiner (joiner_id),
  CONSTRAINT fk_hlr_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
  CONSTRAINT fk_hlr_joiner  FOREIGN KEY (joiner_id)  REFERENCES joiners(id)  ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE addresses (
  joiner_id    BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  full_name    VARCHAR(120) NOT NULL,
  address      TEXT NOT NULL,
  email        VARCHAR(254) NOT NULL,
  phone        VARCHAR(40) NOT NULL,
  confirmed_at DATETIME(3) NULL,
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_addresses_joiner FOREIGN KEY (joiner_id) REFERENCES joiners(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────── catalogue ─────────────────────────

CREATE TABLE images (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  filename   VARCHAR(120) NOT NULL,              -- file inside the uploads volume
  mime       VARCHAR(60) NOT NULL,
  width      INT UNSIGNED NULL,
  height     INT UNSIGNED NULL,
  bytes      INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_images_filename (filename)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE proxies (
  id   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  UNIQUE KEY uq_proxies_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE artist_groups (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name           VARCHAR(80) NOT NULL,
  cover_image_id BIGINT UNSIGNED NULL,
  is_hidden      BOOLEAN NOT NULL DEFAULT FALSE,  -- e.g. the "Off-site orders" holder
  sort_order     INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_artist_groups_name (name),
  CONSTRAINT fk_groups_image FOREIGN KEY (cover_image_id) REFERENCES images(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE group_members (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_id   BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(80) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_group_members (group_id, name),
  CONSTRAINT fk_gm_group FOREIGN KEY (group_id) REFERENCES artist_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A group order ("GO"). Private ones are never listed publicly: only the
-- people the GOM assigns items to can see them.
CREATE TABLE group_orders (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_id           BIGINT UNSIGNED NOT NULL,
  title              VARCHAR(160) NOT NULL,
  status             ENUM('open','closed') NOT NULL DEFAULT 'open',
  is_private         BOOLEAN NOT NULL DEFAULT FALSE,
  close_date         DATE NULL,
  payment_deadline   DATE NULL,
  expected_ship_date DATE NULL,
  proxy_id           BIGINT UNSIGNED NULL,
  cover_image_id     BIGINT UNSIGNED NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_group_orders_title (title),
  KEY ix_go_group (group_id),
  CONSTRAINT fk_go_group FOREIGN KEY (group_id) REFERENCES artist_groups(id),
  CONSTRAINT fk_go_proxy FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE SET NULL,
  CONSTRAINT fk_go_image FOREIGN KEY (cover_image_id) REFERENCES images(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An item inside a GO. proxy_id / payment_deadline are optional per-item
-- overrides; NULL means "use the GO's".
CREATE TABLE items (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id         BIGINT UNSIGNED NOT NULL,
  item_type        ENUM('set','independent','size','normal','random') NOT NULL,
  title            VARCHAR(160) NOT NULL,
  price            DECIMAL(10,2) NOT NULL,
  image_id         BIGINT UNSIGNED NULL,
  proxy_id         BIGINT UNSIGNED NULL,
  payment_deadline DATE NULL,
  size_bucket      ENUM('XS','S','M','L','XL') NOT NULL DEFAULT 'M',
  requires_full_set BOOLEAN NOT NULL DEFAULT FALSE,  -- 'set' items only: EVERY part must be claimed before the set can go ahead
  sort_order       INT NOT NULL DEFAULT 0,
  KEY ix_items_order (order_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES group_orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_items_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE SET NULL,
  CONSTRAINT fk_items_proxy FOREIGN KEY (proxy_id) REFERENCES proxies(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Roster for 'set' and 'independent' items. For a set, a "member" can be any part of it
-- (a photocard, a diary, washi tape...). price overrides the item's price for that part;
-- NULL means "use the item's price".
CREATE TABLE item_members (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id    BIGINT UNSIGNED NOT NULL,
  name       VARCHAR(80) NOT NULL,
  price      DECIMAL(10,2) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_item_members (item_id, name),
  CONSTRAINT fk_im_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE item_variants (           -- sizes for 'size' items
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id    BIGINT UNSIGNED NOT NULL,
  label      VARCHAR(40) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_item_variants (item_id, label),
  CONSTRAINT fk_iv_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────── sets, slots, fixed claims ─────────────────────────

CREATE TABLE item_sets (               -- parallel sets of a 'set' item
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id                   BIGINT UNSIGNED NOT NULL,
  set_number                INT UNSIGNED NOT NULL,
  admin_decision            ENUM('none','secured','cancelled') NOT NULL DEFAULT 'none',
  included_in_proxy_payment BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE KEY uq_item_sets (item_id, set_number),
  CONSTRAINT fk_sets_item FOREIGN KEY (item_id) REFERENCES items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE set_slots (
  id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  set_id                  BIGINT UNSIGNED NOT NULL,
  member_name             VARCHAR(80) NOT NULL,
  joiner_id               BIGINT UNSIGNED NULL,
  state                   ENUM('open','pending','held') NOT NULL DEFAULT 'open',
  is_fixed                BOOLEAN NOT NULL DEFAULT FALSE,   -- reserved for a fixed claimer
  raffle_status           ENUM('none','pending','resolved') NOT NULL DEFAULT 'none',
  raffle_share            DECIMAL(10,2) NULL,
  raffle_winner_joiner_id BIGINT UNSIGNED NULL,
  UNIQUE KEY uq_set_slots (set_id, member_name),            -- one holder per slot, enforced here
  KEY ix_slots_joiner (joiner_id),
  CONSTRAINT fk_slots_set    FOREIGN KEY (set_id) REFERENCES item_sets(id) ON DELETE CASCADE,
  CONSTRAINT fk_slots_joiner FOREIGN KEY (joiner_id) REFERENCES joiners(id) ON DELETE SET NULL,
  CONSTRAINT fk_slots_winner FOREIGN KEY (raffle_winner_joiner_id) REFERENCES joiners(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fixed_claims (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  item_id     BIGINT UNSIGNED NOT NULL,
  joiner_id   BIGINT UNSIGNED NOT NULL,
  member_name VARCHAR(80) NOT NULL,
  set_id      BIGINT UNSIGNED NOT NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_fixed_joiner (joiner_id),
  KEY ix_fixed_item (item_id),
  CONSTRAINT fk_fixed_item   FOREIGN KEY (item_id)   REFERENCES items(id)     ON DELETE CASCADE,
  CONSTRAINT fk_fixed_joiner FOREIGN KEY (joiner_id) REFERENCES joiners(id),
  CONSTRAINT fk_fixed_set    FOREIGN KEY (set_id)    REFERENCES item_sets(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fixed_requests (          -- joiner asks to give up / swap to OT8 on a secured set
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  joiner_id      BIGINT UNSIGNED NOT NULL,
  fixed_claim_id BIGINT UNSIGNED NOT NULL,
  action         ENUM('giveup','ot8') NOT NULL,
  status         ENUM('pending','approved','declined','withdrawn','void') NOT NULL DEFAULT 'pending',
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at    DATETIME(3) NULL,
  KEY ix_fr_status (status),
  CONSTRAINT fk_fr_joiner FOREIGN KEY (joiner_id)      REFERENCES joiners(id),
  CONSTRAINT fk_fr_fixed  FOREIGN KEY (fixed_claim_id) REFERENCES fixed_claims(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────── logistics (before claims, which point at them) ─────────────────────────

-- Inbound shipment from a proxy to the GOM (EMS / customs split across its items).
CREATE TABLE boxes (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tracking_id    VARCHAR(80) NULL,               -- internal only, never shown to joiners
  ems_total      DECIMAL(10,2) NOT NULL,
  customs_total  DECIMAL(10,2) NOT NULL DEFAULT 0,
  total_weight_g INT UNSIGNED NULL,
  status         ENUM('shipping_requested','enroute','arrived') NOT NULL DEFAULT 'shipping_requested',
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Outbound parcel to a joiner. The packing queue is these, oldest request first.
CREATE TABLE parcels (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  joiner_id      BIGINT UNSIGNED NOT NULL,
  method         VARCHAR(60) NOT NULL,
  declared_value ENUM('true','reduced') NULL,
  notes          TEXT NULL,
  bias           VARCHAR(80) NULL,
  lomo_name      VARCHAR(80) NULL,               -- name for a personalised Lomo, if any
  lomo_source    ENUM('delivery','custom') NULL, -- their delivery-details name, or one they chose
  requested_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  doms_total     DECIMAL(10,2) NULL,
  status         ENUM('requested','packed','shipped','received','cancelled') NOT NULL DEFAULT 'requested',
  packed_date    DATE NULL,
  shipped_date   DATE NULL,
  received_date  DATE NULL,
  KEY ix_parcels_queue (status, requested_at, id),
  KEY ix_parcels_joiner (joiner_id),
  CONSTRAINT fk_parcels_joiner FOREIGN KEY (joiner_id) REFERENCES joiners(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE leftover_items (          -- the Shop tab: stock already on hand
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title      VARCHAR(160) NOT NULL,
  price      DECIMAL(10,2) NOT NULL,
  qty        INT UNSIGNED NOT NULL DEFAULT 0,
  image_id   BIGINT UNSIGNED NULL,
  notes      VARCHAR(255) NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT fk_leftover_image FOREIGN KEY (image_id) REFERENCES images(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────── claims & what is owed ─────────────────────────

CREATE TABLE claims (
  id                        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  joiner_id                 BIGINT UNSIGNED NOT NULL,
  order_id                  BIGINT UNSIGNED NULL,       -- NULL only for Shop (leftover) claims
  item_id                   BIGINT UNSIGNED NULL,       -- NULL for hand-added ("direct") claims
  set_id                    BIGINT UNSIGNED NULL,
  slot_id                   BIGINT UNSIGNED NULL,       -- cleared when the claim is cancelled
  leftover_item_id          BIGINT UNSIGNED NULL,
  label                     VARCHAR(255) NOT NULL,      -- what the joiner sees
  member_name               VARCHAR(80) NULL,
  variant_label             VARCHAR(40) NULL,
  status                    ENUM('requested','confirmed','cancelled') NOT NULL DEFAULT 'requested',
  pipeline                  ENUM('awaiting fulfillment','ordered via proxy / warehouse','arrived at proxy / warehouse',
                                 'shipping requested','enroute to GOM','arrived at GOM','checking parcel',
                                 'ready to pack / on hand','packed','shipped','completed')
                            NOT NULL DEFAULT 'awaiting fulfillment',
  size_bucket               ENUM('XS','S','M','L','XL') NOT NULL DEFAULT 'M',
  weight_g                  INT UNSIGNED NULL,          -- exact weight, when known
  ready_to_pack_date        DATE NULL,                  -- starts the storage clock
  storage_deadline_override DATE NULL,
  received_date             DATE NULL,
  is_fixed                  BOOLEAN NOT NULL DEFAULT FALSE,
  is_direct                 BOOLEAN NOT NULL DEFAULT FALSE,
  box_id                    BIGINT UNSIGNED NULL,
  created_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at                DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_claims_slot (slot_id),                  -- a slot backs at most one live claim
  KEY ix_claims_joiner (joiner_id, status),
  KEY ix_claims_order (order_id, status),
  KEY ix_claims_item (item_id),
  KEY ix_claims_pipeline (pipeline),
  CONSTRAINT fk_claims_joiner   FOREIGN KEY (joiner_id) REFERENCES joiners(id),
  CONSTRAINT fk_claims_order    FOREIGN KEY (order_id)  REFERENCES group_orders(id),
  CONSTRAINT fk_claims_item     FOREIGN KEY (item_id)   REFERENCES items(id) ON DELETE SET NULL,
  CONSTRAINT fk_claims_set      FOREIGN KEY (set_id)    REFERENCES item_sets(id) ON DELETE SET NULL,
  CONSTRAINT fk_claims_slot     FOREIGN KEY (slot_id)   REFERENCES set_slots(id) ON DELETE SET NULL,
  CONSTRAINT fk_claims_leftover FOREIGN KEY (leftover_item_id) REFERENCES leftover_items(id),
  CONSTRAINT fk_claims_box      FOREIGN KEY (box_id)    REFERENCES boxes(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Four cost lines per claim. owed = cost - paid. Raising a cost later (e.g. an
-- exchange-rate adjustment) never touches what has already been paid.
CREATE TABLE claim_costs (
  claim_id  BIGINT UNSIGNED NOT NULL,
  category  ENUM('initials','ems','customs','doms') NOT NULL,
  cost      DECIMAL(10,2) NOT NULL DEFAULT 0,
  paid      DECIMAL(10,2) NOT NULL DEFAULT 0,
  paid_date DATE NULL,
  PRIMARY KEY (claim_id, category),
  CONSTRAINT fk_costs_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE parcel_items (
  parcel_id  BIGINT UNSIGNED NOT NULL,
  claim_id   BIGINT UNSIGNED NOT NULL,
  doms_share DECIMAL(10,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (parcel_id, claim_id),
  KEY ix_parcel_items_claim (claim_id),
  CONSTRAINT fk_pi_parcel FOREIGN KEY (parcel_id) REFERENCES parcels(id) ON DELETE CASCADE,
  CONSTRAINT fk_pi_claim  FOREIGN KEY (claim_id)  REFERENCES claims(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE box_items (
  box_id        BIGINT UNSIGNED NOT NULL,
  claim_id      BIGINT UNSIGNED NOT NULL,
  weight_used_g INT UNSIGNED NULL,
  ems_share     DECIMAL(10,2) NOT NULL DEFAULT 0,
  customs_share DECIMAL(10,2) NOT NULL DEFAULT 0,
  item_status   ENUM('pending','ready','checking') NOT NULL DEFAULT 'pending',
  PRIMARY KEY (box_id, claim_id),
  CONSTRAINT fk_bi_box   FOREIGN KEY (box_id)   REFERENCES boxes(id) ON DELETE CASCADE,
  CONSTRAINT fk_bi_claim FOREIGN KEY (claim_id) REFERENCES claims(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────── payments & credit ─────────────────────────

CREATE TABLE payments (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  joiner_id             BIGINT UNSIGNED NOT NULL,
  order_id              BIGINT UNSIGNED NULL,           -- NULL = "all outstanding"
  amount                DECIMAL(10,2) NOT NULL,
  method                VARCHAR(40) NOT NULL,
  reference             VARCHAR(255) NULL,              -- transaction ID, or a payer's name; optional once the payer is named
  payer_name            VARCHAR(120) NULL,
  payer_is_address_name BOOLEAN NULL,
  address_name_snapshot VARCHAR(120) NULL,
  overpay_amount        DECIMAL(10,2) NULL,             -- what the joiner said was extra when paying
  overpay_choice        ENUM('credit','tip') NULL,      -- the JOINER decides, not the GOM
  overpay_note          VARCHAR(255) NULL,
  status                ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
  created_at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  verified_at           DATETIME(3) NULL,
  verified_by           BIGINT UNSIGNED NULL,
  KEY ix_payments_status (status, created_at),
  KEY ix_payments_joiner (joiner_id),
  CONSTRAINT fk_payments_joiner FOREIGN KEY (joiner_id)   REFERENCES joiners(id),
  CONSTRAINT fk_payments_order  FOREIGN KEY (order_id)    REFERENCES group_orders(id),
  CONSTRAINT fk_payments_by     FOREIGN KEY (verified_by) REFERENCES accounts(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Exactly which cost lines a verified payment settled — the traceability the
-- preview couldn't give.
CREATE TABLE payment_allocations (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  payment_id BIGINT UNSIGNED NOT NULL,
  claim_id   BIGINT UNSIGNED NOT NULL,
  category   ENUM('initials','ems','customs','doms') NOT NULL,
  amount     DECIMAL(10,2) NOT NULL,
  KEY ix_pa_payment (payment_id),
  CONSTRAINT fk_pa_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
  CONSTRAINT fk_pa_claim   FOREIGN KEY (claim_id)   REFERENCES claims(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A joiner's credit balance = SUM(balance_effect).
--   credit  : +amount  (an overpayment kept as credit)
--   applied : -amount  (credit spent on a cost line, automatically)
--   removed : -amount  (credit deleted / overridden by the GOM)
--   tip     :  0       (recorded for your books, never part of the balance)
--   forfeited: 0      (paid for a cancelled claim by a BLOCKED handle: kept, not credited)
CREATE TABLE credit_ledger (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  joiner_id      BIGINT UNSIGNED NOT NULL,
  kind           ENUM('credit','applied','removed','tip','forfeited') NOT NULL,
  amount         DECIMAL(10,2) NOT NULL,
  balance_effect DECIMAL(10,2) NOT NULL,
  reason         VARCHAR(255) NULL,
  source         VARCHAR(80) NULL,
  payment_id     BIGINT UNSIGNED NULL,
  claim_id       BIGINT UNSIGNED NULL,
  category       ENUM('initials','ems','customs','doms') NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_ledger_joiner (joiner_id, created_at),
  CONSTRAINT fk_ledger_joiner  FOREIGN KEY (joiner_id)  REFERENCES joiners(id),
  CONSTRAINT fk_ledger_payment FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE SET NULL,
  CONSTRAINT fk_ledger_claim   FOREIGN KEY (claim_id)   REFERENCES claims(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────── proxies, settings, audit ─────────────────────────

CREATE TABLE proxy_payments (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  proxy_id   BIGINT UNSIGNED NOT NULL,
  deadline   DATE NULL,
  summary    VARCHAR(255) NULL,
  is_paid    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pp_proxy FOREIGN KEY (proxy_id) REFERENCES proxies(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE proxy_payment_items (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  proxy_payment_id BIGINT UNSIGNED NOT NULL,
  item_id          BIGINT UNSIGNED NOT NULL,
  set_id           BIGINT UNSIGNED NULL,
  CONSTRAINT fk_ppi_pp   FOREIGN KEY (proxy_payment_id) REFERENCES proxy_payments(id) ON DELETE CASCADE,
  CONSTRAINT fk_ppi_item FOREIGN KEY (item_id)          REFERENCES items(id),
  CONSTRAINT fk_ppi_set  FOREIGN KEY (set_id)           REFERENCES item_sets(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_methods (         -- "where joiners send payment", editable by the GOM
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  method       VARCHAR(40) NOT NULL,
  account_info VARCHAR(255) NOT NULL,
  sort_order   INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_payment_methods (method)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_log (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT UNSIGNED NULL,
  action     VARCHAR(80) NOT NULL,
  entity     VARCHAR(40) NULL,
  entity_id  BIGINT UNSIGNED NULL,
  detail     TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_audit_created (created_at),
  KEY ix_audit_entity (entity, entity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
