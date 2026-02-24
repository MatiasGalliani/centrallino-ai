CREATE TABLE IF NOT EXISTS campaigns (
    id SERIAL PRIMARY KEY,
    slug VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    campaign_prompt TEXT,
    voice_id VARCHAR(255),
    initial_delay INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    retry_interval INTEGER DEFAULT 30,
    webhook_url VARCHAR(500),
    calendar_connected BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    leads INTEGER NOT NULL DEFAULT 0,
    calls INTEGER NOT NULL DEFAULT 0,
    qualified INTEGER NOT NULL DEFAULT 0
);

-- Índice para búsquedas rápidas por slug
CREATE INDEX IF NOT EXISTS idx_campaigns_slug ON campaigns(slug);