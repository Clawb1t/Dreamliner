-- Economy plugin (global/server balances + Dreamliner Exchange stocks) removed entirely.
DROP TABLE IF EXISTS economy_stock_transactions;
DROP TABLE IF EXISTS economy_stock_holdings;
DROP TABLE IF EXISTS economy_stock_activity_minutes;
DROP TABLE IF EXISTS economy_stock_price_history;
DROP TABLE IF EXISTS economy_stocks;
DROP TABLE IF EXISTS economy_server_accounts;
DROP TABLE IF EXISTS economy_global_accounts;
