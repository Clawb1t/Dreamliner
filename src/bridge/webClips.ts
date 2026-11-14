/**
 * Voice clips bridge — unlike most of dashboardBridge.ts's guild-config routes, clips are owned
 * by an individual user, not a guild, so every function here does its own real ownership/privacy
 * check rather than trusting a path segment the way e.g. /bridge/users/:userId/profile does. Audio
 * content is more sensitive than the resources that thinner convention was built for.
 */

import { and, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { configManager } from "../config/manager.js";
import { zClippingConfig } from "../config/schemas/clipping.js";
import { voiceClips, voiceClipParticipants } from "../db/schema.js";
import { hashClipPassword, verifyClipPasswordHash } from "../plugins/clipping/functions/clipPassword.js";
import { deleteClipFile, readClipFile, trimClipFile } from "../plugins/clipping/functions/export.js";

export type BridgeResult<T> = ({ ok: true } & T) | { ok: false; status: number; error: string };

export type ClipPrivacy = "public" | "password" | "private";

export type ClipParticipantOut = {
  userId: string;
  displayName: string;
  username: string;
  avatarUrl: string | null;
};

export type ClipSummary = {
  id: string;
  guildId: string;
  title: string;
  durationMs: number;
  privacy: ClipPrivacy;
  createdAt: string;
  ownerId: string;
  /** Capped to a handful — enough for an overlapping-avatar-stack preview, not the full roster. */
  participants: ClipParticipantOut[];
  participantCount: number;
};

export type TranscriptSegment = { startMs: number; endMs: number; text: string };

export type ClipDetail = {
  id: string;
  guildId: string;
  channelId: string;
  ownerId: string;
  title: string;
  durationMs: number;
  byteSize: number;
  privacy: ClipPrivacy;
  keepForever: boolean;
  createdAt: string;
  expiresAt: string | null;
  editedAt: string | null;
  participants: ClipParticipantOut[];
  canEdit: boolean;
  /** Null if transcription is unconfigured, still running, or failed — never blocks anything. */
  transcript: TranscriptSegment[] | null;
};

function parseTranscript(raw: string | null): TranscriptSegment[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

type ClipRow = typeof voiceClips.$inferSelect;
type ParticipantRow = typeof voiceClipParticipants.$inferSelect;

async function loadClip(clipId: string): Promise<ClipRow | null> {
  const rows = await getDb()
    .select()
    .from(voiceClips)
    .where(and(eq(voiceClips.id, clipId), isNull(voiceClips.deletedAt)))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

async function loadParticipants(clipId: string): Promise<ParticipantRow[]> {
  return getDb().select().from(voiceClipParticipants).where(eq(voiceClipParticipants.clipId, clipId)).all();
}

const SUMMARY_PARTICIPANT_CAP = 5;

function toSummary(clip: ClipRow, participants: ParticipantRow[]): ClipSummary {
  return {
    id: clip.id,
    guildId: clip.guildId,
    title: clip.title,
    durationMs: clip.durationMs,
    privacy: clip.privacy as ClipPrivacy,
    createdAt: clip.createdAt.toISOString(),
    ownerId: clip.ownerId,
    participants: participants.slice(0, SUMMARY_PARTICIPANT_CAP).map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      username: p.username,
      avatarUrl: p.avatarUrl,
    })),
    participantCount: participants.length,
  };
}

function toDetail(clip: ClipRow, participants: ParticipantRow[], canEdit: boolean): ClipDetail {
  return {
    id: clip.id,
    guildId: clip.guildId,
    channelId: clip.channelId,
    ownerId: clip.ownerId,
    title: clip.title,
    durationMs: clip.durationMs,
    byteSize: clip.byteSize,
    privacy: clip.privacy as ClipPrivacy,
    keepForever: clip.keepForever,
    createdAt: clip.createdAt.toISOString(),
    expiresAt: clip.expiresAt?.toISOString() ?? null,
    editedAt: clip.editedAt?.toISOString() ?? null,
    participants: participants.map((p) => ({
      userId: p.userId,
      displayName: p.displayName,
      username: p.username,
      avatarUrl: p.avatarUrl,
    })),
    canEdit,
    transcript: parseTranscript(clip.transcript),
  };
}

/** "owner" and "participant" always see everything; anyone else is gated by `privacy`. */
function relationOf(clip: ClipRow, participants: ParticipantRow[], viewerId: string | null): "owner" | "participant" | null {
  if (!viewerId) return null;
  if (clip.ownerId === viewerId) return "owner";
  if (participants.some((p) => p.userId === viewerId)) return "participant";
  return null;
}

