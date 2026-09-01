-- Admin, Role Manager, Pingable Roles, Scheduled Posts, Custom Events, and Command
-- Aliases plugins removed entirely. Admin and Pingable Roles had no persisted state.
DROP TABLE IF EXISTS scheduled_posts;
DROP TABLE IF EXISTS managed_roles;
DROP TABLE IF EXISTS custom_events;
DROP TABLE IF EXISTS command_aliases;
