import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createCanvas } from "@napi-rs/canvas";
import type { Guild } from "discord.js";
import { FILE_UPLOAD_LIMITS, fileResponseHeaders, handleFilesRequest, resetFileUploadLimitsForTests } from "../../bridge/webFiles.js";
import { computeUsage } from "./references.js";
import {
  deleteServerFile,
  getServerFile,
  listServerFiles,
  readServerFile,
  replaceServerFile,
  saveServerFile,
  serverFileUrl,
  setServerFilesTestEnv,
  touchServerFile,
} from "./store.js";
import { countGifFrames, sniffUploadType, stripJpegMetadata, stripPngMetadata, UploadValidationError, validateUpload } from "./validate.js";

const GUILD_A = "153796088802640286";
const GUILD_B = "100000000000000001";
const USER = "200000000000000002";
const OTHER = "300000000000000003";
const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "drizzle", "migrations", "0154_server_files.sql");

const noCheck = async () => {};

function canvasImage(type: "image/png" | "image/jpeg" | "image/webp", w = 8, h = 6, colour = "#3a7bd5"): Buffer {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  return type === "image/png" ? canvas.toBuffer("image/png") : type === "image/jpeg" ? canvas.toBuffer("image/jpeg") : canvas.toBuffer("image/webp");
}

/** A 1x1 GIF89a. */
const GIF = Buffer.from("47494638396101000100800000000000ffffff21f90401000000002c00000000010001000002024401003b", "hex");
/** A GIF with `n` 1x1 frames. */
function gifWithFrames(n: number): Buffer {
  const head = Buffer.from("47494638396101000100800000000000ffffff", "hex");
  const frame = Buffer.from("2c00000000010001000002024401 00".replace(/\s/g, ""), "hex");
  return Buffer.concat([head, ...Array.from({ length: n }, () => frame), Buffer.from([0x3b])]);
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
const HTML_AS_PNG = Buffer.from("<!doctype html><html><body><script>alert(document.cookie)</script></body></html>");

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, data, Buffer.alloc(4)]);
}

describe("validateUpload (safety limits)", () => {
  it("accepts real PNG, JPEG, GIF and WebP by their bytes", () => {
    for (const [bytes, type] of [
      [canvasImage("image/png"), "image/png"],
      [canvasImage("image/jpeg"), "image/jpeg"],
      [GIF, "image/gif"],
      [canvasImage("image/webp"), "image/webp"],
    ] as const) {
      assert.equal(validateUpload(bytes).contentType, type);
    }
  });

  it("rejects disallowed types: SVG and HTML renamed as PNG", () => {
    assert.equal(sniffUploadType(SVG), null);
    assert.throws(() => validateUpload(SVG), (e: unknown) => e instanceof UploadValidationError && e.status === 415);
    assert.throws(() => validateUpload(HTML_AS_PNG), (e: unknown) => e instanceof UploadValidationError && e.status === 415);
    const fake = Buffer.concat([canvasImage("image/png").subarray(0, 8), Buffer.from("<html>not really a png</html>")]);
    assert.throws(() => validateUpload(fake), UploadValidationError);
  });

  it("rejects oversized files (4 MB, the Welcomer limit) and empty ones", () => {
    const big = Buffer.concat([canvasImage("image/png"), Buffer.alloc(4 * 1024 * 1024)]);
    assert.throws(() => validateUpload(big), (e: unknown) => e instanceof UploadValidationError && e.status === 413 && /4 MB/.test(e.message));
    assert.throws(() => validateUpload(Buffer.alloc(0)), UploadValidationError);
  });

  it("rejects too many pixels (over 4096 x 4096)", () => {
    const png = Buffer.from(canvasImage("image/png"));
    png.writeUInt32BE(4097, 16);
    assert.throws(() => validateUpload(png), /4096 x 4096/);
  });

  it("rejects a decompression-bomb style file: tiny bytes, huge declared size", () => {
    const bomb = Buffer.from(GIF);
    bomb.writeUInt16LE(65535, 6);
    bomb.writeUInt16LE(65535, 8);
    assert.ok(bomb.length < 100);
    assert.throws(() => validateUpload(bomb), /at most 4096/);
  });

  it("caps animation frames", () => {
    assert.equal(countGifFrames(gifWithFrames(3)), 3);
    assert.equal(validateUpload(gifWithFrames(3)).frames, 3);
    assert.throws(() => validateUpload(gifWithFrames(501)), /at most 500/);
  });

  it("strips PNG text chunks and trailing data, and JPEG EXIF except orientation", () => {
    const png = canvasImage("image/png");
    const withText = Buffer.concat([png.subarray(0, 33), pngChunk("tEXt", Buffer.from("Author\0Secret Person")), png.subarray(33), Buffer.from("<html>")]);
    assert.deepEqual(stripPngMetadata(withText), png);

    const jpeg = canvasImage("image/jpeg");
    const tiff = Buffer.alloc(26);
    tiff.write("MM", 0, "latin1");
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(6, 18);
    const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff, Buffer.from("GPS 51.5N 0.1W")]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    const stripped = stripJpegMetadata(Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
    assert.equal(stripped.includes(Buffer.from("GPS 51.5N")), false);
    assert.equal(stripped.includes(Buffer.from("Exif\0\0", "latin1")), true);
  });
});