/** One batched query for every clip's participants instead of N+1 per-clip lookups. */
async function loadParticipantsForClips(clipIds: string[]): Promise<Map<string, ParticipantRow[]>> {
  const byClip = new Map<string, ParticipantRow[]>();
  if (clipIds.length === 0) return byClip;

  const rows = await getDb().select().from(voiceClipParticipants).where(inArray(voiceClipParticipants.clipId, clipIds)).all();
  for (const row of rows) {
    const list = byClip.get(row.clipId);
    if (list) list.push(row);
    else byClip.set(row.clipId, [row]);
  }
  return byClip;
}

export async function listClipsGallery(userId: string): Promise<BridgeResult<{ mine: ClipSummary[]; appearIn: ClipSummary[] }>> {
  const db = getDb();
  const mineRows = await db
    .select()
    .from(voiceClips)
    .where(and(eq(voiceClips.ownerId, userId), isNull(voiceClips.deletedAt)))
    .orderBy(desc(voiceClips.createdAt))
    .all();

  const appearInRows = await db
    .select({ clip: voiceClips })
    .from(voiceClipParticipants)
    .innerJoin(voiceClips, eq(voiceClipParticipants.clipId, voiceClips.id))
    .where(and(eq(voiceClipParticipants.userId, userId), ne(voiceClips.ownerId, userId), isNull(voiceClips.deletedAt)))
    .orderBy(desc(voiceClips.createdAt))
    .all();

  const allClipIds = [...mineRows.map((c) => c.id), ...appearInRows.map((r) => r.clip.id)];
  const participantsByClip = await loadParticipantsForClips(allClipIds);

  return {
    ok: true,
    mine: mineRows.map((clip) => toSummary(clip, participantsByClip.get(clip.id) ?? [])),
    appearIn: appearInRows.map((r) => toSummary(r.clip, participantsByClip.get(r.clip.id) ?? [])),
  };
}

const EXPLORE_CLIP_LIMIT = 30;

/** Public clips captured in one server, newest first — the "Explore" feed on the website. Unlike
 *  listClipsGallery above, this isn't scoped to a viewer's own clips; the bridge route calling
 *  this already checked the requester is a member of `guildId` before we get here, and privacy is
 *  still enforced here too (only "public" rows) so a caller can't widen it by skipping that route. */
export async function listGuildPublicClips(guildId: string): Promise<BridgeResult<{ clips: ClipSummary[] }>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(voiceClips)
    .where(and(eq(voiceClips.guildId, guildId), eq(voiceClips.privacy, "public"), isNull(voiceClips.deletedAt)))
    .orderBy(desc(voiceClips.createdAt))
    .limit(EXPLORE_CLIP_LIMIT)
    .all();

  const participantsByClip = await loadParticipantsForClips(rows.map((c) => c.id));
  return { ok: true, clips: rows.map((clip) => toSummary(clip, participantsByClip.get(clip.id) ?? [])) };
}

export type GetClipResult =
  | { ok: true; clip: ClipDetail }
  | { ok: true; requiresPassword: true; clipId: string }
  | { ok: false; status: number; error: string };

/** `passwordVerified` is supplied by the website after it has itself checked the viewer's signed
 *  proof cookie for this clip — the bridge still owns the actual password hash comparison (in
 *  verifyClipPassword below), it just doesn't re-derive the cookie's HMAC itself, the same split
 *  of responsibility the rest of the bridge already uses for session/identity trust. */
export async function getClip(clipId: string, viewerId: string | null, passwordVerified = false): Promise<GetClipResult> {
  const clip = await loadClip(clipId);
  if (!clip) return { ok: false, status: 404, error: "Clip not found." };

  const participants = await loadParticipants(clipId);
  const relation = relationOf(clip, participants, viewerId);

  if (!relation) {
    if (clip.privacy === "private") return { ok: false, status: 404, error: "Clip not found." };
    if (clip.privacy === "password" && !passwordVerified) {
      return { ok: true, requiresPassword: true, clipId: clip.id };
    }
  }

  return { ok: true, clip: toDetail(clip, participants, relation === "owner") };
}

export type UpdateClipInput = {
  title?: string;
  trimStartMs?: number;
  trimEndMs?: number;
  privacy?: ClipPrivacy;
  password?: string;
  keepForever?: boolean;
};

const VALID_PRIVACY: ClipPrivacy[] = ["public", "password", "private"];

async function getClipRetentionDays(guildId: string): Promise<number> {
  const guildConfig = await configManager.getEffectiveConfig(guildId);
  const parsed = zClippingConfig.safeParse(guildConfig.plugins.clipping?.config ?? {});
  return parsed.success ? parsed.data.retention_days : 30;
}

