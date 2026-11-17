# The Hangar: bridge contract

The website talks to the bot's Hangar (plane cards) only through these dashboard-bridge routes. All of them need
the usual `Authorization: Bearer <DASHBOARD_BRIDGE_SECRET>` header. Bot code: `src/bridge/webHangar.ts`
(user-scoped, renders, admin sets/packs/health), `src/bridge/planeCards.ts` (admin catalog, art upload),
`src/bridge/userPublicProfile.ts` (profile cards), routed in `src/bridge/dashboardBridge.ts`.

Game rules and every tunable number live in `src/plugins/economy/hangar/constants.ts`.

## Conventions

- **Who is asking.** User-scoped routes carry the signed-in user's Discord id in the path:
  `/bridge/users/:userId/hangar/...`. The website must only ever put the session user's own id there. Rate limits
  are per that user (reads in the `read` bucket, every non-GET in the `write` bucket, including market buys and
  trade accepts). Admin routes use `?userId=` (GET) or `"userId"` in the JSON body (writes), checked against the
  superuser list.
- **Bodies** are JSON objects. Ids in bodies are numbers (copy ids, card type ids) or snowflake strings (users,
  guilds).
- **Times** are ISO 8601 strings. **Coins** are numbers with up to 2 decimals. **Parts** are integers.
- **Success** responses are `{ "ok": true, ...data }` with HTTP 200 unless noted.
- **Errors** are `{ "ok": false, "error": string, "code": HangarErrorCode, "vars"?: Record<string, string | number> }`.
  `error` is ready-to-show English text. Status by code:

| code | status | meaning |
|---|---|---|
| `invalid` | 400 | bad input, or an action that doesn't make sense (pay yourself, trade with yourself) |
| `requirements` | 400 | the plane's stats don't meet the route's requirements |
| `not_craftable` | 400 | mythic, limited print run, disabled or retired card |
| `insufficient_coins` | 402 | not enough global coins |
| `insufficient_parts` | 402 | not enough Parts |
| `not_owner` | 403 | the user doesn't own that copy |
| `forbidden` | 403 | not allowed (only the recipient can accept, superuser-only route, not a member of that guild) |
| `not_found` | 404 | unknown copy, trade, listing, pack, set, route |
| `locked` | 409 | the copy is in a listing, trade or flight |
| `conflict` | 409 | state changed underneath (already sold, already resolved, changed hands) |
| `limit` | 409 | a cap was hit (active flights, flights per day, listings, open trades, hangar max slots) |
| `hangar_full` | 409 | not enough hangar slots |
| `pack_unavailable` | 409 | pack disabled or outside its window |
| `empty_pool` | 409 | no card can be drawn (everything retired or sold out) |
| `cooldown` | 429 | boarding pass not ready, or that plane already flew today (UTC) |
| `expired` | 410 | the trade or listing has expired |

Admin catalog routes (`/bridge/platform/plane-cards` and `/:id`) keep their older error shape `{ "error": string }`
with status 400/403/404.

## Shared types

