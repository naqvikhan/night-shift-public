# Design decisions, simplified

Night Shift had a clear brief: a group sitting around one table, every phone a secret card, one phone running the night, and nothing to install. Most of the choices below follow from that.

## The big picture

| Need | Choice | Why, in one line |
| --- | --- | --- |
| Join instantly, any phone | A web page, not an app | A link and a 4-letter code are all anyone needs |
| A place for each game to live | Cloudflare Workers + Durable Objects | Each room gets its own tiny server, created on demand and gone when it's done |
| Phones update instantly | WebSockets | The server pushes the new screen the moment the host taps |
| Undo, reconnects, testing | The game is an event log | Replaying a list of events is simple to reason about and to rewind |
| No cheating | The server builds each phone's view | A player's phone never receives anyone else's role |
| Privacy | No accounts, rooms auto-delete | Nothing personal is kept after the game |

## Hosting: Cloudflare Workers and Durable Objects

A **Cloudflare Worker** is a small piece of code that runs on Cloudflare's network, close to the player, without managing a server. Night Shift uses one Worker for two jobs: it serves the web page, and it handles the `/api/rooms` requests.

A **Durable Object** is a single instance of a class that Cloudflare keeps in exactly one place, with its own storage. Night Shift makes one per room, named after the room code. Every phone in that room connects to the same object, so there's one source of truth and no syncing between servers.

Why this instead of a regular server and database? A party game has many small, short games happening at once, and each one only matters to the people at one table. "One small server per room" fits that exactly. There's no server to keep running, no database to clean up, and it fits within Cloudflare's free plan at party-game traffic.

## Networking: WebSockets

Each phone opens one **WebSocket**, a connection that stays open so the server can push messages at any time. Messages are tiny JSON objects. Phones send `join`, `hello` (rejoining) and, for the host, `cmd` (a game action). The room replies with `view`, meaning "here is your screen".

Rooms use Cloudflare's **WebSocket Hibernation**. While everyone is talking and nobody taps anything, the room sleeps and costs nothing, but the connections stay open. Keep-alive pings are answered automatically without waking the room.

## Game state: an event log

The game is stored as the dealt roles plus a list of events:

```
kill → save → check → dawn → trial → kill → …
```

To draw any screen, the code replays the list from the start. This gives three things almost for free:

- **Undo** is removing events from the end of the list.
- **Reconnecting** needs nothing special: the phone just asks for its current view, which is recalculated from the log.
- **Testing** is easy, because any game can be rebuilt from its events and compared.

## Fairness: each phone gets its own view

The server never sends the whole game to a phone. It builds a view per seat: your role, your teammates if you're Mafia, your past checks if you're the Detective, and nothing else. The host's phone gets the full picture because the host runs the night. Even someone reading their browser's developer tools can't find another player's role.

## Reliability on real phones

- **Seat tokens.** Joining gives the phone a random token, saved in the browser. If the phone locks or the page reloads, it reconnects to the same seat and card.
- **Host recovery code.** If the host's phone dies, a 6-letter code lets another phone take over hosting.
- **Stale-tap guard.** Each host command includes how many events the host's screen knew about. If that's out of date, for example after a double tap or a slow network, the server refuses it.
- **Automatic reconnect.** The phone pings every 20 seconds and retries with a growing delay if the connection drops.

## Safety and privacy

- **No accounts.** Names exist only inside a room.
- **Rooms delete themselves** 4 hours after the last activity, or straight away when the host closes the room.
- **Wrong-code limit.** A separate tiny object per network counts wrong room codes. After 10 in 5 minutes that network has to wait, so codes can't be guessed by brute force.
- **Only this site can connect**, and very large messages are ignored.

## Front end: no framework

The phone screens are plain JavaScript and CSS with no framework. The app has a handful of screens driven by one state object, so a simple "state in, HTML out" render was enough, and it keeps the page small and quick to load on a phone. All the artwork is drawn in code as SVG, so day and night is just a CSS switch. That code is private, but the screenshots show the result.

## Settings without new rules

Internally there are always four roles (`mafia`, `doctor`, `police`, `citizen`) and two sides. A setting only renames them and changes the wording, which is how one engine runs Mafia, Werewolf and a Bengali Chor Police edition. This repo includes The City; the other two are private.

## Testing

The tests drive the real room code through fake phones. The strongest one plays 200 random games and undoes each at random points, checking that every phone's screen goes back to exactly what it was. That test is what makes the event-log design trustworthy.
