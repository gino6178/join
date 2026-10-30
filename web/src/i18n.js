// The website in English or Chinese (Traditional). tr("English text") gives the Chinese when the page is in Chinese
// and the dictionary has it, else the English, so a missing entry shows English rather than nothing. The language is
// the browser's at first (zh-* gives Chinese) and the person's choice after that, kept in this browser; switching
// reloads the page. Sentences Join writes on the server (the activity log) stay in English.
const KEY = "join.lang";
const saved = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
export const lang = saved || (/^zh/i.test(navigator.language || "") ? "zh" : "en");
export const setLang = (l) => { try { localStorage.setItem(KEY, l); } catch {} location.reload(); };

const ZH = {
  // menu
  "Activity": "動態", "What the agents did": "agent 做了什麼", "Plans": "計畫", "Deals, payments, bookings": "成交、付款、預約",
  "Map": "地圖", "Venues and alternatives": "場地與替代選擇", "Limits": "上限", "What your agent may spend": "agent 能花多少",
  "Connect": "連接", "Your agents' access": "你的 agent 權限", "Venue view": "場地端", "A venue's rooms and courts": "場地的場次與房間",
  "No agent? Ask Join's": "沒有 agent？問 Join 的", "Ask Join's agent": "問 Join 的 agent", "Sign out": "登出",
  "PayPal sandbox": "PayPal 沙盒（測試金）", "PayPal simulated: no money moves": "PayPal 模擬：不會動到錢",
  // page heads
  "Everything the agents did for you, as it happens. Join writes each line from the facts; nothing here was written by an AI.": "agent 幫你做的每一步，即時顯示。每一行都由 Join 根據事實寫成，沒有一句是 AI 寫的。",
  "Each deal your agent made, and how it is being paid.": "你的 agent 談成的每筆交易，以及付款進度。",
  "What your agents may commit you to. Join refuses anything over these before a venue sees it. Only you can change them, here.": "你的 agent 最多能替你答應多少。超過的，Join 在場地看到之前就會擋下。只有你能在這裡修改。",
  "Connect your agent": "連接你的 agent", "Receipt": "收據",
  "What a venue sees: its courts, rooms or tables, with the bookings Join's agents made. Dashed: held while the group pays. Solid: paid and locked.": "場地看到的畫面：它的場地、包廂或桌位，以及 Join 的 agent 訂下的預約。虛線：大家付款中，先保留。實線：已付清鎖定。",
  // activity
  "Plan something with friends.": "跟朋友約點什麼吧。", "Plan something": "開始規劃", "Use my own agent": "用我自己的 agent",
  "Tell Join's agent what you'd like to do, or bring your own agent. Every step, whoever takes it, shows up here.": "告訴 Join 的 agent 你想做什麼，或帶你自己的 agent 來。每一步，不論誰做的，都會顯示在這裡。",
  "Open the plan": "打開計畫", "everyone paid": "全員已付", "Searches": "搜尋",
  // plans
  "Deal": "成交", "Guaranteed": "已擔保", "Paid and locked": "已付清鎖定", "Played": "已打完", "Venue paid": "已付給場地",
  "Player": "成員", "Pays": "要付", "Status": "狀態", "How": "方式", "You": "你", "organizer": "發起人",
  "invited, no answer yet": "已邀請，尚未回覆", "in · held in PayPal": "已加入 · PayPal 預先授權", "paid": "已付",
  "waiting for approval": "等待核准", "didn't pay (covered)": "沒付（已代墊）", "declined": "不參加", "refunded": "已退款",
  "PayPal sandbox test card": "PayPal 沙盒測試卡", "approved in PayPal": "在 PayPal 核准", "saved PayPal, by the agent": "已存的 PayPal，agent 代付",
  "Cancel booking": "取消預約", "Keep it": "維持原價", "Agree": "同意",
  "Demo: play your friends": "示範：扮演你的朋友", "Each button is what that friend's own agent would do. Logged as a demo step.": "每個按鈕就是那位朋友自己的 agent 會做的事，會被記錄為示範步驟。",
  "Pays (sandbox card)": "付款（沙盒卡）", "Pays (saved PayPal)": "付款（已存的 PayPal）", "Asks $1 less": "要求少付 $1", "Can't come": "不能來",
  "Time runs out now (you cover whoever hasn't paid)": "現在截止（沒付的由你代墊）",
  "Reviews open after the game.": "打完之後才能評價。", "Demo: review it now": "示範：現在評價", "Signed authorizations (AP2)": "簽章授權（AP2）",
  "Receipts:": "收據：", "receipt: paid and locked": "收據：已付清鎖定", "receipt: venue paid": "收據：已付給場地", "receipt: refunded": "收據：已退款",
  "The negotiation": "議價過程", "venue's ask": "場地開價", "your agent's offer · the venue's floor is never shown": "你的 agent 出價 · 場地底價不會公開",
  // limits
  "Most for one booking (your share)": "單次預約上限（你那一份）", "Most in one week": "每週上限", "Most your agent may guarantee for a group": "agent 可替整團擔保的上限",
  "Your agent aims for this a person, and Join refuses anything above it.": "agent 會以這個金額為每人目標，超過的 Join 會擋下。",
  "Save limits": "儲存上限", "Saved. Your agents see the new limits on their next step.": "已儲存。你的 agent 下一步就會看到新上限。",
  "Venues": "場地", "Any venue": "任何場地", "Only these:": "只限這些：",
  // map
  "Venue": "場地", "Your booking": "你的預約", "Over your budget": "超出預算", "Alternative": "替代選擇", "Public place": "公共場所",
  "Show around me": "顯示在我附近", "Back to the sample town": "回到示範城鎮", "Alternatives": "替代選擇",
  "When your agent's deal is over your budget, the alternatives Join offered appear here.": "agent 談的價格超出預算時，Join 提供的替代選擇會出現在這裡。",
  // sign-in
  "Sign in": "登入", "New here? Make a demo account": "第一次來？建立示範帳號", "Your first name": "你的名字", "Start": "開始",
  "Or be one of the demo town's residents": "或扮演示範城鎮裡的居民", "For AI agents": "給 AI agent",
  // more
  "Where you live": "你住哪一區", "Any district": "任一區", "Friends' crew code (optional)": "朋友圈代碼（選填）", "Friends who type the same crew code are invited to each other's plans first.": "輸入同一個朋友圈代碼的朋友，揪團時會優先互相邀請。",
  "Demo: don't want to wait for the game?": "示範：不想等到打完？", "End the game now (the venue is paid)": "現在結束比賽（付款給場地）",
  "Badminton, karaoke, an escape room, board games, a barbecue, hot pot: Join is the marketplace AI agents come to. They find who is free, negotiate the price with the venue, split the cost and settle it with PayPal, inside the limits you set. No agent? Join's website agent asks what you want and does it for you. Join keeps the rules and shows you everything an agent did.": "羽球、唱歌、密室逃脫、桌遊、烤肉、火鍋：Join 是 AI agent 來辦團的市集。它們找出誰有空、跟場地議價、分攤費用，再用 PayPal 結清，全都在你設的上限之內。沒有 agent？Join 網站上的 agent 會問你想做什麼，幫你搞定。Join 管規則，也讓你看到 agent 做的每一步。",
  "Why not just split it on Venmo afterwards? Because someone has to book and pay first. Here the venue is paid only when the money is real: the organizer guarantees it in PayPal, each friend pays their own share, and anyone who said yes and didn't pay gets a PayPal invoice. Nobody chases anyone.": "為什麼不事後再分帳？因為總得有人先訂、先付。在這裡，錢到位了場地才算數：發起人先用 PayPal 擔保，每位朋友付自己那份，說好要來卻沒付的人會收到 PayPal 帳單。沒有人需要去追錢。",
  "Claude, or any MCP or A2A agent, with a token only you can make.": "Claude，或任何支援 MCP、A2A 的 agent，用只有你能建立的 token 連進來。",
  "Set your limits": "設定你的上限",
  "Per booking, per week, which venues. Agents can read them, never change them.": "每次預約、每週、哪些場地。agent 只能讀，不能改。",
  "Watch it work": "看它怎麼做",
  "Every search, offer, counter-offer and payment, as it happens.": "每一次搜尋、出價、還價和付款，即時呈現。",
  "Counts your shares, and anything you actually paid for friends who didn't pay, less what they paid you back.": "計入你自己的份額，以及你替沒付的朋友實際代墊、扣掉他們已還你的部分。",
  "When you organize, you guarantee the whole price until your friends pay; you pay your own share unless someone doesn't. Above this amount, you approve the guarantee yourself in PayPal.": "你當發起人時，要先擔保全額，直到朋友們付款；正常只付自己那份，有人沒付才由你補。超過這個金額，要你自己在 PayPal 核准擔保。",
  "Venues are round pins (click one for what it offers, or to plan there); squares are free public places such as park courts and picnic grills (first come, not bookable); blue circles are people's home areas, never addresses.": "圓形是場地（點一下看它提供什麼，或直接在那裡規劃）；方形是免費的公共場所，例如公園球場和烤肉區（先到先用，不能預約）；藍色圓圈是大家住的大概區域，不是地址。",
  "Runs on Join's own server": "在 Join 自己的伺服器上執行",
  "Runs on Join's own server, with a small language model for free-form sentences · no outside AI service": "在 Join 自己的伺服器上執行，自由句子交給一個小型語言模型 · 不用外部 AI 服務",
  "Join's agent": "Join 的 agent",
};
export const tr = (s) => (lang === "zh" && ZH[s]) || s;
