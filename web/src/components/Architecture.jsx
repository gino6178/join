// The system, as built: what runs where, which Meta model does what, and the checks every answer passes. Drawn in SVG
// with the app's tokens, so it reads in light and dark and prints sharp (the README and the video use a render of it).
// Rows line up: each agent sits level with the model or data it calls, so every arrow runs straight.
const YOU = 20, ZONE = 332, L = 348, R = 630, BW = 270, GPU = 970, GW = 250;
const W = 1240, H = 724;

function Box({ x, y, w, h, title, lines = [], kind = "", tag }) {
  return (
    <g className={`ar-box ${kind}`}>
      <rect x={x} y={y} width={w} height={h} rx="12" />
      <text x={x + 14} y={y + 24} className="ar-t">{title}</text>
      {tag && <text x={x + w - 12} y={y + 24} className="ar-tag" textAnchor="end">{tag}</text>}
      {lines.map((l, i) => <text key={i} x={x + 14} y={y + 46 + i * 18} className="ar-l">{l}</text>)}
    </g>
  );
}
const Arrow = ({ x1, x2, y, label, kind = "" }) => (
  <g className={`ar-arrow ${kind}`}>
    <path d={`M${x1},${y} H${x2}`} markerEnd="url(#ar-head)" />
    {label && <text x={(x1 + x2) / 2} y={y - 7} className="ar-al" textAnchor="middle">{label}</text>}
  </g>
);

export default function Architecture({ className = "" }) {
  return (
    <svg className={`arch ${className}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Serve's architecture: the app and Messenger talk to the Serve gateway on your own GPU server, whose agents run on Muse Glimmer and Meta's vision models, with every answer checked by code">
      <defs>
        <marker id="ar-head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="ar-headp" /></marker>
      </defs>

      {/* you */}
      <text x={YOU} y={30} className="ar-col">You</text>
      <Box x={YOU} y={44} w={230} h={112} title="Serve app" tag="React" lines={["Agent, Autopilot, Club, Play", "Body log, Courts, Highlights", "phone to desktop"]} />
      <Box x={YOU} y={172} w={230} h={112} title="Messenger" tag="Meta" kind="meta" lines={["your agent in your chats", "approve games with a tap", "photos, voice notes, files"]} />
      <Box x={YOU} y={300} w={230} h={94} title="Health app export" lines={["Apple Health, Google Fit", "GPX, TCX, CSV"]} />
      <Box x={YOU} y={410} w={230} h={94} title="Your video" lines={["any ball sport", "filmed on your phone"]} />
      <Box x={YOU} y={520} w={230} h={94} title="Instagram, Facebook" tag="Meta" kind="meta" lines={["your reel and its caption,", "shared by you"]} />
      <Arrow x1={YOU + 230} x2={ZONE - 4} y={100} label="HTTP, live steps" />
      <Arrow x1={YOU + 230} x2={ZONE - 4} y={228} label="webhook" />
      <Arrow x1={YOU + 230} x2={ZONE - 4} y={347} label="upload" />
      <Arrow x1={YOU + 230} x2={ZONE - 4} y={457} label="upload" />
      <Arrow x1={ZONE - 4} x2={YOU + 234} y={567} label="reel" />

      {/* the gateway */}
      <text x={ZONE} y={30} className="ar-col">Serve gateway · Node.js on your GPU server</text>
      <rect x={ZONE} y={40} width={580} height={676} rx="18" className="ar-zone" />
      <Box x={L} y={56} w={BW} h={170} title="Autopilot" tag="tool loop" kind="agent" lines={["Muse Glimmer picks each step:", "get_week · check_body", "find_partners · find_places", "negotiate · request_approval", "nudge · finish (12 steps max)", "rules finish if it stalls"]} />
      <Box x={R} y={56} w={BW} h={170} title="Agent to agent" tag="A2A v1.0" kind="agent" lines={["an A2A agent per member,", "each with its Agent Card", "all answer at once, and say", "which times work: one round", "facts only, saved each round", "the agreed time is held"]} />
      <Box x={L} y={240} w={BW} h={150} title="Body log" tag="body" kind="agent" lines={["what hurts, read by a tool call", "health app linked to games", "load: this week vs usual", "limits, check-ins, physio flag"]} />
      <Box x={R} y={240} w={BW} h={150} title="Courts near you" tag="places" kind="agent" lines={["courts and parks on the map", "Google Maps reviews", "the forecast at that hour", "4 judged at once, reasons cited"]} />
      <Box x={L} y={404} w={BW} h={130} title="Club and Play" tag="social" kind="agent" lines={["leaderboard, challenges", "best match, random match", "booking with every calendar", "habits, who you click with"]} />
      <Box x={R} y={404} w={BW} h={130} title="Highlights" tag="reel" kind="agent" lines={["find you, read your pose,", "cut you out, find the moment:", "smash, shot, jump or kick", "caption checked vs the rallies"]} />
      <Box x={L} y={548} w={R + BW - L} h={152} title="Checked by code before anyone sees it" kind="verify" lines={["numbers must be in their facts; a review quote must be in that review", "tools run in code with checked arguments; times, courts and trips come from code", "agents trade checked facts, never prose; every model call is traced and counted", "no he or she; a text that fails is redrafted, or a template or rules speak instead", "nothing is booked without your yes; video, voice and health stay on your server"]} />
      <Arrow x1={L + BW} x2={R - 2} y={140} />
      <g className="ar-arrow"><path d={`M${L + 135},226 V238`} markerEnd="url(#ar-head)" /></g>

      {/* models and data, each level with the agent that calls it */}
      <text x={GPU} y={30} className="ar-col">Meta models on your server</text>
      <Box x={GPU} y={44} w={GW} h={182} title="Muse Glimmer" tag="open weights" kind="meta" lines={["Meta's open-weights model", "Ollama, GPU 1 (RTX 3090)", "4 requests in parallel", "tools, JSON Schemas, vision", "every agent's decision,", "every judgement and summary"]} />
      <text x={GPU} y={256} className="ar-col">Open data</text>
      <Box x={GPU} y={266} w={GW} h={44} title="OpenStreetMap" tag="courts, maps" />
      <Box x={GPU} y={318} w={GW} h={44} title="Open-Meteo" tag="the forecast" />
      <Box x={GPU} y={370} w={GW} h={44} title="Google Places" tag="reviews, keyed" />
      <Box x={GPU} y={430} w={GW} h={164} title="Vision" tag="GPU 0" kind="meta" lines={["DETR: finds the people", "Sapiens2: reads the pose", "SAM 2.1: cuts each one out", "batched, the last two bf16,", "about 0.3 s a frame"]} />
      <Box x={GPU} y={608} w={GW} h={92} title="Omnilingual ASR" tag="CPU" kind="meta" lines={["voice notes to text,", "about 3 s a note"]} />
      <Arrow x1={R + BW} x2={GPU - 4} y={140} label="chat, tools" kind="meta" />
      <g className="ar-arrow"><path d={`M${R + BW},300 H${GPU - 22} M${GPU - 22},288 V392 M${GPU - 22},288 H${GPU - 4} M${GPU - 22},340 H${GPU - 4} M${GPU - 22},392 H${GPU - 4}`} /></g>
      <Arrow x1={R + BW} x2={GPU - 4} y={470} label="frames" kind="meta" />
    </svg>
  );
}
