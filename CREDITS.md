# Credits and licenses

Serve is our own work, built on the open models, libraries and data below. Everything in this repository was built
during the hackathon, except the work listed under "Made before the hackathon".

## Models

| What | Used for | License |
|---|---|---|
| Muse Glimmer (Meta), open weights | Every agent: the Autopilot, agent to agent, matchmaking's requests, the body log, courts near you, captions, the community loop's sentences and specs | Apache 2.0 |
| Ollama | Serves Muse Glimmer on our GPU server | MIT |
| Sapiens2 pose 0.4B (Meta), `facebook/sapiens2-pose-0.4b` | Both players' pose on the highlight frames, on our GPU server | Sapiens2 License |
| SAM 2.1 Hiera-L (Meta), `facebook/sam2.1-hiera-large` | Both players' outlines on the highlight frames, on our GPU server | Apache 2.0 |
| DETR ResNet-50 (Meta), `facebook/detr-resnet-50` | Finds the players in a video the player films, on our GPU server | Apache 2.0 |
| MapAnything (Meta), `facebook/map-anything-apache`, with its code (`facebook/map-anything`'s weights are CC BY-NC 4.0 and are not used) | Metric depth and the camera for the orbit replay prototype (`video/pose/orbit.py`), on our GPU server | Apache 2.0 |
| SAM 2.1 Hiera-L as a video tracker (same weights) | Whether the player is in frame, frame by frame, for the highlight effects (`video/pose/exists.py`) | Apache 2.0 |
| Llama Guard 3 1B (Meta), through Ollama `llama-guard3:1b` | Screens what players write to their agent and what the models write back, on our server's CPU | Llama 3.2 Community License |
| Llama Prompt Guard 2 86M (Meta), `meta-llama/Llama-Prompt-Guard-2-86M` | Flags instructions hidden in text the agents read (reviews, the club's shared ideas), on our server's CPU | Llama 4 Community License |
| DRAMA base (Meta), `facebook/drama-base` | Finds what a player told their agent by meaning (memory), and groups the club's shared ideas, on our server's CPU | CC BY-NC 4.0 (non-commercial use only) |
| Omnilingual ASR CTC 1B (Meta), `omniASR_CTC_1B` | Voice notes and the app's voice input to text, on our server's CPU | Apache 2.0 |
| Kokoro 82M (`kokoro-onnx`) | The demo video's narration | Apache 2.0 |

## Libraries

| What | License |
|---|---|
| React, React DOM | MIT |
| Three.js | MIT |
| Vite, `@vitejs/plugin-react` | MIT |
| Hugging Face Transformers (Python), PyTorch, OpenCV (highlight pose and outlines, on the server) | Apache 2.0, BSD-3-Clause, Apache 2.0 |
| LlamaFirewall (Meta), `llamafirewall` 1.0.3: its AlignmentCheck scanner (prompt, output schema and verdict as shipped), pointed at Muse Glimmer for the goal check before the Autopilot asks for approval and before the reading agent posts (`agent/src/align_worker.py`); with the OpenAI Python client and pydantic it needs | MIT (LlamaFirewall), Apache 2.0 (openai), MIT (pydantic) |

## Perception

| What | Used for | License |
|---|---|---|
| TrackNetV5, by Run-Lin Chang, Yu-Shuen Wang and Jiun-Long Huang, "TrackNetV5: Robust Shuttlecock Tracking via Motion Prompts and Spatiotemporal Attentive Fusion", IEEE ICIP 2026. The user's own earlier published work, made before the hackathon: a dependency, not code made for Serve. [gino6178/TrackNetV5](https://github.com/gino6178/TrackNetV5) at commit `9116161`, with its released weights (`TrackNetV5_best.pt`), fetched by `video/pose/setup_ball.sh` and used as a library by our adapter; none of it is in this repository. | The shuttle, frame by frame, in a badminton video the player films (`video/pose/ball.py`): where it is, when it is hit, when the rally ends | No LICENSE file in its repository (the user's own work) |
| WASB, by Shuhei Tarashima, Muhammad Abdul Haq, Yushan Wang and Norio Tagawa (NTT), "Widely Applicable Strong Baseline for Sports Ball Detection and Tracking", BMVC 2023. Third-party work: [nttcom/WASB-SBDT](https://github.com/nttcom/WASB-SBDT) at commit `923462c`, with its tennis and basketball weights from the Google Drive links in its `MODEL_ZOO.md`, fetched by `video/pose/setup_ball.sh`; none of it is in this repository. | The ball in tennis and basketball videos (`video/pose/ball.py`; the adapter is not finished) | Code: MIT. The weights' own licence is not stated, and they were trained on broadcast footage |

## Assets and data

- **Anatomy model.** BodyParts3D, © The Database Center for Life Science, CC BY 4.0, adapted for the 3D muscle view.
  The adaptations are listed in `web/public/body/ATTRIBUTION.md`, which ships with the model files.
- **Portraits used in an earlier version of the app.** AI-generated images of fictional people, made with Gemini
  (Google). They do not show real people.
- **Sample videos and the demo's match footage**, trimmed and edited, all licensed under
  [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). The licence was checked on each video's page; the players
  are not named in the app. Clips made from them (`web/public/media/samples/`, and the demo feed's
  `web/public/feed/demo_md.mp4` and `demo_ws.mp4`) are marked as such where they appear. The highlight screenshots in
  `submission/shots/web_features/` (`highlights_*`) are made from the singles sample clip, with the camera effect the
  server chose for it.
  - "2012 US Badminton Adult National Championships Men's Doubles Finals HD 1080P" by Roy Huang,
    [YouTube](https://www.youtube.com/watch?v=z_uUFuw7n2Q).
  - "2012 US Badminton Adult National Championships Men's Singles Final 1080P" by Roy Huang,
    [YouTube](https://www.youtube.com/watch?v=eMfNpjUpx8k).
  - "Zmagovalna točka Kaje Stanković za tretji naslov slovenske prvakinje" by Badminton klub Ljubljana,
    [YouTube](https://www.youtube.com/watch?v=IoDl6OirN1A), also on
    [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Zmagovalna_to%C4%8Dka_Kaje_Stankovi%C4%87_za_tretji_naslov_slovenske_prvakinje.webm).
- **Orbit prototype footage.** "Битва Корпораций (5-й сезон) - 2020-06-21 - Бадминтон - Нова Пошта - Бисквит-Шоколад
  (Мужчины)" by savinkins ([YouTube](https://www.youtube.com/watch?v=hVTV7AHIPu8), via
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Битва_Корпораций_(5-й_сезон)_-_2020-06-21_-_Бадминтон_-_Нова_Пошта_-_Бисквит-Шоколад_(Мужчины).webm)),
  CC BY 3.0. The images in `submission/shots/orbit/` are made from it (frames resized, drawn on, or rendered from
  other viewpoints); no video from it is in this repository.
- **Ball-tracking test footage** (in our NAS cache, not in this repository), from Wikimedia Commons:
  "ŽKK Grosuplje, tekma - ženske." and "GROSBASKET - DOMŽALE 07MAR15" by Stasil BURJA (CC BY 3.0); "2026-09-30 A
  Night at the Crotona Park Public Tennis Courts" by NYC Mayor's Office (CC BY 4.0); "YONEX PRESENTS「クルム伊達公子参加！
  TENNIS PLAY＆STAY体験会 午後の部」" by 東レ パン パシフィック オープンテニス (CC BY 3.0). Links are in
  `docs/ball_tracking.md`.
- **Club, venues, town map and members.** Made up for the demo, by us. They include the free slots, prices and home
  areas.
- **Icons and the shuttle mark.** Drawn by us.
- **Map data.** Courts, parks, roads and rivers © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors,
  under the Open Database License, through the Overpass API; place search through Nominatim. Route maps are drawn by
  the app from that data. The sample runs follow a bikeway from it (`video/sample_route.json`).
- **Weather.** Forecasts from [Open-Meteo](https://open-meteo.com), CC BY 4.0.
- **Google Maps.** Ratings (and reviews, where the key's plan includes them) through the Places API, when the server
  has a key: shown with a link to the place on Google Maps, never on another map, and not stored.
- **Sample health export.** Made up by us (`video/sample_health.py`) and labelled as a sample; not a real person's
  record.

## Made before the hackathon

- **TrackNetV5**, our own earlier shuttle tracker (IEEE ICIP 2026), is used as a dependency for the shuttle in
  badminton highlights (see Perception). It is fetched from its public repository at run time; none of its code is in
  this repository. It also prepared a sample match for match-analysis pages in an earlier version of the app; those
  pages were removed on 2026-10-28.

## Meta products

Muse, Muse Glimmer, Muse Spark, SAM, Sapiens, DETR, Facebook, Messenger, Instagram, WhatsApp and Threads are Meta's. The
Facebook, Messenger and Instagram marks appear only on share buttons and "built with" notes. Serve is an independent entry to the
Meta Global AI Developer Hackathon 2026 and is not a Meta product.
