// Sharing: to the club feed (kept in this browser with the rest of the club game) and to Meta's apps through their
// public share links. Only text leaves the app; footage is shared only when the player downloads and posts it.
import { patchGame } from "./game.js";

export const shareLinks = (text) => ({
  whatsapp: `https://wa.me/?text=${encodeURIComponent(text)}`,
  threads: `https://www.threads.net/intent/post?text=${encodeURIComponent(text)}`,
});
export function postToClub(item) {
  try {
    patchGame((s) => ({ ...s, mine: [{ id: `p-${Date.now()}`, who: "you", at: Date.now(), ...item }, ...(s.mine || [])].slice(0, 40) }));
    return true;
  } catch { return false; }
}