```ts
type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";
type Livery = "standard" | "gold" | "prototype";
type RouteKey = "short" | "medium" | "long" | "test"; // "test" (1 minute) is only listed for superusers
type LeaderboardBoard = "fleet_value" | "rarest" | "sets" | "flights_weekly";
type HangarErrorCode =
  | "not_found" | "not_owner" | "locked" | "insufficient_coins" | "insufficient_parts" | "invalid"
  | "pack_unavailable" | "empty_pool" | "hangar_full" | "cooldown" | "limit" | "not_craftable"
  | "max_level" | "requirements" | "conflict" | "expired" | "forbidden";
// max_level: 409, upgrading a level 10 copy.

/** Plane stats: speed, agility, safety (0-100), passengerCount. Airline stats: reputation, safety (0-100),
 *  fleetSize, destinations. */
type CardStats = Record<string, number>;

type HangarCardTypeView = {
  id: number;
  key: string;
  name: string;
  cardType: "plane" | "airline";
  subtitle: string;
  rarity: Rarity;
  rarityLabel: string;          // "Legendary"
  rarityColor: string;          // "#f1c40f"
  imageKey: string;
  imageUrl: string | null;      // "/bridge/plane-cards/image/<imageKey>" (raw art)
  renderUrl: string;            // "/bridge/hangar/render/type/<id>.png" (Standard face, no serial)
  enabled: boolean;             // false: still viewable/tradeable, never drops from packs
  retired: boolean;             // print run used up (or retired by hand): never minted again
  printRun: number | null;
  minted: number;
  craftCost: number | null;     // Parts; null for mythic and print-run cards
  salvageBase: number;          // Parts for a Standard, non First Edition copy
  stats: CardStats;
  setIds: number[];
};

type HangarCopyView = {
  id: number;
  ownerId: string;
  serial: number;
  serialLabel: string;          // "#0042/500" with a print run, "#0042" without
  livery: Livery;
  liveryLabel: string;
  firstEdition: boolean;        // serials 1-100
  level: number;                // 1-10
  xp: number;
  xpForNextLevel: number | null; // cumulative XP for the next level, null at level 10
  flights: number;
  obtainedVia: "pack" | "boarding_pass" | "craft" | "trade" | "market" | "gift" | "flight" | "migration";
  locked: { reason: "listing" | "trade" | "flight"; ref: number | null } | null; // ref = listing/trade/flight id
  mintedAt: string;
  acquiredAt: string;
  salvageValue: number;         // Parts this exact copy salvages for
  points: number;               // its Fleet Value contribution
  upgradeCost: number | null;   // Parts for the next level, null at max
  repaintCost: number | null;   // coins, null for prototype (can't be repainted)
  effectiveStats: CardStats;    // stats after the level bonus
  renderUrl: string;            // "/bridge/hangar/render/copy/<id>.png" (with serial)
  card: HangarCardTypeView;
};

type OpenedCopyView = HangarCopyView & { forced: "guarantee" | "pity" | null };

type PilotRankView = {
  key: "cadet" | "student_pilot" | "first_officer" | "captain" | "senior_captain" | "chief_pilot" | "ace" | "legend";
  label: string;
  color: string;
  minFleetValue: number;
  next: { key: string; label: string; minFleetValue: number } | null;
  progress: number;             // 0..1 towards `next` (1 at the top rank)
  title: { text: string; color: string }; // free profile title the rank unlocks (cosmetics TitleStyle shape)
};

type BoardingStatus = {
  available: boolean;
  nextAt: string | null;        // when the next pass is ready (null when available)
  streak: number;               // current consecutive-day streak (0 if broken)
  nextStreakBonusIn: number;    // claims until the next 7-day Parts bonus (0 = the next claim pays it)
};

type FlightReward = {
  parts: number; xp: number; levelsGained: number; level: number;
  bonusCopyId: number | null;   // a bonus card minted on landing
  bonusFallbackParts: number;   // paid instead of the bonus card when the hangar was full
};

type FlightView = {
  id: number;
  route: RouteKey;
  routeLabel: string;
  copyId: number;
  operatorCopyId: number | null;
  startedAt: string;
  endsAt: string;
  claimedAt: string | null;
  landed: boolean;              // endsAt has passed (claimable if claimedAt is null)
  reward: FlightReward | null;  // set once claimed
  copy: HangarCopyView | null;
};

type RecentPull = {
  openingId: number;
  source: "pack" | "boarding_pass";
  packKey: string | null;
  createdAt: string;
  pulls: {
    copyId: number | null;
    card: HangarCardTypeView | null;
    rarity: string;
    livery: string;
    forced: "guarantee" | "pity" | null;
    stillOwned: boolean;
  }[];
};

type UserBrief = { id: string; username: string; displayName: string; avatarUrl: string } | null;

type SetProgress = {
  id: number;
  key: string;
  name: string;
  description: string;
  bonusParts: number;           // paid once, the first time the set is completed
  total: number;
  owned: number;
  ownedCardTypeIds: number[];
  completed: boolean;
  bonusClaimedAt: string | null;
  cards: HangarCardTypeView[];
};

type ListingRow = {             // raw listing (copy detail only)
  id: number; sellerId: string; copyId: number; price: number;
  status: "active" | "sold" | "cancelled" | "expired";
  buyerId: string | null; fee: number | null;
  createdAt: string; expiresAt: string; resolvedAt: string | null;
};

type ListingView = {
  id: number;
  sellerId: string;
  seller: UserBrief;
  price: number;
  fee: number | null;           // set once sold
  sellerReceives: number;       // price minus the 5% burned fee
  status: "active" | "sold" | "cancelled" | "expired";
  buyerId: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  copy: HangarCopyView | null;
};

type TradeView = {
  id: number;
  fromUserId: string;
  toUserId: string;
  direction: "incoming" | "outgoing"; // relative to the requesting user
  fromCoins: number;            // coins the sender adds
  toCoins: number;              // coins the sender asks for
  status: "pending" | "accepted" | "declined" | "cancelled" | "countered" | "expired" | "failed";
  parentTradeId: number | null; // set on counter offers
  note: string | null;
  createdAt: string;
  expiresAt: string;
  resolvedAt: string | null;
  fromCopyIds: number[];        // offered by the sender (locked while pending)
  toCopyIds: number[];          // asked of the recipient (not locked)
  fromCopies: (HangarCopyView | null)[]; // null when a copy no longer exists
  toCopies: (HangarCopyView | null)[];
  from: UserBrief;
  to: UserBrief;
};

type LeaderboardEntry = {
  rank: number;
  userId: string;
  user: UserBrief;
  value: number;                // fleet value, rarest copy points, sets completed, or flights in the last 7 days
  rarestCopy?: HangarCopyView | null; // only on board=rarest
};

type PackView = {
  id: number;
  key: string;                  // "economy" | "business" | "first_class" | admin-made keys
  name: string;
  description: string;
  price: number;                // global coins (packs never cost Credits or Miles)
  size: number;
  rarityOdds: Record<Rarity, number>; // normalised fractions summing to 1
  liveryOdds: Record<Livery, number>; // normalised fractions summing to 1
  guaranteeRarity: Rarity | null;      // at least one card of this rarity or better per pack
  pityRarity: Rarity | null;
  pityAfter: number | null;            // pityRarity-or-better guaranteed within this many cards
  pityProgress: number | null;         // this user's cards since their last pityRarity-or-better
  featuredSet: { id: number; key: string; name: string } | null; // Limited packs draw only from this set
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  availableCards: number;              // card types this pack can draw right now
};
```

