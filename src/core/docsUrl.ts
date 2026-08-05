export const DEFAULT_DOCS_URL = "https://dreamliner.gitbook.io/dreamliner-docs/docs";

export function resolveDocsUrl(): string {
  return process.env.DOCS_BASE_URL ?? DEFAULT_DOCS_URL;
}

export function docsPageUrl(page: string, base = resolveDocsUrl()): string {
  return `${base.replace(/\/$/, "")}/${page.replace(/^\//, "")}`;
}
