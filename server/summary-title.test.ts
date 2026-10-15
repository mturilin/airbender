// server/summary-title.test.ts — tests for the AI-written conversation title.
//
// What: checks the prompt, the cleanup of a model reply into one title, the
// reading of a Gemini reply, and which backend settings are missing.
//
// Why: a reply that is not cleaned well ends up verbatim in the sidebar
// (bead-bb-du7).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backendProblem,
  buildPrompt,
  buildShortNamePrompt,
  cleanTitle,
  fallbackShortName,
  geminiOutputText,
  selectMessages,
  type BackendConfig,
  type ConversationMessage,
} from "./summary-title.ts";

test("cleanTitle strips labels, quotes, thinking and trailing punctuation", () => {
  assert.equal(cleanTitle('Title: "Fix flaky login test".', 60), "Fix flaky login test");
  assert.equal(cleanTitle("<think>hmm</think>\n\n**Add dark mode toggle**\nextra", 60), "Add dark mode toggle");
  assert.equal(cleanTitle("# New title – Migrate DB to Postgres", 60), "Migrate DB to Postgres");
  assert.equal(cleanTitle("   \n  ", 60), null);
});

test("cleanTitle cuts long titles at a word boundary", () => {
  const title = cleanTitle("Refactor the authentication middleware to support OAuth device flow", 40);
  assert.ok(title !== null && title.length <= 40, String(title));
  assert.equal(title, "Refactor the authentication middleware");
});

test("selectMessages keeps the first user goal plus the recent tail", () => {
  const messages: ConversationMessage[] = Array.from({ length: 30 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    text: `m${i}`,
  }));
  const picked = selectMessages(messages);
  assert.equal(picked[0]?.text, "m0");
  assert.equal(picked.at(-1)?.text, "m29");
  assert.equal(picked.length, 17);
});

test("buildPrompt includes the current title and limits", () => {
  const prompt = buildPrompt({
    currentTitle: "Old title",
    messages: [{ role: "user", text: "make a plugin" }],
    latestAssistantText: "done",
    maxLength: 50,
  });
  assert.match(prompt, /Current title: "Old title"/u);
  assert.match(prompt, /At most 50 characters/u);
  assert.match(prompt, /\[user\] make a plugin/u);
  assert.match(prompt, /<latest-assistant-reply>\ndone/u);
});

test("geminiOutputText reads model_output steps", () => {
  const body = {
    steps: [
      { type: "thought", signature: "x" },
      { type: "model_output", content: [{ type: "text", text: "Live thread titles" }] },
    ],
  };
  assert.equal(geminiOutputText(body), "Live thread titles");
  assert.throws(() => geminiOutputText({ steps: [] }));
});

test("backendProblem reports missing configuration", () => {
  const base: BackendConfig = {
    backend: "gemini",
    geminiApiKey: "",
    geminiModel: "gemini-3.5-flash-lite",
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiApiKey: "",
    openaiModel: "",
    command: "",
  };
  assert.equal(backendProblem(base), "Add a Gemini API key");
  assert.equal(backendProblem({ ...base, geminiApiKey: "k" }), null);
  assert.equal(backendProblem({ ...base, backend: "openai-compatible" }), "Set a model name");
  assert.equal(backendProblem({ ...base, backend: "command", command: "cat" }), null);
});

test("fallbackShortName drops an area label and keeps the words that fit", () => {
  assert.equal(fallbackShortName("Mac: the app asks for the Accessibility permission itself"), "the app asks for the…");
  assert.equal(fallbackShortName("Show dates"), "Show dates");
  assert.equal(fallbackShortName("Qt: macOS app bundle"), "macOS app bundle");
});

test("buildShortNamePrompt asks for a few words, no id", () => {
  const prompt = buildShortNamePrompt("Qt: macOS app bundle, DMG", "Ship a DMG.");
  assert.match(prompt, /2 to 4 words/u);
  assert.match(prompt, /No issue id/u);
  assert.match(prompt, /<issue-title>Qt: macOS app bundle, DMG<\/issue-title>/u);
  assert.match(prompt, /<issue-description>Ship a DMG.<\/issue-description>/u);
});