## User-scoped routes

Base: `/bridge/users/:userId/hangar` (`:userId` = the signed-in user).

### `GET /bridge/users/:userId/hangar`

```ts
type Response = { ok: true; overview: {
  userId: string;
  coins: number;
  parts: number;
  fleetValue: number;
  pilotRank: PilotRankView;
  globalRank: number | null;    // position on the global Fleet Value board
  copies: number;
  distinctCards: number;
  setsCompleted: number;
  mythicsOwned: number;
  flightsFlown: number;
  hangar: { used: number; slots: number; maxSlots: number; expandStep: number; expandCost: number | null };
  boarding: BoardingStatus;
  activeFlights: FlightView[];
  recentPulls: RecentPull[];    // last 5 openings
  showcase: HangarCopyView[];   // up to 3
  trades: { incoming: number; outgoing: number }; // pending counts
  activeListings: number;
} };
```

### `GET /bridge/users/:userId/hangar/collection`

Query (all optional): `rarity` (Rarity), `livery` (Livery), `setId`, `cardType` (`plane`|`airline`), `cardTypeId`,
`locked` (`true`|`false`), `minLevel`, `q` (name search), `sort` (`newest` default, `oldest`, `rarity`, `level`,
`serial`, `name`), `page` (default 1), `pageSize` (default 24, max 60).

