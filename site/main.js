/*
  What: the page's behaviour: the top bar's background, sections fading in
        as they are scrolled to, the typed-in new issue, the copy button and
        the workflow demo.
  Why:  the demo is the page's main argument. Walking an issue through its
        steps, and watching it stop and wait at yours, explains the product
        faster than any paragraph.
  Design notes:
    - Plain browser JavaScript, no dependencies, loaded with "defer". The
      page is complete without it; this file only adds to it. It marks
      <html> with the class "js" first, which is what lets styles.css hide
      the fade-in elements only when something will show them again.
    - The demo's steps, wording and paths per size mirror the product
      (shared/standard-workflow.ts and specs/PRD.md in the Airbender
      repository). If the product's workflow changes, change STEPS and
      PATHS here and the nine <li> in index.html.
    - The demo shows the path on the main branch, where accepting goes
      straight to the commit. The "Apply" step (choosing between Commit and
      Commit & merge) exists only on another branch and is left out.
  Gotchas:
    - Agent steps move on by themselves after AGENT_MS. Every way of
      changing step goes through show(), which cancels the pending timer,
      so a click during an agent step cannot be overtaken by a stale one.
*/

document.documentElement.classList.add("js");

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── Top bar ─────────────────────────────────────────────────────────
   Gives the bar a background once the page is scrolled, so it stays
   readable over the content. Post-condition: toggles "is-stuck" on it. */
const nav = document.querySelector("[data-nav]");
if (nav) {
  const onScroll = () => nav.classList.toggle("is-stuck", window.scrollY > 24);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

/* ── Fade in on scroll ───────────────────────────────────────────────
   Each [data-reveal] element gets "is-in" the first time a tenth of it is
   on screen, and is then left alone. Without IntersectionObserver
   everything is shown at once. */
const revealed = document.querySelectorAll("[data-reveal]");
if ("IntersectionObserver" in window && !reducedMotion) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        entry.target.dispatchEvent(new CustomEvent("reveal"));
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.1 },
  );
  revealed.forEach((el) => observer.observe(el));
} else {
  revealed.forEach((el) => el.classList.add("is-in"));
}

/* ── The typed-in new issue (journey 1) ──────────────────────────────
   Types the title held in data-typer into the field, once, when its
   journey scrolls into view. Words starting with # or $ are the tags that
   set type, priority and category; they are drawn in bold as they appear.
   With reduced motion the finished text already in the HTML is kept. */
const typer = document.querySelector("[data-typer]");
if (typer && !reducedMotion) {
  const full = typer.dataset.typer;

  /** Draws the first `length` characters of the title, tags in bold. */
  const draw = (length) => {
    typer.replaceChildren();
    // Split keeps the spaces as their own parts, so the text is rebuilt exactly.
    for (const part of full.slice(0, length).split(/(\s+)/)) {
      if (/^[#$]/.test(part)) {
        const tag = document.createElement("b");
        tag.textContent = part;
        typer.append(tag);
      } else {
        typer.append(part);
      }
    }
  };

  const journey = typer.closest("[data-reveal]");
  journey?.addEventListener("reveal", () => {
    let length = 0;
    draw(0);
    const tick = () => {
      length += 1;
      draw(length);
      if (length < full.length) setTimeout(tick, 38);
    };
    setTimeout(tick, 500);
  });
}

/* ── Copy the install command ────────────────────────────────────────
   Copies the text of [data-copy-source] and says so on the button for two
   seconds. Where the clipboard is not available (an insecure origin, an
   old browser) the command is selected instead, ready for Ctrl+C. */
const copyButton = document.querySelector("[data-copy]");
const copySource = document.querySelector("[data-copy-source]");
if (copyButton && copySource) {
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(copySource.textContent.trim());
      copyButton.textContent = "Copied";
    } catch {
      window.getSelection().selectAllChildren(copySource);
      copyButton.textContent = "Selected";
    }
    setTimeout(() => (copyButton.textContent = "Copy"), 2000);
  });
}

/* ── The workflow demo (journey 2) ───────────────────────────────────── */

/** How long an agent's step is shown before the demo moves on, in ms. */
const AGENT_MS = 2600;

