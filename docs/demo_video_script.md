# Serve: Meta hackathon demo video script (3:00)

Meta Global AI Developer Hackathon 2026 · Indie Developer track · Build for Your World

The video follows the judging criteria in order: **Impact** (the pain point and what Serve does about it, 30%), the
product working live (**Demo**, 25%), **Use of Meta AI tooling** (exactly which Meta models and products do what,
25%), and **Technical depth** (the architecture and the measured numbers, 20%). Narration is `video/narration.json`,
voiced by Kokoro on the GPU server; scenes are recorded from the running app by `video/record.mjs` and cut to the
narration by `video/assemble.mjs`. Every model wait shown is real; long waits are sped up and the video says so.

## Before recording

- Start the server side (`~/shuttlecoach-meta/up.sh`). Run the app with `npm --prefix web run dev`.
- No broadcast footage: the highlight scene uses a clip of our own game (`HIGHLIGHT_CLIP` in `video/record.mjs`).
- The Messenger scene is built from the end-to-end test's real conversation (`agent/test/e2e.mjs` writes it,
  `video/make_pocket.py` turns it into `video/scenes/pocket.html`).

## Scenes and narration

| # | Criterion | Screen | Narration |
|---|---|---|---|
| 1 | Impact | "31% of adults don't get enough exercise" (WHO, 2024), then the pains: a time for four, a free court, someone to push us | Thirty-one percent of adults don't get enough exercise. Most of us don't stop liking our sport. We stop organizing it. Serve is a sports club app whose agent does the organizing for you, built on Meta's open Muse Glimmer model. |
| 2 | Demo | Autopilot: Run my week; the tool steps stream in (check week, body log, partners), the agents' threads, the approval, Book | Ask it to line up your week. Muse Glimmer runs it as an agent, one tool at a time: it checks your week and your body, picks the times you usually play, and ranks the people you play best with. Then it negotiates with their agents, three at once for doubles. Every time, court and trip comes from code. And nothing is booked until you say yes. |
| 3 | Demo | Body log: type the knee, the marker on the 3D body, the sample health export read, what the agent does, the trail and route map, the report | Tell it what hurts. Muse Glimmer files it on your body: right knee, three out of five. Share your health app, and it links your watch to your games. This week's load is twice your usual, so it plans doubles, shorter games and one game fewer. It checks in after two days, and says when it is worth seeing a physio. It records; it never diagnoses. |
| 4 | Demo | Courts near you: basketball tonight; the steps (map, reviews, forecast, judged); a court card and its reasons | Any ball sport works. Ask for basketball courts tonight. It searches the map and the forecast, and Muse Glimmer judges every court at once, citing the map, a review or the weather for each reason. |
| 5 | Demo | Messenger on a phone: the week approved with a tap, what hurts, a health export shared, the check-in with buttons | It lives in Messenger too. Approve the week with one tap, answer the check-in about your knee, or share your health export right into the chat. |
| 6 | Demo | Film a highlight: your own clip, read by DETR, Sapiens2 and SAM 2.1 on your server, your moment in slow motion, the caption, share | After the game, film a rally. On your own server, Meta's DETR finds you, Sapiens2 reads your pose and SAM 2.1 cuts you out. So your smash replays in slow motion. Muse Glimmer writes the caption. One tap, and it's on Instagram or Facebook. |
| 7 | Demo | The club: leaderboard, best match, agent to agent | Your club becomes a game, with a leaderboard that every challenge moves. Your agent finds your best match. Then it talks to their agent until both agree a time and a court. |
| 8 | Meta AI | About page: what it is built on (Muse Glimmer, Sapiens2, SAM 2.1, DETR, Messenger, Instagram and Facebook) | Under the hood, every agent is Muse Glimmer, Meta's open-weights model, on our own GPU: four requests in parallel, with native tool calling. Meta's DETR, Sapiens2 and SAM 2.1 read the video, and Messenger, Instagram and Facebook connect your friends. |
| 9 | Technical | About page: the architecture diagram (agents, models, checks), the measured numbers | One gateway runs every agent, and every number, quote and tool call is checked by code before you see it. (The measured result of the Autopilot evaluation.) |
| 10 | | End card | Serve. Play more, manage less. |