```ts
type Response = { ok: true; copies: HangarCopyView[]; total: number; page: number; pageSize: number };
```

### `GET /bridge/users/:userId/hangar/copies/:copyId`

Any copy the user owns; someone else's copy only if its owner shows cards publicly (`showTradingCards` and a
visible profile), it's listed on the market, or it's in a pending trade with the requester. Otherwise 404.

```ts
type Response = {
  ok: true;
  copy: HangarCopyView;
  owner: boolean;               // the requester owns it
  events: { id: number; kind: string; fromUserId: string | null; toUserId: string | null;
            detail: Record<string, unknown> | null; createdAt: string }[]; // newest first, up to 50
  // kinds: mint, gift, trade, market, list, unlist, repaint, level, flight_start, flight_land, salvage
  routes: {                     // owner + plane cards only, else []
    key: RouteKey; label: string; description: string; durationMs: number;
    eligible: boolean; missing: string[]; expectedParts: number; expectedPartsWithOperator: number;
    xp: number; bonusCardChance: number;
  }[];
  listing: ListingRow | null;   // owner only: its active listing
};
```

### `GET /bridge/users/:userId/hangar/catalog`

Query: `includeDisabled=true` to include cards that no longer drop. Rarest first.

```ts
type Response = { ok: true; cards: HangarCardTypeView[] };
```

### `GET /bridge/users/:userId/hangar/packs`

Active packs only (enabled, inside their window).

```ts
type Response = { ok: true; packs: PackView[] };
```

### `POST /bridge/users/:userId/hangar/packs/:packKey/open`

Body: `{ guildId?: string }` (logged on the opening; omit on the website). Burns the price.

```ts
type Response = {
  ok: true;
  pack: { key: string; name: string };
  cost: number;
  balance: number;              // coins after paying
  pityCount: number | null;     // cards since the last pity-rarity card (pity packs only)
  openingId: number;
  copies: OpenedCopyView[];     // in reveal order
  newlyCompletedSets: { setId: number; name: string; bonusParts: number }[];
};
```

Errors: `pack_unavailable`, `empty_pool`, `hangar_full`, `insufficient_coins`.

### `GET /bridge/users/:userId/hangar/boarding`

```ts
type Response = { ok: true; boarding: BoardingStatus };
```

### `POST /bridge/users/:userId/hangar/boarding/claim`

Body: `{ guildId?: string }`. One free card from Economy odds per 24h; every 7th consecutive day also pays 30 Parts.

```ts
type Response = {
  ok: true;
  copies: OpenedCopyView[];
  streak: number;
  streakBonusParts: number;     // 0 or 30
  nextAt: string;
  newlyCompletedSets: { setId: number; name: string; bonusParts: number }[];
};
```

Errors: `cooldown` (vars.nextAt), `hangar_full`.

### `POST /bridge/users/:userId/hangar/salvage`

Body: `{ copyIds: number[] }` (1 to 50, all free and owned). Copies are destroyed; Parts paid.

```ts
type Response = { ok: true; parts: number; balance: number; salvaged: { id: number; cardTypeId: number; serial: number; parts: number }[] };
```

### `POST /bridge/users/:userId/hangar/craft`

Body: `{ cardTypeId: number }`. Spends the card's `craftCost` Parts, mints a Standard copy.

```ts
type Response = { ok: true; copy: HangarCopyView; cost: number; balance: number }; // balance = Parts left
```

### `POST /bridge/users/:userId/hangar/repaint`

Body: `{ copyId: number }`. Burns `repaintCost` coins; re-rolls the livery (80/16/4), never downgrades.

```ts
type Response = { ok: true; copy: HangarCopyView; from: Livery; to: Livery; cost: number; balance: number }; // coins
```

### `POST /bridge/users/:userId/hangar/upgrade`

Body: `{ copyId: number }`. Spends `upgradeCost` Parts for one level.

```ts
type Response = { ok: true; copy: HangarCopyView; cost: number; balance: number }; // Parts left
```

