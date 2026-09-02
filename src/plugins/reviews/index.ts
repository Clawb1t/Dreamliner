import { definePlugin } from "../../core/plugin.js";
import { zReviewsConfig } from "../../config/schemas/reviews.js";
import { reviewsCommands } from "./commands.js";

export const reviewsPlugin = definePlugin({
  name: "reviews",
  configSchema: zReviewsConfig,
  slashCommands: reviewsCommands,
});
