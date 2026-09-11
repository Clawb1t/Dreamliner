-- Stock market system removed from the economy plugin entirely (needlessly complicated).
-- /exchange is kept, now using a fixed bot-wide conversion rate instead of a simulated price.
DROP TABLE IF EXISTS economy_stocks;
DROP TABLE IF EXISTS economy_stock_price_history;
DROP TABLE IF EXISTS economy_stock_activity_minutes;
DROP TABLE IF EXISTS economy_stock_holdings;
DROP TABLE IF EXISTS economy_stock_transactions;