### `POST /bridge/users/:userId/hangar/give`

Body: `{ copyId: number; toUserId: string }`. Not to bots or yourself; the recipient needs a free slot.

```ts
type Response = { ok: true; copy: HangarCopyView };
```

### `POST /bridge/users/:userId/hangar/expand`

Burns 50 coins for 25 more slots (100 base, 500 max).

```ts
type Response = { ok: true; slots: number; cost: number; balance: number };
```

### `PUT /bridge/users/:userId/hangar/showcase` (POST also accepted)

Body: `{ copyIds: number[] }` (0 to 3 owned copies, in display order; `[]` clears).

```ts
type Response = { ok: true; showcase: number[] };
```

### `GET /bridge/users/:userId/hangar/sets`

```ts
type Response = { ok: true; sets: SetProgress[] };
```

### `GET /bridge/users/:userId/hangar/flights`

```ts
type Response = {
  ok: true;
  active: FlightView[];         // unclaimed (in the air or landed)
  recent: FlightView[];         // last 10, any state
  startedToday: number;         // UTC day
  limits: { maxActive: number; maxPerDay: number }; // 3, 12
  routes: { key: RouteKey; label: string; description: string; durationMs: number; parts: number; xp: number;
            bonusCardChance: number; minSafety: number; minSpeed: number; minPassengers: number }[];
};
```

### `GET /bridge/users/:userId/hangar/flights/routes?copyId=`

```ts
type Response = { ok: true; copyId: number; routes: { key: RouteKey; label: string; durationMs: number; eligible: boolean;
  missing: string[]; expectedParts: number; expectedPartsWithOperator: number; xp: number }[] };
```

### `POST /bridge/users/:userId/hangar/flights/start`

Body: `{ copyId: number; route: RouteKey; operatorCopyId?: number | null }`. The plane (and the airline operator, if
given) are locked until the flight is claimed. Each copy flies once per UTC day.

```ts
type Response = { ok: true; flight: FlightView };
```

Errors: `limit`, `cooldown`, `requirements` (vars.missing), `locked`, `invalid` (not a plane / operator not an
airline), `forbidden` (test route).

### `POST /bridge/users/:userId/hangar/flights/claim`

Settles every landed flight. Body: none.

```ts
type Response = { ok: true; parts: number; claimed: (FlightView & { reward: FlightReward })[] };
```

### `GET /bridge/users/:userId/hangar/market`

Browse query (all optional): `rarity`, `livery`, `setId`, `cardTypeId`, `minPrice`, `maxPrice`, `sort` (`newest`
default, `price_asc`, `price_desc`), `page` (default 1), `pageSize` (default 20, max 50).

```ts
type Response = {
  ok: true;
  listings: ListingView[];
  total: number; page: number; pageSize: number;
  feeRate: number;              // 0.05
  floors: Record<Rarity, number>; // minimum price per rarity
  maxListings: number;          // 10 active per user
  listingDays: number;          // 7
};
```

With `mine=true`: the user's own listings (any status, newest 100): `{ ok: true; listings: ListingView[]; total; page: 1; pageSize }`.

### `GET /bridge/users/:userId/hangar/market/:listingId`

```ts
type Response = { ok: true; listing: ListingView };
```

### `POST /bridge/users/:userId/hangar/market/list`

Body: `{ copyId: number; price: number }`. Locks the copy for 7 days.

```ts
type Response = { ok: true; listing: ListingView };
```

### `POST /bridge/users/:userId/hangar/market/:listingId/cancel`

```ts
type Response = { ok: true; listing: ListingView | null };
```

### `POST /bridge/users/:userId/hangar/market/:listingId/buy`

The buyer pays `price` to the seller, the seller's 5% fee is burned, the copy moves. Atomic.

```ts
type Response = { ok: true; listing: ListingView | null; price: number; fee: number; balance: number }; // buyer's coins
```

Errors: `conflict` (already sold), `expired`, `insufficient_coins`, `hangar_full`, `invalid` (own listing).

