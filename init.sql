CREATE TABLE IF NOT EXISTS auctions (
  id CHAR(36) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  starting_bid DECIMAL(12,2) NOT NULL,
  current_top_bid_id CHAR(36) NULL,
  current_top_amount DECIMAL(12,2) NULL,
  closes_at DATETIME(3) NOT NULL,
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS bids (
  id CHAR(36) PRIMARY KEY,
  auction_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  idempotency_key VARCHAR(64) NOT NULL,
  created_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3),
  FOREIGN KEY (auction_id) REFERENCES auctions(id),
  UNIQUE KEY uniq_idempotency (auction_id, user_id, idempotency_key)
);

-- Seed auctions: one open auction with current top bid, one with near-future close for boundary testing
INSERT INTO auctions (id, title, starting_bid, current_top_amount, current_top_bid_id, closes_at, status) VALUES
(UUID(), 'Classic Sculpture', 100.00, 150.00, UUID(), DATE_ADD(NOW(), INTERVAL 30 MINUTE), 'open'),
(UUID(), 'Modern Painting', 500.00, NULL, NULL, DATE_ADD(NOW(), INTERVAL 2 HOUR), 'open');