/**
 * The steps each size takes, in order. S has no separate definition or
 * plan; M has definition and plan together, reviewed once; L is every step.
 */
const PATHS = {
  s: ["not-started", "define", "implement", "agent-review", "human-review", "commit"],
  m: ["not-started", "define", "review-plan", "implement", "agent-review", "human-review", "commit"],
  l: ["not-started", "define", "review-definition", "plan", "review-plan", "implement", "agent-review", "human-review", "commit"],
};

/** What the size selector says under it. */
const SIZE_NOTES = {
  s: "Small: one evident way to do it, little to get wrong. Done in one go, with one stop for you, at the end.",
  m: "Medium: worth agreeing on before building. You review the definition and the plan together, once, then the result.",
  l: "Large, risky or unclear: every step. You review the definition, then the plan, then the result.",
};

/**
 * One entry per step, plus "closed" for the end of the path.
 *   label   the step's name, as on its tag
 *   who     "you" or "agent": whose move it is
 *   msg     what the conversation shows; a function of the size where it differs
 *   ask     the status line above the message box
 *   actions your buttons, on your steps only: [label, where it goes]
 *           where "next" and "back" are relative to the size's path
 */
const STEPS = {
  "not-started": {
    label: "Not started", who: "you",
    msg: "Nothing has happened yet. The issue is one line you typed. Press play and the agent reads it, reads the code it touches, and sizes it.",
    ask: "Start when you are ready.",
    actions: [["▶ Start", "next"]],
  },
  define: {
    label: "Define", who: "agent",
    msg: (size) => ({
      s: "Sized S: there is one evident way to fix this and little to get wrong. No separate definition or plan. I will write a short description and get to work.",
      m: "Sized M: worth agreeing on before I build. I am writing the definition and the plan together, so you review both once.",
      l: "Sized L: this touches payments. Before anything else, one question: must old coupons keep working? I will wait for your answer, then write up what is wanted, why, and what done means.",
    })[size],
    ask: "The agent is defining the issue.",
  },
  "review-definition": {
    label: "Review definition", who: "you",
    msg: "The definition is on the issue: what is wanted and why, how it works today, what is out of scope, and four checks a person can verify.",
    ask: "Please review the definition and give feedback.",
    actions: [["Approve definition", "next"], ["Send back", "back"]],
  },
  plan: {
    label: "Plan", who: "agent",
    msg: "Working out how: which files, in what order, what is risky, how I will check it, and what I rejected and why. It goes onto the issue, not into the chat.",
    ask: "The agent is planning the work.",
  },
  "review-plan": {
    label: "Review plan", who: "you",
    msg: (size) => size === "m"
      ? "Definition and plan are ready together. One function will own the order of discount and shipping, with a test for each combination. Nothing is built yet."
      : "The plan is on the issue. One function will own the order of discount and shipping, with a test for each combination. Nothing is built yet.",
    ask: "Please review what is planned and give feedback.",
    actions: [["Approve plan", "next"], ["Send back", "back"]],
  },
  implement: {
    label: "Implement", who: "agent",
    msg: "Building it. No workflow buttons while I work: there is nothing for you to decide yet.",
    ask: "The agent is doing the work.",
  },
  "agent-review": {
    label: "Agent review", who: "agent",
    msg: "Reviewing my own work against the checks on the issue before it reaches you, and writing down what I checked and what I could not.",
    ask: "The agent is reviewing its work.",
  },
  "human-review": {
    label: "Human review", who: "you",
    msg: "Ready for you. Totals are computed in one place now; six tests cover every coupon and shipping combination. Not checked: the mobile layout.",
    ask: "Please review the results and give feedback.",
    actions: [["Accept & commit", "next"], ["Send back", "back"]],
  },
  commit: {
    label: "Commit", who: "agent",
    msg: "You accepted, so now, and only now, I commit: one commit, only this issue's files, its id and title in the subject.",
    ask: "The agent is committing the work.",
  },
  closed: {
    label: "Closed", who: "you",
    msg: "Committed as a65fef0 “shop-7h1: Cart total wrong with coupon + free shipping”. The issue closed itself the moment its work was in git.",
    ask: "Done. Nothing is waiting for you.",
    actions: [["↺ Walk it again", "restart"]],
  },
};