### `GET /bridge/users/:userId/hangar/trades`

Query: `status` = `pending` (default) or `all`.

```ts
type Response = { ok: true; trades: TradeView[]; limits: { maxItemsPerSide: number; maxPending: number; expiryHours: number } };
```

### `POST /bridge/users/:userId/hangar/trades`

Body: `{ toUserId: string; giveCopyIds?: number[]; wantCopyIds?: number[]; giveCoins?: number; wantCoins?: number; note?: string }`.
At least one card; at most 6 per side; only one side may add coins. Offered copies are locked for 48h.

```ts
type Response = { ok: true; trade: TradeView };
```

### `GET /bridge/users/:userId/hangar/trades/:tradeId`

Only trades the user is part of.

```ts
type Response = { ok: true; trade: TradeView };
```

### `POST /bridge/users/:userId/hangar/trades/:tradeId/accept` | `/decline` | `/cancel` | `/counter`

Accept, decline and counter are for the recipient; cancel is for the sender. Accept re-checks every copy and the
coins and settles atomically (any failure changes nothing and the trade stays pending). Counter body is the same as
creating a trade minus `toUserId`: `{ giveCopyIds?, wantCopyIds?, giveCoins?, wantCoins?, note? }`; the original
becomes `countered` and the response is the new trade (sent the other way, `parentTradeId` set).

```ts
type Response = { ok: true; trade: TradeView };
```

### `GET /bridge/users/:userId/hangar/leaderboard`

Query: `board` (LeaderboardBoard, default `fleet_value`), `limit` (default 25, max 50), `guildId` (optional: that
server's members only; the requester must be a member of it, else 403; 404 if the bot isn't there).

```ts
type Response = { ok: true; board: LeaderboardBoard; guild: { id: string; name: string } | null; entries: LeaderboardEntry[] };
```

## Server dashboard

### `GET /bridge/guilds/:guildId/economy/plane-cards/leaderboard?userId=&board=&limit=`

Manage Server (or superuser) only, like the rest of the economy page. Only members of this guild are ranked.
`board` defaults to `fleet_value`, `limit` to 50 (max 50).

```ts
type Response = { ok: true; board: LeaderboardBoard; guild: { id: string; name: string }; players: number; entries: LeaderboardEntry[] };
```

## Rendered card images (PNG)

Not user-scoped (no `userId`), cacheable (`Cache-Control: private, max-age=3600`).

- `GET /bridge/hangar/render/copy/:copyId.png` (the `.png` is optional): that copy's face with its serial, livery,
  First Edition stamp and level.
- `GET /bridge/hangar/render/type/:cardTypeId.png?livery=standard|gold|prototype&edition=first&level=1..10`: a card
  type's face without a serial (catalog, craft and pack previews).

640x1160 PNG. 404 JSON when the copy/type doesn't exist.

## Public profile

### `GET /bridge/users/:userId/public-profile/cards`

Now enforces the user's `showTradingCards` opt-in (and a visible profile) on the bot side.

```ts
type PublicProfileCard = {
  key: string; name: string; cardType: "plane" | "airline"; rarity: string; subtitle: string; imageKey: string;
  quantity: number;             // copies of this type owned
  firstObtainedAt: string;
  stats: CardStats;
  bestLivery: Livery;
  hasFirstEdition: boolean;
  highestLevel: number;
  renderUrl: string;            // render of their best copy of this type
};
type Response = {
  ok: true;
  visible: boolean;             // false: opted out, everything below is empty
  totalUnique: number;
  totalCards: number;
  fleetValue: number;
  pilotRank: PilotRankView | null;
  setsCompleted: number;
  completedSets: { id: number; key: string; name: string }[];
  showcase: HangarCopyView[];   // up to 3
  rarest: HangarCopyView | null;
  cards: PublicProfileCard[];   // rarest first
};
```

The combined `GET /bridge/users/:userId/public-profile` embeds the same object as `cards`.

## Superuser admin

All require a dashboard superuser: `?userId=` on GET, `"userId"` in the body on writes (403 otherwise).

