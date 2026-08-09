import { definePlugin } from "../../core/plugin.js";
import { zReviewsConfig } from "../../config/schemas/reviews.js";
import { reviewsDefaultOverrides } from "./defaultOverrides.js";
import { reviewsCommands } from "./commands.js";

export const reviewsPlugin = definePlugin({
  name: "reviews",
  configSchema: zReviewsConfig,
  defaultOverrides: reviewsDefaultOverrides,
  slashCommands: reviewsCommands,
});
