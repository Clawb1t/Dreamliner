-- Verified members only: a giveaway can require entrants to have passed Passport.
ALTER TABLE `giveaways` ADD `require_passport` integer DEFAULT 0 NOT NULL;