### Catalog: `/bridge/platform/plane-cards`

- `GET ?userId=` -> `{ ok: true; cards: PlaneCardAdmin[] }`
- `POST` body `{ userId, key, name, cardType: "plane"|"airline", subtitle?, rarity: Rarity, imageKey, safety, printRun?: number|null,
  speed, agility, passengerCount }` (planes) or `{ ..., reputation, fleetSize, destinations }` (airlines) -> `{ ok: true; card: PlaneCardAdmin }`
- `PUT /bridge/platform/plane-cards/:id` body `{ userId, name?, subtitle?, rarity?, imageKey?, enabled?, printRun?: number|null,
  retired?: boolean, safety?, speed?/agility?/passengerCount? | reputation?/fleetSize?/destinations? }` -> `{ ok: true; card }`.
  `printRun` can't go below what's already minted; raising or clearing it un-retires a sold-out card; `retired`
  retires or un-retires by hand.
- `DELETE /bridge/platform/plane-cards/:id` body `{ userId }` -> `{ ok: true; card }` (soft: sets `enabled: false`).

```ts
type PlaneCardAdmin = {
  id: number; key: string; name: string; cardType: "plane" | "airline"; subtitle: string; rarity: string;
  speed: number; agility: number; passengerCount: number; reputation: number; fleetSize: number; destinations: number;
  safety: number; imageKey: string; enabled: boolean;
  printRun: number | null; minted: number; retiredAt: string | null;
  createdBy: string; createdAt: string; updatedAt: string;
};
```

### Art

- `GET /bridge/platform/plane-cards/images?userId=` -> `{ ok: true; files: string[] }` (image keys in `assets/planes/`)
- `POST /bridge/platform/plane-cards/images/upload` body `{ userId, imageBase64: string }` (raw base64 or a
  `data:image/(png|jpeg|webp|gif);base64,` URL, at most 4MB). Re-encoded as PNG (scaled to at most 2400px on a side),
  saved as `u_<hash>.png` -> `{ ok: true; imageKey: string; width: number; height: number; bytes: number }`.
  Use the returned `imageKey` in catalog create/update. Errors `{ error }` 400, 413 for oversized bodies.
- `GET /bridge/plane-cards/image/:imageKey` (unchanged) serves raw art.

### Sets: `/bridge/platform/plane-cards/sets`

```ts
type AdminSet = { id: number; key: string; name: string; description: string; bonusParts: number; enabled: boolean;
                  cardTypeIds: number[]; createdAt: string; updatedAt: string };
type SetInput = { key: string; name: string; description?: string; bonusParts?: number; enabled?: boolean; cardTypeIds?: number[] };
```

- `GET ?userId=` -> `{ ok: true; sets: AdminSet[] }`
- `POST` body `{ userId, ...SetInput }` -> `{ ok: true; set: AdminSet }` (`key` normalised to lowercase-dashes; `conflict` if taken)
- `PUT /sets/:id` body `{ userId, ...Partial<SetInput without key> }` -> `{ ok: true; set }` (`cardTypeIds` replaces the members)
- `DELETE /sets/:id` body `{ userId }` -> `{ ok: true }` (`conflict` while a pack features the set; completion
  records are kept)

### Pack tiers: `/bridge/platform/plane-cards/packs`

