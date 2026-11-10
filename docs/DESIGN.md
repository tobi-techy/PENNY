# Penny: design

How Penny looks, talks and behaves. Read `IDEA.md` first for the why.

Penny is **iMessage-first**. There is no feed, no dashboard, no tab bar to learn. The conversation is the interface and the card is the proof.

---

## 1. Principles

1. **Chat is the interface, cards are the proof.** The agent answers in one short line, then shows the real thing: the quote, the transfer, the bill it found.
2. **Nothing acts silently.** Every money move or action in your name (a post, an email, a new bot with write tools) is a card, needs Face ID, and shows its steps and its receipt.
3. **One card, updated in place.** A move does not spam the thread with five messages. The same card goes from ask to approving to approved to done.
4. **Buttons name the outcome.** "Approve with Face ID" on a card whose big number is the amount. Never "Submit" or "Confirm".
5. **No naked numbers.** "$38 of $100 this week", "up $32 since Monday", "due Fri".
6. **One colour, one meaning.** Each card type owns one art colour. Status colours are never decoration.
7. **Short words.** Agents text like people. One line, lowercase for Penny, no jargon. "Delegate action" never appears in the UI.
8. **Nothing for its own sake.** Every element on a card earns its place or goes.

## 2. Where Penny lives

| Surface | Role |
|---|---|
| **iMessage thread** with Penny's number | Everything. Asks, replies, cards, receipts. |
| **Penny iMessage extension** (SwiftUI) | Draws the live cards in the thread and does Face ID signing. |
| **Penny host app** (small) | Enrollment (pair your phone), limits, connected tools, revoke device. Nothing else. |
| **Picture link card** | For anyone without the app: a link whose preview is the card (rendered on our server), opening our page. Same look, passkey (checked on our server) instead of the on-device key. Penny sends a fresh card when it changes. |

## 3. Conversation design

### Voice by agent
- **Penny**: warm, a bit cheeky, lowercase. "got you. invest has an idea."
- **Invest**: curious, opinionated, honest about risk. "ETH's been steady. I'd go balanced, not bold, for a first $50."
- **Guard**: dry and calm. Says no without lecturing. "That's a new address and over your cap. Not today."
- **Mail / Finance**: tidy and brief. "Your DStv bill is in. $18.40, due Friday."

**No decorative emoji.** Penny uses none unless the user sent one first, and never on money or card messages. Check marks and envelopes are words, not symbols.

### Rhythm of a move
1. User text.
2. One-line reply, sometimes one line of thinking ("checking your cap first…").
3. Optional crew line when it matters (Guard: "$38 of $100 used this week").
4. The card.
5. After approval, the card edits itself. A short closing line only when there is something to say ("done. it's in. I'll tell you sunday how it's doing.").

### Tapbacks and moods
Moods come from events, never from the model's whims.

| Mood | Trigger | Shows as |
|---|---|---|
| idle | nothing going on | neutral wording |
| thinking | plan being built | "…" line, slow dither on card art |
| win | a move settled, a goal hit | ❤️ tapback on your message, brighter art |
| wink | a playful ask, a nice save | cheekier wording, no emoji unless they used one |
| blocked | Guard said no | red card, calm wording |
| paused | you paused an agent or a limit is hit | quiet wording, no suggestions |
| done | task closed | settled card art (calmer, green tint) |

Mood changes words, tapbacks and card art only. It never changes a limit, a route or an approval.

## 4. The card system

### Anatomy (every card)
```
┌──────────────────────────────────────┐
│  dithered art (88pt, type colour)     │  ← mood moves the dither
│  (●) crew chip on its brand tile      │
├──────────────────────────────────────┤
│  TAG · mono               meta right  │  e.g. BUY        quote 0:28
│  One line in plain words              │  "Balanced Majors"
│  $50.00                               │  big number, Geist
│  ─────────────────────────────────    │  hairline
│  Route        USDC → ETH via Intents  │  1–2 fact rows
│  Guard        $38 of $100 this week   │
│  [ Approve with Face ID ]             │  one white pill
└──────────────────────────────────────┘
```

### Tokens
| Token | Value |
|---|---|
| Card background | `#080D14` |
| Border | `#1E2A38`, 1pt |
| Radius | 18pt |
| Ink | `#F1F5FA` |
| Meta | `#B1C3D8` |
| Hairlines | white 10% / 7% |
| Button | white pill, 38pt high, ink text |
| Art height | 88pt, Bayer 4×4 dither |
| Type | Geist (text, numbers), Geist Mono (tags, meta, timers) |

