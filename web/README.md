# Serve: the web app

Serve is a self-evolving sports social platform. Its agent does the hassle that stops people playing (it finds the
court and the people, agrees the game with the other players' agents, and asks you only for a yes), and what the club
asks for becomes proposals: a safe setting ships behind a flag and rolls itself back if it does harm, and anything
else waits for a person. This folder is its web
app, built with React, Three.js and Vite, in laptop, tablet and phone layouts, light and dark.

The agent gateway is in `../agent` and the server scripts are in `../server`. The project's README, with the judges'
summary and how everything is measured, is `../README.md`.

Meta Global AI Developer Hackathon 2026 · Indie Developer track · Build for Your World

## Pages

| Page | What it shows |
|:---|:---|
| Agent (home) | Your agent's three helpers (Body, Match, Talk), what needs you, and what your agent did, step by step |
| Autopilot (`#/autopilot`) | Your week planned against a goal, each step marked as the model's choice or code, with its trace |
| Play (`#/play`) | Say what you want to play; the options, each partner with the band their agent gave ("likely") |
| Club (`#/club`) | The feed, the leaderboard, challenges, a random match, your best match, and the Ideas tab, where the club's requests become proposals |
| Goals (`#/goals`) | Social goals for the week |
| Body (`#/body`) | Your body log on a 3D body, your health-app import, your activity trail and the body report |
| Courts (`#/courts`) | Courts and parks near you in any ball sport, judged from the map, reviews and the forecast |
| Highlights (`#/highlights`) | A highlight reel cut from a video you film yourself (or a sample clip), with an optional camera effect |
| Messages (`#/messages`) | Your agent in Facebook Messenger |
| Memory (`#/memory`) | What your agent remembers on your server, and the notes kept in this browser |
| Maintain (`#/maintain`) | The maintainer's review of the club's proposals and flags (needs the maintainer's token) |

"Ask out loud" is the mic in the agent's box: the browser records a short clip and your own server writes it down
(Meta's Omnilingual ASR, `POST /api/asr`); the words fill the box for you to check and send.

## Where the models run

The web app calls no model itself. Muse Glimmer, Llama Guard 3, Prompt
Guard 2, DRAMA, Omnilingual ASR, DETR, Sapiens2 and SAM 2.1 run behind the gateway on our server
(`../README.md`, "How it uses Meta AI").

## Running it

~~~sh
npm install && npm run dev
~~~

Open http://127.0.0.1:5191. `.env.local` sets `VITE_AGENT_URL` (the gateway, port 8790 on the GPU server) and
`VITE_AGENT_TOKEN` (its token). The Ideas tab and the maintainer page show hand-written sample data until you add
`?loop=live`, which reads the gateway instead.

## Left out of this repository

These are not ours to publish:

| Where it goes | What it is |
|:---|:---|
| `public/body/body.json`, `body.bin` | The 3D muscles and skeleton, taken from BodyParts3D 4.0 |

## Credits and licenses

- The 3D body (left out of this repository): BodyParts3D 4.0 (© The Database Center for Life Science, under CC BY
  4.0), adapted through [Human Atlas](https://github.com/ashemag/human-atlas), which is MIT-licensed.
- The full list, with licenses: `../CREDITS.md`.
