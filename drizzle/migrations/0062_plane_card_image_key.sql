-- Plane cards now use a local image file (assets/planes/) instead of a hosted URL.
ALTER TABLE `plane_card_types` RENAME COLUMN `image_url` TO `image_key`;
