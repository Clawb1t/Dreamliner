# Anime plugin

Random neko images from [Nekos.best](https://nekos.best), with a personal saved collection per member.

## Commands

| Command | Description |
|---|---|
| `/anime neko` | Fetch a random neko image. Replies with the image as a real attachment, an artist credit, and a **Save** button. |
| `/anime saved` | Browse your saved nekos, one at a time, with **Left** / **Unsave** / **Right** buttons. |

## How it works

- `/anime neko` calls the nekos.best `neko` endpoint, downloads the image, and attaches it directly rather than
  linking or embedding it. The reply is plain text (no embed): the artist credit line, then a Nekos.best attribution
  subtext line.
- The **Save** button saves that image to the clicker's own collection (`anime_saved_nekos`, one row per member per
  image, capped at 100). It reads the artist credit straight off the message it's attached to, so it still works
  after a bot restart.
- `/anime saved` and its nav buttons always re-read the member's current saved list from the database, so
  unsaving mid-browse immediately reflects in the remaining pages.

## Permissions

Member defaults (`>=0`) can use both `/anime neko` and `/anime saved`.
