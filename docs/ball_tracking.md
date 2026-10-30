# The ball in your highlights

Serve does not build its own ball detector. `video/pose/ball.py` uses published trackers as libraries, from checkouts
outside this repository, each in its own process, and turns their output into our per-frame form. The ball then gets
the same "is it there" signal as the players (`exists.py`), and the effects use it.

**Status (2026-10-28).**
- **Badminton: measured.** TrackNetV5 ran on the server (GPU 0, nice 19) on the app's three CC BY sample clips.
  Results are below.
- **Tennis and basketball: not run.** The WASB adapter is written (`ball.py --worker wasb`). The permission system
  refused to run it ("Code from External"), so it is untested, and the commands are with the coordinator.
- **The effects use the ball** only where it is "on", and only near the player (below).

## The trackers

| Tracker | Sport | Licence | Use |
|---|---|---|---|
| **TrackNetV5**, Run-Lin Chang, Yu-Shuen Wang and Jiun-Long Huang, IEEE ICIP 2026, [gino6178/TrackNetV5](https://github.com/gino6178/TrackNetV5) | Badminton | **No LICENSE file** in the repository. It is the user's own earlier published work, made before the hackathon. | **Used**, at commit `9116161`, with its released `TrackNetV5_best.pt` (alpha 1.0, threshold 0.30, per its README) |
| **WASB**, Shuhei Tarashima, Muhammad Abdul Haq, Yushan Wang and Norio Tagawa (NTT), BMVC 2023, arXiv 2311.05237, [nttcom/WASB-SBDT](https://github.com/nttcom/WASB-SBDT) | Tennis, basketball | MIT code (`LICENSE.md`, © 2023 NTT Communications). **The weights' own licence is not stated, and they were trained on broadcast footage**: tennis from NCTU's TrackNet dataset, basketball from NBA games (the SAM project). The user approved them. | Fetched, at commit `923462c`; the adapter is not written yet |
| TrackNetV3, Yu-Jou Chen and Yu-Shuen Wang, ACM MM Asia 2023, [qaz812345/TrackNetV3](https://github.com/qaz812345/TrackNetV3) | Badminton | MIT, naming the checkpoints too | Checked as an alternative, then dropped for TrackNetV5. Its checkpoint zip stays in the NAS cache, unused. |

Rejected:
- **TrackNetV4**: its weight links are placeholders.
- **NCTU's original TrackNet and TrackNetV2**: the host no longer resolves.
- **yastrebksv/TrackNet and ChgygLin/TrackNetV2-pytorch**: no licence.
- **GridTrackNet**: unknown provenance.

## Files fetched (all into the NAS cache; none in git)

| File | From | Size | SHA-256 |
|---|---|---|---|
| `TrackNetV5_best.pt`, `TrackNetV5_Lite_best.pt` | `github.com/gino6178/TrackNetV5`, `releases/` at `9116161` | 40.3 MB, 10.2 MB | `cf902528…7198d`, `c7ca025e…e7a07` |
| `wasb_tennis_best.pth.tar` | `drive.google.com/uc?id=14AeyIOCQ2UaQmbZLNQJa1H_eSwxUXk7z` (WASB's `MODEL_ZOO.md`) | 6.1 MB | `9d391239…42b4bb` |
| `wasb_basketball_best.pth.tar` | `drive.google.com/uc?id=1nfECuSyJvPUmz3njZCdFERSQQbERt8FU` (the same) | 6.1 MB | `8d1ba987…b7e948` |
| `TrackNetV3_ckpts.zip` (unused) | `drive.google.com/uc?id=1CfzE87a0f6LhBp0kniSl1-89zaLCZ8cA` (TrackNetV3's README) | 131.7 MB | `8de68d34…71bcc4` |
| The TrackNetV5, WASB-SBDT and TrackNetV3 repositories at their pinned commits | GitHub | | git commits |

`video/pose/setup_ball.sh` repeats all of this, checks each checksum, and runs none of the trackers' code.

## Test footage (CC BY, original uploads; `/mnt/nas/shuttlecoach-meta/media/cc_footage/`, attribution in its `SOURCE.txt`)

| Sport | File | Source | Licence | Size, SHA-1 |
|---|---|---|---|---|
| Badminton | the app's three sample clips (`web/public/media/samples/`), 2,041 frames | Roy Huang; Badminton klub Ljubljana | CC BY 3.0 | see CREDITS.md |
| Basketball | `bb_grosuplje_women.webm`: "ŽKK Grosuplje, tekma - ženske." by Stasil BURJA, [YouTube](https://www.youtube.com/watch?v=9gd9v3aqRHQ), [Commons](https://commons.wikimedia.org/wiki/File:%C5%BDKK_Grosuplje,_tekma_-_%C5%BEenske..webm) | | CC BY 3.0 | 1080p, 164 s, 120.9 MB, `ada4f6d4…` |
| Basketball | `bb_grosbasket_domzale.webm`: "GROSBASKET - DOMŽALE 07MAR15" by Stasil BURJA, [YouTube](https://www.youtube.com/watch?v=GrIEJdnFtTk), [Commons](https://commons.wikimedia.org/wiki/File:GROSBASKET_-_DOM%C5%BDALE_07MAR15.webm) | | CC BY 3.0 | 720p, 819 s, 403.7 MB, `6d56a820…` |
| Tennis | `tn_crotona_park.webm`: "2026-09-30 A Night at the Crotona Park Public Tennis Courts" by NYC Mayor's Office, [YouTube](https://www.youtube.com/watch?v=I6MjEjuMG9k), [Commons](https://commons.wikimedia.org/wiki/File:2026-09-30_A_Night_at_the_Crotona_Park_Public_Tennis_Courts.webm) | | CC BY 4.0 | 1080p, 91 s, 18.1 MB, `ebe24acc…` |
| Tennis | `tn_toray_play_stay.webm`: "YONEX PRESENTS「クルム伊達公子参加！TENNIS PLAY＆STAY体験会 午後の部」" by 東レ パン パシフィック オープンテニス, [YouTube](https://www.youtube.com/watch?v=Cvri9ubis98) | | CC BY 3.0 | 1080p, 35 s, 34.7 MB, `763a30f2…` |

Each SHA-1 matched the one Commons lists for the file.

## What `ball.py` makes of a track

The tracker's own process writes a row per frame: frame, visible, x, y, and its heatmap peak. For TrackNetV5, the
adapter calls its `get_model`, its `Video_IterableDataset` (5 frames: RGB plus the difference from the video's median,
at 512×288) and its `predict_location`. `ball.py` then works out, per frame:
- **p, how sure.** 1 when a neighbouring frame agrees with the position, 0.5 for a lone point (it jumps farther in one
  frame than a smash travels), 0 when nothing was seen.
- **on.** The hysteresis of `exists.py`: a 3-frame median, on at 0.6, off below 0.4, and a change must last 3 frames.
  A lone point never switches the ball on; its position is dropped and refilled from its neighbours.
- **Hits.** The ball turns more than 50° within 0.13 s either side, at least 0.3 s apart. With the reel, each goes to
  the player whose wrist is nearest.
- **The rally's end.** The last frame the ball is there before it is gone for a second, or before it lies still for
  half a second.

Output (also `reel.py`'s `ball` field when `BALL_TRACKING=1`):
`{fps, w, h, sport, tracker, frames: [0..n-1], ball: {x, y, p, on, peak, reel_xy}, hits: [{frame, turn_deg, who}], rally_end}`.
Use `reel_xy` (the reel's pixels), and follow the ball only where `on` is true.

**Checked on a synthetic track** (a shuttle going back and forth every 30 frames, with a false point and a dropout):
all 12 hits were found at the right frames, the false point gave no hit and was refilled, the dropout turned the ball
off, and the rally's end was exact. This tests our code, not the trackers.

## What the effects do with it

- **The moment.** The freeze moves to the ball's turn nearest your swing, within 0.3 s: that is when you hit it.
- **The cut.** It goes out 0.4 s after the rally's end when that comes within 3 s of the moment.
- **The zoom.** On the way into the moment, the camera leans toward the incoming ball (at most halfway, so the player
  stays in the picture), and it settles on the hit. It follows the ball only on frames where it is "on".

## Measured: badminton (TrackNetV5 on phone-style footage)

The app's three sample clips are 2,041 frames from the stands, at 1280×720 and 30 fps. One run, scored on every 20th
frame (101 frames, `video/pose/labels/ball_labels.json`, scored by `video/pose/ball_check.py`):
- **Each point TrackNetV5 gave.** Judged by eye on a 4× crop: its offset to the shuttle, or "not the shuttle".
- **Each frame with no point.** A miss if the rally was in play then (from the stands the whole court is in view, so
  a shuttle in play is in frame), else a true negative. The in-play intervals were set by eye.
- **A hit** is a point within 10 px at 720p (4 px at 512×288, as in TrackNetV5's own evaluation).

| Signal | Precision | Recall | Position error (hits) |
|---|---|---|---|
| TrackNetV5's points | 0.40 (19 of 48) | 0.31 | median 1.4 px, mean 2.0 px |
| `ball.py`'s "on" (hysteresis, lone and still points dropped) | 0.39 | 0.31 | median 1.4 px |

When TrackNetV5 finds the shuttle, it is exact. On this footage it often doesn't, and it often marks a head or a lamp
in the stands instead. From the stands the shuttle is 2–4 px, smaller than in the broadcast footage it was trained
on. Hits come too often (24 in 22 s on one clip), because a point jumping between spectators looks like a turn.

So the effects take the ball only where it can't mislead:
- **The freeze** moves to a ball turn only when that turn is within one player-height of the racket hand.
- **The zoom** leans toward the ball only within 1.5 player-heights of the player.
- **Otherwise** they fall back to the pose, as before.

The two bugs the first runs showed are fixed. A point dropped as a lone one could still be "on" with no position
(the TypeError). And a 2 s dropout early in a rally read as the rally's end (frame 9); the end is now the end of the
last stretch of at least 0.3 s where the ball is there. On the three clips the rally ends at frames 699, 629 and 639.

Tennis and basketball are not measured: their one run waits on permission to run WASB.