describe("Server Files store, usage and bridge routes", () => {
  let dir: string;
  let db: Database.Database;
  const guildA = { id: GUILD_A } as Guild;
  const guildB = { id: GUILD_B } as Guild;
  const quota = async () => ({ count: 100, bytes: 100 * 1024 * 1024, one: false });

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "dl-files-"));
    db = new Database(":memory:");
    db.exec(readFileSync(MIGRATION, "utf8"));
    db.exec(`
      CREATE TABLE guild_configs (guild_id TEXT PRIMARY KEY, config_json TEXT, user_config_json TEXT);
      CREATE TABLE dream_commands (guild_id TEXT, name TEXT, program TEXT);
      CREATE TABLE message_kit_assets (id TEXT PRIMARY KEY, guild_id TEXT, filename TEXT, content_type TEXT, size INTEGER, sha256 TEXT, created_by TEXT, created_at INTEGER);
    `);
    setServerFilesTestEnv({ root: dir, db });
  });
  after(() => {
    setServerFilesTestEnv(null);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => resetFileUploadLimitsForTests());

  const call = (
    guild: Guild,
    method: string,
    rest: string[],
    opts: { body?: Record<string, unknown> | null; managers?: string[]; pluginManagers?: string[]; userId?: string; query?: Record<string, string>; check?: (b: Buffer) => Promise<void> } = {},
  ) =>
    handleFilesRequest({
      guild,
      method,
      rest,
      query: new URLSearchParams(opts.query ?? {}),
      userId: opts.userId ?? USER,
      managesServer: async (id) => (opts.managers ?? [USER]).includes(id),
      pluginManager: async (id) => (opts.pluginManagers ?? []).includes(id),
      readJson: async () => opts.body ?? null,
      quota,
      contentCheck: opts.check ?? noCheck,
    });

  const upload = (guild: Guild, bytes: Buffer, extra: Parameters<typeof call>[3] = {}) =>
    call(guild, "POST", [], { ...extra, body: { filename: "pic.png", dataBase64: bytes.toString("base64") } });

  it("stores under a stable unguessable id and dedupes identical bytes", async () => {
    const png = canvasImage("image/png", 9, 9);
    const first = await saveServerFile(GUILD_A, USER, { filename: "../../evil name.svg", bytes: png }, { contentCheck: noCheck });
    assert.match(first.file.id, /^[a-f0-9]{32}$/);
    assert.equal(first.file.displayName, "evil name.png");
    const again = await saveServerFile(GUILD_A, USER, { filename: "x.png", bytes: png }, { contentCheck: noCheck });
    assert.equal(again.existing, true);
    assert.equal(again.file.id, first.file.id);
    assert.equal(listServerFiles(GUILD_A).filter((f) => f.sha256 === first.file.sha256).length, 1);
  });

  it("enforces the file-count and storage quotas", async () => {
    await assert.rejects(saveServerFile(GUILD_A, USER, { filename: "a.gif", bytes: GIF }, { quota: { count: 1, bytes: 1e9 }, contentCheck: noCheck }), /most it can keep/);
    await assert.rejects(saveServerFile(GUILD_A, USER, { filename: "a.gif", bytes: GIF }, { quota: { count: 99, bytes: 10 }, contentCheck: noCheck }), /would go over/);
  });

  it("runs the content check (scam image blocklist) on uploads", async () => {
    const res = await upload(guildA, canvasImage("image/png", 5, 5, "#ff0000"), {
      check: async () => {
        throw new UploadValidationError("That image matches a known scam image, so it can't be uploaded.", 422);
      },
    });
    assert.equal(res.status, 422);
  });

  it("uploads through the route and serves the bytes with safe headers", async () => {
    const posted = await upload(guildA, canvasImage("image/jpeg", 12, 12));
    assert.equal(posted.status, 201);
    const file = (posted as { json: { file: { id: string; url: string } } }).json.file;
    assert.match(file.url, new RegExp(`/api/files/${GUILD_A}/${file.id}\\.jpg$`));
    const served = await call(guildA, "GET", ["raw", `${file.id}.jpg`]);
    assert.ok("binary" in served);
    assert.equal(served.headers["Content-Type"], "image/jpeg");
    assert.equal(served.headers["X-Content-Type-Options"], "nosniff");
    assert.match(served.headers["Content-Security-Policy"]!, /sandbox/);
    assert.equal((await call(guildA, "GET", ["raw", `${file.id}.png`])).status, 404);
    const headers = fileResponseHeaders({ contentType: "image/png", sha256: "a".repeat(64), displayName: 'a"b<c>.png' }, 10);
    assert.equal(headers["Content-Disposition"], 'inline; filename="a_b_c_.png"');
  });

  it("refuses SVG, HTML and oversized files through the route", async () => {
    assert.equal((await upload(guildA, SVG)).status, 415);
    assert.equal((await upload(guildA, HTML_AS_PNG)).status, 415);
    assert.equal((await upload(guildA, Buffer.alloc(5 * 1024 * 1024))).status, 413);
  });

  it("rate limits uploads per user per hour", async () => {
    const png = canvasImage("image/png", 3, 3);
    for (let i = 0; i < FILE_UPLOAD_LIMITS.perUserHour; i++) assert.ok([200, 201].includes((await upload(guildA, png)).status));
    const blocked = await upload(guildA, png);
    assert.equal(blocked.status, 429);
    assert.match(String((blocked as { json: { error: string } }).json.error), /last hour/);
  });

  it("keeps each server's files to itself (read, list, delete, touch, replace)", async () => {
    const { file } = await saveServerFile(GUILD_A, USER, { filename: "w.webp", bytes: canvasImage("image/webp", 7, 7) }, { contentCheck: noCheck });
    assert.equal((await call(guildB, "GET", ["raw", `${file.id}.webp`])).status, 404);
    assert.equal((await call(guildB, "GET", [file.id])).status, 404);
    assert.equal((await call(guildB, "DELETE", [file.id])).status, 404);
    assert.equal((await call(guildB, "POST", [file.id, "touch"])).status, 404);
    assert.equal(readServerFile(GUILD_B, file.id, "webp"), null);
    assert.equal(touchServerFile(GUILD_B, file.id), false);
    assert.equal(deleteServerFile(GUILD_B, file.id), false);
    const listedB = (await call(guildB, "GET", [])) as { json: { files: unknown[] } };
    assert.equal(listedB.json.files.length, 0);
    assert.ok(getServerFile(GUILD_A, file.id));
  });

  it("lets a plugin manager upload and pick, but only Manage Server delete or rename", async () => {
    const opts = { managers: [], pluginManagers: [OTHER], userId: OTHER, query: { plugin: "welcome_message" } };
    assert.equal((await call(guildA, "GET", [], { managers: [], userId: OTHER })).status, 403);
    const posted = await upload(guildA, canvasImage("image/png", 4, 4, "#00ff00"), opts);
    assert.equal(posted.status, 201);
    const id = (posted as { json: { file: { id: string } } }).json.file.id;
    assert.equal((await call(guildA, "DELETE", [id], opts)).status, 403);
    assert.equal((await call(guildA, "PATCH", [id], { ...opts, body: { displayName: "x" } })).status, 403);
  });

  it("replacing keeps the id and link", async () => {
    const { file } = await saveServerFile(GUILD_A, USER, { filename: "r.png", bytes: canvasImage("image/png", 10, 10) }, { contentCheck: noCheck });
    const url = serverFileUrl(file);
    const replaced = await replaceServerFile(GUILD_A, file.id, USER, canvasImage("image/jpeg", 20, 10), { contentCheck: noCheck });
    assert.equal(serverFileUrl(replaced), url);
    assert.equal(replaced.contentType, "image/jpeg");
    assert.equal(replaced.width, 20);
    assert.equal(readServerFile(GUILD_A, file.id, "png")?.bytes.length, replaced.size);
  });

  it("indexes the older per-feature stores in place, keeping their files where they were", async () => {
    // A Welcomer card background and a Message Kits image, as those features store them.
    const welcomeDir = join(dir, GUILD_A, "welcome");
    mkdirSync(welcomeDir, { recursive: true });
    const welcomePath = join(welcomeDir, "abc123def4567890.png");
    writeFileSync(welcomePath, canvasImage("image/png", 30, 10, "#123456"));
    const kitDir = join(dir, GUILD_A, "message-kits");
    mkdirSync(kitDir, { recursive: true });
    writeFileSync(join(kitDir, "0123456789abcdef"), canvasImage("image/jpeg", 16, 16, "#654321"));
    db.prepare("INSERT INTO message_kit_assets VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("0123456789abcdef", GUILD_A, "banner.jpg", "image/jpeg", 1, "x", USER, Date.now());

    const files = listServerFiles(GUILD_A);
    const welcome = files.find((f) => f.source === "welcome")!;
    const kit = files.find((f) => f.source === "message_kits")!;
    assert.equal(welcome.legacyRef, "abc123def4567890");
    assert.equal(kit.legacyRef, "asset:0123456789abcdef");
    assert.equal(kit.displayName, "banner.jpg");
    // Old paths untouched (so old links keep resolving), and the new link serves the same bytes.
    assert.ok(existsSync(welcomePath));
    assert.deepEqual(readServerFile(GUILD_A, welcome.id, "png")?.bytes, readFileSync(welcomePath));
    // Listing again doesn't duplicate.
    assert.equal(listServerFiles(GUILD_A).filter((f) => f.source === "welcome").length, 1);

    // Used where the feature's own id is saved.
    db.prepare("INSERT INTO guild_configs VALUES (?, ?, ?)").run(
      GUILD_A,
      "{}",
      JSON.stringify({ plugins: { welcome_message: { config: { join: { card: { background_asset_id: "abc123def4567890" } } } } } }),
    );
    const usage = computeUsage(GUILD_A, [welcome, kit], db);
    assert.deepEqual(usage.get(welcome.id), [{ label: "Welcomer settings", section: "plugin:welcome_message" }]);
    assert.deepEqual(usage.get(kit.id), []);

    // When the feature deletes its file, the library drops it.
    rmSync(join(kitDir, "0123456789abcdef"));
    assert.equal(listServerFiles(GUILD_A).some((f) => f.id === kit.id), false);
  });

  it("protects files in use: delete warns with where, force deletes", async () => {
    const { file } = await saveServerFile(GUILD_A, USER, { filename: "used.png", bytes: canvasImage("image/png", 11, 11, "#abcdef") }, { contentCheck: noCheck });
    db.prepare("INSERT INTO dream_commands VALUES (?, ?, ?)").run(GUILD_A, "rules", JSON.stringify({ steps: [{ image: serverFileUrl(file) }] }));
    const refused = (await call(guildA, "DELETE", [file.id])) as { status: number; json: { usedIn: { label: string }[] } };
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.json.usedIn.map((u) => u.label), ["/rules command"]);
    const bulk = await call(guildA, "POST", ["bulk"], { body: { action: "delete", ids: [file.id] } });
    assert.equal(bulk.status, 409);
    assert.equal((await call(guildA, "DELETE", [file.id], { query: { force: "1" } })).status, 200);
    assert.equal(getServerFile(GUILD_A, file.id), null);
  });

  it("renames and moves files into folders", async () => {
    const { file } = await saveServerFile(GUILD_A, USER, { filename: "f.png", bytes: canvasImage("image/png", 12, 5) }, { contentCheck: noCheck });
    const patched = (await call(guildA, "PATCH", [file.id], { body: { displayName: "  Hero banner ", folder: "Banners" } })) as { json: { file: { name: string; folder: string } } };
    assert.equal(patched.json.file.name, "Hero banner");
    assert.equal(patched.json.file.folder, "Banners");
    const moved = (await call(guildA, "POST", ["bulk"], { body: { action: "move", ids: [file.id], folder: "" } })) as { json: { moved: number } };
    assert.equal(moved.json.moved, 1);
    assert.equal(getServerFile(GUILD_A, file.id)?.folder, null);
  });
});