### Art colours (one per card type)
| Type | Colour | Face ID |
|---|---|---|
| Invest | blue `#6EA1D6` | yes |
| Pick a portfolio | blue `#6EA1D6` | no (choice only) |
| Send | green `#4FD57F` | yes |
| Pay a bill | orange `#FEA247` | yes |
| Request / split | purple `#B77DF8` | no (nudge only) |
| Errand | pink `#FA78B2` | yes |
| Guard block | red `#FC5855` | "Not me" / "Allow once" |
| Weekly check-in | mint `#8FE4CC` | no (read-only) |
| Write (post, email or message as you) | indigo `#8B8CF0` | yes |
| New bot | amber `#E8C766` | yes if it has write or money tools |

A bot's own cards use the bot's colour once it exists; the amber "new bot" card is the ask to create it.

### Crew tiles (chip on card, avatar in host app)
Penny `#FF6B2C` · Invest `#6CCBFF` · Mail `#FFE45C` · Guard `#F6A8F0` · Finance `#5EE3A1`.

### States (money cards)
| State | Pill | Card |
|---|---|---|
| Ask | "Approve with Face ID" | quote timer counting down |
| Approving | "Approving…" with spinner | Face ID sheet over Messages |
| Approved | "Approved" | steps tick: quote ✓, Guard ✓, swap ✓, deposit ✓ |
| Done | "View order" | calmer art, settled amount, time |
| Expired | "Get a new card" | timer at 0:00, art desaturated |
| Declined | none | "You said no. Nothing moved." |
| Blocked | "Not me" / "Allow once" | red art, Guard's reason in one line |

Rules:
- Only money-moving cards ask for Face ID.
- A card never shows a button it cannot honour (expired quotes swap the pill).
- Steps tick in place with mono timestamps. No new messages for each step.

## 5. Key flows

### First run (enrollment)
1. You text Penny. Penny: "hey, I'm penny. I help with the everyday stuff — inbox, bills, errands, money, the lot. Tap this to link your iPhone."
2. The link opens the host app with the code filled in (8 characters, 10 min, works once). No app yet? Install first, then tap again; typing the code also works.
3. Phone makes your key behind Face ID. Penny creates `you.penny.near` with that key as the only full-access key.
4. Penny: "you're set. your keys live on your phone, not with me."

### Invest
Pick a portfolio card → tap one → Invest card → Face ID → steps → done. If the quote expires, the pill becomes "Get a new quote".

### Guard block
Guard card replaces the money card. "Not me" freezes the agent and asks you to review. "Allow once" needs Face ID and logs it.

### Create a bot
1. "make me a bot that runs my X"
2. Penny: "on it. here's who I'd make."
3. New bot card: name, one-line soul, tools with their risk (Read / Can post / Can spend), limits.
4. Read-only bots: "Create". Bots with write tools: "Create with Face ID". Money is off unless you set a cap.
5. The new bot introduces itself in its own voice in the thread.

### Weekly check-in (Sunday)
Mint card with the week in one sentence, one number, one suggestion. Penny adds a line about what it learned and links the soul changelog.

## 6. Host app (companion)

Same dark system as the cards. Four screens only:
1. **Pair**: enter code, Face ID, done.
2. **Limits**: per-move cap, daily cap, allowlist. Changing a limit needs Face ID.
3. **Crew**: your bots, their tools and caps, pause or remove.
4. **Device**: this phone's key, revoke, re-pair.

## 7. Brand

- Mark: a lowercase **p** that is also a chat bubble and a face.
- Lead colour copper `#FF6B2C`. Ink `#111519`. Cream `#F7F3EA`.
- Crew by shape: Penny p, Invest triangle, Finance squircle, Mail envelope, Guard shield.
- Wordmark: Geist Bold, lowercase.
- Brand shows in avatars, chips and the app icon. Cards stay in the dark system.

## 8. Copy rules

- Amounts always with symbol and two decimals on cards ($50.00), natural in chat ($50).
- Times in the user's zone, short ("due Fri", "2 min ago").
- Never say "transaction", "delegate action", "gas", "nonce" in the UI. Say "move", "approve", "fee".
- Errors say what happened and what to do: "Quote expired. Tap for a fresh one."
- Guard never lectures. One reason, one way out.

## 9. Accessibility

- Every card has a VoiceOver label that reads the whole sentence ("Invest. Buy Balanced Majors for fifty dollars. Quote expires in 28 seconds. Approve with Face ID.").
- Dither art is decorative and hidden from VoiceOver.
- Contrast: ink on card ≥ 12:1, meta ≥ 7:1.
- Dynamic Type up to XXL without clipping the big number.
- Face ID fallback to device passcode, as iOS provides.

## 10. Design files

- `design/card/card.html`: the single card in four states (approved).
- `design/card/family.html`: the ten card types (approved).
- `brand/assets/`: mark and crew SVGs.
- Renders: `penny-card-v1.png`, `penny-card-family-v1.png`.
