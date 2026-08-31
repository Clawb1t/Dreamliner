# Trading card images

Drop card art here as plain image files (`.png`, `.jpg`, `.jpeg`, `.webp`, or `.gif`) — for both
plane cards and airline cards, they share this same folder.

When you run `/planesadmin add_plane`, `/planesadmin add_airline`, or `/planesadmin edit`, set
`image_key` to the exact file name, e.g. `a350.png`. The bot reads the file straight from this
folder and attaches it to the card, no external hosting or CDN needed.

File names are matched exactly (case-sensitive on Linux hosts) and can't contain `/`, `\`, or `..`.