```ts
type PackInput = {
  key: string;                  // create only; normalised to lowercase_underscores
  name: string;
  description?: string;
  price: number;                // 0..100000 coins
  size: number;                 // 1..10
  rarityOdds: Partial<Record<Rarity, number>>; // weights, >= 0, total > 0, unknown keys rejected
  liveryOdds?: Partial<Record<Livery, number>>; // default 88/10/2
  guaranteeRarity?: Rarity | null;
  pityRarity?: Rarity | null;   // set together with pityAfter
  pityAfter?: number | null;    // 1..1000
  featuredSetId?: number | null; // Limited pack: draws only from this set
  startsAt?: string | null;     // ISO; window for Limited packs
  endsAt?: string | null;
  enabled?: boolean;
  sortOrder?: number;
};
type AdminPack = {
  id: number; key: string; name: string; description: string; price: number; size: number;
  rarityOdds: Record<Rarity, number>;          // raw weights as stored
  liveryOdds: Record<Livery, number>;
  guaranteeRarity: Rarity | null; pityRarity: Rarity | null; pityAfter: number | null;
  featuredSetId: number | null; startsAt: string | null; endsAt: string | null; enabled: boolean; sortOrder: number;
  normalizedRarityOdds: Record<Rarity, number>; // fractions
  normalizedLiveryOdds: Record<Livery, number>;
  featuredSet: { id: number; key: string; name: string } | null;
  active: boolean;
  availableCards: number;
};
```

- `GET ?userId=` -> `{ ok: true; packs: AdminPack[] }` (every pack, active or not)
- `GET /packs/:id?userId=` -> `{ ok: true; pack: AdminPack }`
- `POST` body `{ userId, ...PackInput }` -> `{ ok: true; pack: AdminPack }`
- `PUT /packs/:id` body `{ userId, ...Partial<PackInput without key> }` -> `{ ok: true; pack }`
- `DELETE /packs/:id` body `{ userId }` -> `{ ok: true }` (the `economy` pack backs the boarding pass and can't be
  deleted, only disabled)
- `POST /packs/preview` body `{ userId, ...PackInput, packs?: number }` (unsaved is fine; `packs` = simulated
  openings, 100..20000, default 5000) simulates against the live card pool:

```ts
type PreviewResponse = { ok: true; preview: {
  availableCards: number;
  packsSimulated: number;
  expectedPartsPerPack: number; // average salvage value of one pack
  expectedPartsPerCard: number;
  rarity: Record<Rarity, number>;   // simulated share (includes guarantee/pity effects)
  livery: Record<Livery, number>;
  configured: { rarity: Record<Rarity, number>; livery: Record<Livery, number> }; // normalised odds
} };
// With an empty pool: { availableCards: 0, packsSimulated: 0, expectedPartsPerPack: 0, expectedPartsPerCard: 0, rarity: {}, livery: {} }
```

Validation errors use the Hangar error shape (`{ ok: false, error, code: "invalid" }`, 400).

### Economy health: `GET /bridge/platform/plane-cards/health?userId=&sinceDays=`

`sinceDays` optional (omit for all time).

```ts
type Distribution<K extends string> = Record<K, { pulls: number; actual: number; expected: number }>; // fractions
type Response = { ok: true; health: {
  since: string | null;
  coins: {
    burned: number;             // pack + market_fee + repaint + hangar_slot
    burnedByKind: Record<string, number>;
    transferred: number;        // coins received through market sales and trades
    transferredByKind: Record<string, number>; // market_sale, trade_in
    netFlow: number;            // sum of all card-system coin movements: always <= 0
  };
  parts: {
    issued: number; issuedByKind: Record<string, number>;  // salvage, flight, set_bonus, boarding_streak, grant
    spent: number; spentByKind: Record<string, number>;    // craft, upgrade
    outstanding: number;        // all Parts balances combined (all time)
  };
  cards: { copies: number; owners: number; mintedByRarity: Record<Rarity, number>; mintedByLivery: Record<Livery, number> }; // live copies
  market: { active: number; sold: number; volume: number; fees: number };
  trades: { pending: number; accepted: number };
  flights: { active: number; claimed: number };
  packs: {
    key: string; name: string; openings: number;
    naturalPulls: number;       // pulls the odds apply to
    forcedPulls: number;        // guarantee/pity pulls (excluded from the rarity distribution)
    rarity: Distribution<Rarity>;
    livery: Distribution<Livery>;
  }[];
} };
```

## Removed

- `GET/PUT /bridge/platform/plane-cards/settings` (single pack price/size): replaced by pack tiers.
- The old sell-for-coins flow (no bridge route existed; the Discord button is gone).
