import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import { getEditorPluginCategories } from "../core/helpCategories.js";
import { loadDefaultConfigRaw } from "./default.js";
import { enrichJsonSchemaForEditor } from "./schemaHelp.js";
import { zGuildConfig } from "./schemas/guild.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "schema");

export type GuildConfigEditorArtifacts = {
  schema: Record<string, unknown>;
  meta: {
    version: number;
    generatedAt: string;
    templatePath: string;
    schemaPath: string;
    categories: Array<{
      id: string;
      label: string;
      description: string;
      plugins: Array<{ key: string; name: string; description: string }>;
    }>;
    plugins: Array<{
      key: string;
      name: string;
      description: string;
      category: string;
      categoryId: string;
    }>;
  };
  templateYaml: string;
};

/** Build the JSON Schema + meta + default YAML the dashboard editor uses. */
export function buildGuildConfigEditorArtifacts(): GuildConfigEditorArtifacts {
  const jsonSchema = zodToJsonSchema(zGuildConfig, {
    name: "GuildConfig",
    $refStrategy: "none",
    target: "jsonSchema7",
  });

  const rawSchema = (jsonSchema.definitions?.GuildConfig
    ? jsonSchema.definitions.GuildConfig
    : jsonSchema) as Record<string, unknown>;

  const schema = enrichJsonSchemaForEditor({
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://github.com/Clawb1t/Dreamliner/schema/guild-config.schema.json",
    title: "Dreamliner GuildConfig",
    description:
      "Guild YAML configuration for Dreamliner. Generated from Zod (zGuildConfig). Do not edit by hand — run npm run schema:export or start the bot locally.",
    ...rawSchema,
  });

  const categories = getEditorPluginCategories();

  const meta = {
    version: 1,
    generatedAt: new Date().toISOString(),
    templatePath: "config/default.server.yaml",
    schemaPath: "schema/guild-config.schema.json",
    /** Same category labels / groupings as Discord `/help`. */
    categories: categories.map((category) => ({
      id: category.id,
      label: category.label,
      description: category.description,
      plugins: category.plugins,
    })),
    plugins: categories.flatMap((category) =>
      category.plugins.map((plugin) => ({
        ...plugin,
        category: category.label,
        categoryId: category.id,
      })),
    ),
  };

  return {
    schema,
    meta,
    templateYaml: loadDefaultConfigRaw(),
  };
}

/** Write website editor schema artifacts under `schema/`. Safe to call on local bot start. */
export function exportGuildConfigSchema(): void {
  const { schema, meta } = buildGuildConfigEditorArtifacts();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "guild-config.schema.json"), `${JSON.stringify(schema, null, 2)}\n`);
  writeFileSync(join(outDir, "guild-config.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}
