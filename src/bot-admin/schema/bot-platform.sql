CREATE TABLE IF NOT EXISTS bot_channel_user (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  app_user_id INT NULL,
  platform VARCHAR(30) NOT NULL,
  external_user_id VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL DEFAULT '',
  language VARCHAR(30) NOT NULL DEFAULT 'English',
  language_locked TINYINT(1) NOT NULL DEFAULT 0,
  session_state TEXT NULL,
  bot_enabled TINYINT(1) NOT NULL DEFAULT 1,
  manual_mode TINYINT(1) NOT NULL DEFAULT 0,
  last_seen_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bot_channel_user_platform_external_user_id (platform, external_user_id)
);

CREATE TABLE IF NOT EXISTS bot_conversation (
  id INT AUTO_INCREMENT PRIMARY KEY,
  bot_channel_user_id INT NOT NULL,
  status ENUM('open', 'manual', 'closed') NOT NULL DEFAULT 'open',
  last_message_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_message (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT NOT NULL,
  direction ENUM('inbound', 'outbound') NOT NULL,
  message_type ENUM('text', 'image', 'voice', 'system') NOT NULL,
  platform VARCHAR(30) NOT NULL,
  content TEXT NOT NULL,
  media_url TEXT NULL,
  transcript TEXT NULL,
  llm_provider VARCHAR(100) NULL,
  llm_model VARCHAR(100) NULL,
  intent VARCHAR(255) NULL,
  sentiment VARCHAR(50) NULL,
  trouble_score DECIMAL(5,2) NULL,
  source VARCHAR(50) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_training_data (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  language VARCHAR(30) NOT NULL DEFAULT 'English',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  vector_embedding LONGBLOB NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_flag (
  id INT AUTO_INCREMENT PRIMARY KEY,
  conversation_id INT NOT NULL,
  bot_channel_user_id INT NOT NULL,
  flag_type ENUM('anger', 'confusion', 'repeated_failure', 'manual_handoff') NOT NULL,
  severity ENUM('low', 'medium', 'high') NOT NULL,
  reason TEXT NOT NULL,
  resolved TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bot_order (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  bot_channel_user_id INT NOT NULL,
  customer_name VARCHAR(255) NOT NULL DEFAULT '',
  customer_phone VARCHAR(50) NOT NULL DEFAULT '',
  address TEXT NULL,
  status ENUM('Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled') NOT NULL DEFAULT 'Pending',
  total_amount DECIMAL(12, 2) NOT NULL DEFAULT 0,
  invoice_url TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_bot_order_company_id (company_id),
  KEY idx_bot_order_channel_user_id (bot_channel_user_id)
);

CREATE TABLE IF NOT EXISTS bot_order_item (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  product_id INT NULL,
  product_name VARCHAR(255) NOT NULL,
  variant_text VARCHAR(255) NULL,
  quantity INT NOT NULL DEFAULT 1,
  unit_price DECIMAL(12, 2) NOT NULL DEFAULT 0,
  total_price DECIMAL(12, 2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_bot_order_item_order_id (order_id)
);

CREATE TABLE IF NOT EXISTS bot_order_status_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  status ENUM('Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled') NOT NULL,
  message TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_bot_order_status_history_order_id (order_id)
);

CREATE TABLE IF NOT EXISTS bot_order_status_template (
  id INT AUTO_INCREMENT PRIMARY KEY,
  company_id INT NOT NULL,
  status ENUM('Pending', 'Confirmed', 'Processing', 'Shipped', 'Delivered', 'Cancelled') NOT NULL,
  template TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_bot_order_status_template_company_status (company_id, status)
);