const demo = document.querySelector("[data-demo]");
if (demo) {
  const track = demo.querySelector("[data-track]");
  const items = [...track.querySelectorAll("[data-step]")];
  const out = {
    msg: demo.querySelector("[data-demo-msg]"),
    chip: demo.querySelector("[data-demo-chip]"),
    ask: demo.querySelector("[data-demo-ask]"),
    hint: demo.querySelector("[data-demo-hint]"),
    actions: demo.querySelector("[data-demo-actions]"),
    count: demo.querySelector("[data-demo-count]"),
    note: demo.querySelector("[data-size-note]"),
    screen: demo.querySelector(".demo__screen"),
  };
  const sizeButtons = [...demo.querySelectorAll("[data-size]")];

  let size = "l";
  let current = "not-started";
  let timer = null;

  /** The step after `id` on the current size's path; "closed" after the last. */
  const after = (id) => {
    const path = PATHS[size];
    return path[path.indexOf(id) + 1] ?? "closed";
  };

  /**
   * The step a "Send back" returns to: the agent's work step before `id`
   * on the current size's path.
   */
  const before = (id) => {
    const path = PATHS[size];
    for (let i = path.indexOf(id) - 1; i > 0; i -= 1) {
      // Agent review is not where rework happens; go back to the work itself.
      if (STEPS[path[i]].who === "agent" && path[i] !== "agent-review") return path[i];
    }
    return path[1];
  };

  /**
   * Shows one step: the track, the conversation, the status line and your
   * buttons.
   * Pre-condition: `id` is on the current size's path, or is "closed".
   * Post-condition: `current` is `id`; any pending automatic move is
   * cancelled, and a new one is scheduled if the step is the agent's.
   */
  const show = (id) => {
    clearTimeout(timer);
    current = id;
    const step = STEPS[id];
    const path = PATHS[size];
    const position = id === "closed" ? path.length : path.indexOf(id);

    for (const item of items) {
      const index = path.indexOf(item.dataset.step);
      item.classList.toggle("is-skipped", index === -1);
      item.classList.toggle("is-done", index !== -1 && index < position);
      item.classList.toggle("is-on", index === position);
      item.querySelector("button").setAttribute("aria-current", index === position ? "step" : "false");
    }

    out.msg.textContent = typeof step.msg === "function" ? step.msg(size) : step.msg;
    out.chip.textContent = step.label;
    out.ask.textContent = step.ask;
    out.hint.textContent = step.who === "you" ? "Your move." : "The agent is working…";

    out.actions.replaceChildren();
    (step.actions ?? []).forEach(([label, go], index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = index === 0 ? "mbtn mbtn--main" : "mbtn";
      button.textContent = label;
      button.addEventListener("click", () => {
        if (go === "next") show(after(id));
        else if (go === "back") show(before(id));
        else show(PATHS[size][0]);
      });
      out.actions.append(button);
    });

    // Replay the small entrance, so a change of step is seen.
    out.screen.classList.remove("is-swapping");
    void out.screen.offsetWidth;
    out.screen.classList.add("is-swapping");

    if (step.who === "agent") timer = setTimeout(() => show(after(id)), AGENT_MS);
  };

  /**
   * Switches the size: marks its button, rewrites the note and the count of
   * your stops, and starts the path again from the first step (a step in
   * play may not exist on the new path).
   */
  const setSize = (next) => {
    size = next;
    for (const button of sizeButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.size === size));
    }
    out.note.textContent = SIZE_NOTES[size];
    // Your stops are your steps after the start: the reviews.
    const stops = PATHS[size].filter((id) => STEPS[id].who === "you").length - 1;
    out.count.textContent = stops === 1
      ? "You are asked once on this path."
      : `You are asked ${["", "", "twice", "three times"][stops]} on this path.`;
    show(PATHS[size][0]);
  };

  sizeButtons.forEach((button) => button.addEventListener("click", () => setSize(button.dataset.size)));
  items.forEach((item) => item.querySelector("button").addEventListener("click", () => show(item.dataset.step)));
  setSize(size);
}
