import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { badgeDefinitions, userBadges } from "../db/schema.js";

export type UserBadge = {
  id: number;
  badgeId: number;
  key: string;
  name: string;
  description: string | null;
  icon: string;
  iconImageUrl: string | null;
  colorHex: string | null;
  assignedAt: string;
  assignedBy: string;
  displayed: boolean;
  displayOrder: number;
};

const MAX_DISPLAYED_BADGES = 6;

function toUserBadge(row: {
  id: number;
  badgeId: number;
  assignedAt: Date;
  assignedBy: string;
  displayed: boolean;
  displayOrder: number;
  key: string;
  name: string;
  description: string | null;
  icon: string;
  iconImage: string | null;
  colorHex: string | null;
}): UserBadge {
  return {
    id: row.id,
    badgeId: row.badgeId,
    key: row.key,
    name: row.name,
    description: row.description ?? null,
    icon: row.icon,
    iconImageUrl: row.iconImage ? `data:image/png;base64,${row.iconImage}` : null,
    colorHex: row.colorHex ?? null,
    assignedAt: row.assignedAt.toISOString(),
    assignedBy: row.assignedBy,
    displayed: row.displayed,
    displayOrder: row.displayOrder,
  };
}

/** All badges owned by a user, joined with their definitions, ordered for display. */
export async function listUserBadges(userId: string): Promise<UserBadge[]> {
  const rows = await getDb()
    .select({
      id: userBadges.id,
      badgeId: userBadges.badgeId,
      assignedAt: userBadges.assignedAt,
      assignedBy: userBadges.assignedBy,
      displayed: userBadges.displayed,
      displayOrder: userBadges.displayOrder,
      key: badgeDefinitions.key,
      name: badgeDefinitions.name,
      description: badgeDefinitions.description,
      icon: badgeDefinitions.icon,
      iconImage: badgeDefinitions.iconImage,
      colorHex: badgeDefinitions.colorHex,
    })
    .from(userBadges)
    .innerJoin(badgeDefinitions, eq(userBadges.badgeId, badgeDefinitions.id))
    .where(eq(userBadges.userId, userId))
    .orderBy(asc(userBadges.displayOrder), asc(userBadges.assignedAt))
    .all();
  return rows.map(toUserBadge);
}

/** Only the badges the user has chosen to show publicly, in display order. */
export async function listDisplayedUserBadges(userId: string): Promise<UserBadge[]> {
  const badges = await listUserBadges(userId);
  return badges.filter((badge) => badge.displayed);
}

export async function assignBadge(
  userId: string,
  badgeId: number,
  assignedBy: string,
): Promise<UserBadge[]> {
  const existing = await getDb()
    .select()
    .from(userBadges)
    .where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badgeId)))
    .get();
  if (!existing) {
    await getDb().insert(userBadges).values({
      userId,
      badgeId,
      assignedAt: new Date(),
      assignedBy,
      displayed: true,
      displayOrder: 0,
    });
  }
  return listUserBadges(userId);
}

export async function unassignBadge(userId: string, badgeId: number): Promise<UserBadge[]> {
  await getDb()
    .delete(userBadges)
    .where(and(eq(userBadges.userId, userId), eq(userBadges.badgeId, badgeId)));
  return listUserBadges(userId);
}

/** Sets which of the user's own badges are displayed, and in what order. Ids not owned are ignored. */
export async function setDisplayedBadges(
  userId: string,
  orderedBadgeIds: number[],
): Promise<UserBadge[]> {
  const owned = await getDb()
    .select({ id: userBadges.id, badgeId: userBadges.badgeId })
    .from(userBadges)
    .where(eq(userBadges.userId, userId))
    .all();
  const ownedBadgeIds = new Set(owned.map((row) => row.badgeId));

  const toDisplay = [...new Set(orderedBadgeIds)]
    .filter((id) => ownedBadgeIds.has(id))
    .slice(0, MAX_DISPLAYED_BADGES);
  const displaySet = new Set(toDisplay);

  const db = getDb();
  await Promise.all(
    owned.map((row, index) => {
      const displayed = displaySet.has(row.badgeId);
      const displayOrder = displayed ? toDisplay.indexOf(row.badgeId) : index;
      return db
        .update(userBadges)
        .set({ displayed, displayOrder })
        .where(eq(userBadges.id, row.id));
    }),
  );

  return listUserBadges(userId);
}

/** Bulk lookup used by leaderboards/lists that want to show a small badge set per user. */
export async function getDisplayedBadgesForUsers(
  userIds: string[],
): Promise<Map<string, UserBadge[]>> {
  const unique = [...new Set(userIds.filter(Boolean))];
  const map = new Map<string, UserBadge[]>();
  if (unique.length === 0) return map;

  const rows = await getDb()
    .select({
      userId: userBadges.userId,
      id: userBadges.id,
      badgeId: userBadges.badgeId,
      assignedAt: userBadges.assignedAt,
      assignedBy: userBadges.assignedBy,
      displayed: userBadges.displayed,
      displayOrder: userBadges.displayOrder,
      key: badgeDefinitions.key,
      name: badgeDefinitions.name,
      description: badgeDefinitions.description,
      icon: badgeDefinitions.icon,
      iconImage: badgeDefinitions.iconImage,
      colorHex: badgeDefinitions.colorHex,
    })
    .from(userBadges)
    .innerJoin(badgeDefinitions, eq(userBadges.badgeId, badgeDefinitions.id))
    .where(and(inArray(userBadges.userId, unique), eq(userBadges.displayed, true)))
    .orderBy(asc(userBadges.displayOrder))
    .all();

  for (const row of rows) {
    const list = map.get(row.userId) ?? [];
    list.push(toUserBadge(row));
    map.set(row.userId, list);
  }
  return map;
}
