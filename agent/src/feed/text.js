// What code checks in the feed's text, besides the guard models:
//   people's posts and comments: no phone numbers, email or home addresses, and nothing about another member's health
//   or private life (a name of someone else next to an injury, a diagnosis or where they live);
//   what Muse Glimmer writes about a paper: its own words (no run of 7 words from the abstract, little of its phrasing), 60 words or so,
//   2 or 3 sentences, no advice, no doses or diagnoses, no links, and only numbers the abstract gives.
const WORD = /[a-z0-9]+/g;
const words = (t) => String(t || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(WORD) || [];

// what a person typed, as the feed keeps it: no control characters, at most two blank lines in a row, trimmed
export function tidy(text, max) {
  const t = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return max ? t.slice(0, max) : t;
}

// contact details: an email address, a phone number (8 or more digits, with spaces, dots or dashes between), a home
// address in English or Chinese
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const PHONE = /(?:\+?\d[\s().-]*){8,}/;
const ADDRESS = /\b\d{1,5}[a-z]?\s+(?:[a-z]+\s+){0,3}(street|st|road|rd|avenue|ave|lane|ln|alley|boulevard|blvd|drive|dr)\b|[一-鿿]{1,6}(路|街|大道)[一-鿿\d]{0,8}(段|巷|弄|號|号)|\b(lives|living|stays) (at|on|in)\b|\b(home|house|flat|apartment) address\b/i;
export function contact(text) {
  const t = String(text || "");
  return EMAIL.test(t) || PHONE.test(t.replace(/\b(19|20)\d{2}-\d{2}-\d{2}\b/g, "")) || ADDRESS.test(t);
}

// health and private life, as words: what a post may say about its own author, never about someone else
const PRIVATE = /\b(injur\w*|surger\w*|operated on|torn|sprain\w*|fractur\w*|broke (his|her|their)|diagnos\w*|illness|sick\w*|disease\w*|pregnan\w*|therap\w*|physio\w*|medicat\w*|meds|pills|antidepress\w*|antibiotics?|hospital\w*|doctors?|rehab\w*|depress\w*|anxiety|mental health|mri|scans?|x-?rays?|acl|mcl|meniscus|concussion\w*|back pain|pain\w*|sore|aches?|knees?|ankles?|achilles|hamstrings?|tendon\w*|ligaments?|blood pressure|heart rate|phone number|(his|her|their) number|address|lives (at|in|on|near)|salary|divorce\w*|password)\b|受傷|開刀|手術|膝|腳踝|生病|住在|電話|地址/i;
// another person named in a text: any word of their name, three letters or more, that is not an everyday word
const COMMON = new Set(["park", "rose", "may", "will", "ivy", "sam", "min", "bo", "art", "jay", "kai", "lee", "chen", "wu"]);
export function namesIn(text, names = []) {
  const t = ` ${words(text).join(" ")} `, out = new Set();
  for (const n of names) {
    const parts = words(n);
    if (parts.length > 1 && t.includes(` ${parts.join(" ")} `)) { out.add(n); continue; }
    if (parts.some((w) => w.length >= 3 && !COMMON.has(w) && t.includes(` ${w} `))) out.add(n);
  }
  return [...out];
}
// the problems code finds in what a person posts (author: their own name, which may be about themselves)
export function personProblems(text, { author = null, names = [] } = {}) {
  const bad = [];
  if (contact(text)) bad.push({ code: "contact", why: "it has a phone number, an email or a home address. Share those in a direct message instead." });
  const mine = new Set(words(author));
  const others = namesIn(text, names.filter((n) => !words(n).every((w) => mine.has(w))));
  if (others.length && PRIVATE.test(text)) bad.push({ code: "private", why: "it shares another member's health or private details. Let them share it themselves." });
  return bad;
}

// ---- what a model wrote about a paper ----
const ADVICE = /\b(you|players?|athletes?|coaches?|everyone|readers?|people) (should|must|need to|ought to|can try)\b|\bshould (be|try|do|avoid|use|aim|consider|include|add|take|start|stop)\b|\b(we|i) (recommend|suggest|advise)\b|\brecommend\w*|\badvis\w*|\bprescri\w*|\bmake sure\b|\baim for\b|\bbe sure to\b|\btry (to|doing|adding|this)\b|\bit is (best|important|wise) to\b|\bthe best way to\b|\bconsider (adding|doing|taking|using)\b|\b(dose|dosage|doses)\b|\b\d+\s?(mg|mcg|g|kg|ml|reps?|sets?|times a week|minutes a day|min a day|per day)\b|\b(treat|treats|treating|cure|cures|heal|heals)\b|\bdiagnos\w*/i;
export const advice = (t) => ADVICE.test(String(t || ""));
const LINK = /https?:\/\/|www\.|\b[\w-]+\.(com|org|net|io|ly|me|app|dev|info|xyz|tw)\b|@\w{2,}/i;
export const hasLink = (t) => LINK.test(String(t || ""));
export const sentences = (t) => (String(t || "").replace(/\b(e\.g|i\.e|et al|vs|approx|ca)\./gi, "$1").match(/[^.!?]+[.!?]+(\s|$)/g) || []).length;

// numbers as a text gives them (1,200 is 1200; 3.5% is 3.5)
const numbersOf = (t) => (String(t || "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => +x.replace(/,/g, "")).filter(Number.isFinite);
// a number in the summary that the abstract does not give (counts up to ten are fine: "two groups")
export function strayNumbers(text, source, extra = []) {
  const have = new Set([...numbersOf(source), ...extra.map(Number)]);
  return numbersOf(text).filter((n) => !have.has(n) && !(Number.isInteger(n) && n <= 10));
}
// copied: a run of 7 words from the abstract, or more than 30% of its 4-word phrases
export const RUN = 7;
export function copied(text, source) {
  const s = words(source), t = words(text), grams = (xs, n) => { const out = new Set(); for (let i = 0; i + n <= xs.length; i++) out.add(xs.slice(i, i + n).join(" ")); return out; };
  const sr = grams(s, RUN), s4 = grams(s, 4), t4 = [...grams(t, 4)];
  for (let i = 0; i + RUN <= t.length; i++) if (sr.has(t.slice(i, i + RUN).join(" "))) return { copied: true, why: `a run of ${RUN} words from the abstract` };
  const share = t4.length ? t4.filter((g) => s4.has(g)).length / t4.length : 0;
  return share > 0.3 ? { copied: true, why: `${Math.round(share * 100)}% of its phrases are the abstract's` } : { copied: false, share: +share.toFixed(2) };
}
// every problem with a paper summary, in words the model can fix
export function summaryProblems({ summary, forWhom }, abstract, { year = null, names = [] } = {}) {
  const bad = [], all = `${summary} ${forWhom}`;
  const n = sentences(summary), w = words(summary).length;
  if (summary.length < 80) bad.push("the summary is too short");
  if (w > 75 || summary.length > 480) bad.push(`the summary has ${w} words; write 60 at most`);
  if (!/[.!?]["”’)]?$/.test(summary)) bad.push("the summary stops in the middle of a sentence");
  if (n < 2 || n > 3) bad.push(`the summary has ${n} sentences; write 2 or 3`);
  if (numbersOf(summary).length > 3) bad.push("it has too many numbers; keep the one or two that matter");
  if (forWhom && (forWhom.length > 90 || words(forWhom).length > 14)) bad.push("say who might enjoy it in 10 words at most");
  if (advice(all)) bad.push("it gives advice or a prescription; only say what the study found");
  if (hasLink(all)) bad.push("it has a link or a handle");
  const stray = strayNumbers(all, abstract, year ? [year] : []);
  if (stray.length) bad.push(`it has numbers the abstract does not give (${stray.slice(0, 3).join(", ")})`);
  const c = copied(summary, abstract);
  if (c.copied) bad.push(`it copies the abstract (${c.why}); use your own words`);
  if (namesIn(all, names).length) bad.push("it names a member of the club");
  if (!forWhom || forWhom.length < 8) bad.push("say who in the club might find it interesting");
  return bad;
}

// the problems with an agent's answer about a paper, in words the model can fix
export function answerProblems(text, abstract, { year = null } = {}) {
  const bad = [], w = words(text).length;
  if (w > 65 || text.length > 440) bad.push(`it has ${w} words; answer in 50 at most`);
  if (!/[.!?]["”’)]?$/.test(text)) bad.push("it stops in the middle of a sentence");
  if (hasLink(text)) bad.push("it has a link");
  const stray = strayNumbers(text, abstract, year ? [year] : []);
  if (stray.length) bad.push(`it has numbers the abstract does not give (${stray.slice(0, 3).join(", ")})`);
  const c = copied(text, abstract);
  if (c.copied) bad.push(`it copies the abstract (${c.why}); use your own words`);
  return bad;
}

// why a person's post was not shown, in plain words, from Llama Guard's categories
const PLAIN = {
  S1: "it reads as a threat of violence", S2: "it reads as planning a crime", S3: "it has sexual content", S4: "it has content that sexualises children",
  S5: "it could be read as a false claim about a real person", S7: "it shares someone's private information", S9: "it reads as a threat of violence",
  S10: "it reads as hateful", S12: "it has sexual content", S13: "it is about elections, which the club feed leaves out",
};
export const plainWhy = (cats = []) => cats.map((c) => PLAIN[c]).filter(Boolean)[0] || "the safety check flagged it";
// the club's own standard (deps.standard, read by Muse Glimmer), and why a text did not meet it
export const STANDARD = {
  threat: "it reads as a threat or as intimidating someone", harassment: "it reads as harassing or insulting someone", sexual: "it makes a sexual remark or request to someone",
  hate: "it demeans a group of people", privacy: "it hunts for or reveals where someone lives or can be found", spam: "it reads as spam",
};