export async function updateClip(clipId: string, userId: string, input: UpdateClipInput): Promise<BridgeResult<{ clip: ClipDetail }>> {
  const clip = await loadClip(clipId);
  if (!clip) return { ok: false, status: 404, error: "Clip not found." };
  if (clip.ownerId !== userId) return { ok: false, status: 403, error: "Only the clip's owner can edit it." };

  const db = getDb();
  const patch: Partial<ClipRow> = { editedAt: new Date() };

  if (typeof input.title === "string") {
    patch.title = input.title.trim().slice(0, 100);
  }

  if (input.privacy !== undefined) {
    if (!VALID_PRIVACY.includes(input.privacy)) return { ok: false, status: 400, error: "Invalid privacy mode." };
    patch.privacy = input.privacy;
    if (input.privacy === "password") {
      if (input.password) {
        patch.passwordHash = await hashClipPassword(input.password);
      } else if (!clip.passwordHash) {
        // Leaving the password blank keeps the current one — only a clip without one needs it.
        return { ok: false, status: 400, error: "A password is required for password-protected clips." };
      }
    } else {
      patch.passwordHash = null;
    }
  } else if (input.password) {
    // Rotating the password without changing privacy mode away from "password".
    patch.passwordHash = await hashClipPassword(input.password);
  }

  if (typeof input.keepForever === "boolean") {
    patch.keepForever = input.keepForever;
    if (input.keepForever) {
      patch.expiresAt = null;
    } else if (clip.keepForever || !clip.expiresAt) {
      // Turning keep-forever off restores the guild's normal retention, counted from createdAt
      // (editing never extends retention on its own) — or from now if that's already passed.
      const retentionMs = (await getClipRetentionDays(clip.guildId)) * 24 * 60 * 60 * 1000;
      const fromCreated = clip.createdAt.getTime() + retentionMs;
      patch.expiresAt = new Date(fromCreated > Date.now() ? fromCreated : Date.now() + retentionMs);
    }
  }

  if (typeof input.trimStartMs === "number" || typeof input.trimEndMs === "number") {
    const startMs = input.trimStartMs ?? 0;
    const endMs = input.trimEndMs ?? clip.durationMs;
    const trimmed = await trimClipFile(clip.guildId, clip.id, startMs, endMs);
    if (!trimmed.ok) return { ok: false, status: 400, error: trimmed.error };
    patch.durationMs = trimmed.durationMs;
    patch.byteSize = trimmed.byteSize;
  }

  await db.update(voiceClips).set(patch).where(eq(voiceClips.id, clipId));
  const updated = await loadClip(clipId);
  if (!updated) return { ok: false, status: 404, error: "Clip not found." };
  const participants = await loadParticipants(clipId);
  return { ok: true, clip: toDetail(updated, participants, true) };
}

export async function deleteClip(clipId: string, userId: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const clip = await loadClip(clipId);
  if (!clip) return { ok: false, status: 404, error: "Clip not found." };
  if (clip.ownerId !== userId) return { ok: false, status: 403, error: "Only the clip's owner can delete it." };

  deleteClipFile(clip.guildId, clip.id);
  const db = getDb();
  await db.delete(voiceClipParticipants).where(eq(voiceClipParticipants.clipId, clipId));
  await db.delete(voiceClips).where(eq(voiceClips.id, clipId));
  return { ok: true };
}

export type ByteRange = { start: number; end: number };
export type GetClipMediaResult =
  | { ok: true; buffer: Buffer; contentType: string; totalSize: number; range: ByteRange | null }
  | { ok: false; status: number; error: string };

export async function getClipMedia(
  clipId: string,
  viewerId: string | null,
  passwordVerified = false,
  range?: ByteRange,
): Promise<GetClipMediaResult> {
  const clip = await loadClip(clipId);
  if (!clip) return { ok: false, status: 404, error: "Clip not found." };

  const participants = await loadParticipants(clipId);
  const relation = relationOf(clip, participants, viewerId);
  if (!relation) {
    if (clip.privacy === "private") return { ok: false, status: 404, error: "Clip not found." };
    if (clip.privacy === "password" && !passwordVerified) return { ok: false, status: 403, error: "Password required." };
  }

  const full = readClipFile(clip.guildId, clip.id);
  if (!full) return { ok: false, status: 404, error: "Clip file not found." };

  if (range) {
    const end = Math.min(range.end, full.length - 1);
    const start = Math.max(0, Math.min(range.start, end));
    return { ok: true, buffer: full.subarray(start, end + 1), contentType: "video/mp4", totalSize: full.length, range: { start, end } };
  }
  return { ok: true, buffer: full, contentType: "video/mp4", totalSize: full.length, range: null };
}

export async function verifyClipPassword(clipId: string, password: string): Promise<BridgeResult<{ valid: boolean }>> {
  const clip = await loadClip(clipId);
  if (!clip) return { ok: false, status: 404, error: "Clip not found." };
  if (clip.privacy !== "password" || !clip.passwordHash) return { ok: true, valid: true }; // not actually gated
  const valid = await verifyClipPasswordHash(password, clip.passwordHash);
  return { ok: true, valid };
}
