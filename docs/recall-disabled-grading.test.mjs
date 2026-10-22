import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fetchRecallAsset } from "../worker/recall/assets.generated.js";

const pages = [
  ["Pages", readFileSync(new URL("./recall/index.html", import.meta.url), "utf8")],
  ["Worker", readFileSync(new URL("../worker/recall/public/index.html", import.meta.url), "utf8")],
  ["bundle", await fetchRecallAsset(new Request("https://offline.test/")).text()],
];

for (const [name, html] of pages) {
  test(name + ": disabled grading keeps manual review without sending answers", async () => {
    const start = html.indexOf("async function submitAnswer(){");
    const end = html.indexOf("function showWaitChallenge(", start);
    assert.ok(start >= 0 && end > start);
    let revealed = 0, message = "";
    const draft = { text: "retained answer", strokes: [[1, 2, 3]] };
    const before = JSON.stringify(draft);
    const context = vm.createContext({
      answerDrafts: { example: draft },
      showToast: text => { message = text; },
      revealAnswer: () => { revealed++; },
      fetch: () => { throw new Error("disabled grading must not call the server"); },
      document: { getElementById: () => { throw new Error("must not read or serialize an answer"); } },
    });
    vm.runInContext(html.slice(start, end), context);
    await vm.runInContext("submitAnswer()", context);
    assert.equal(revealed, 1);
    assert.match(message, /AI 批改已停用/);
    assert.equal(JSON.stringify(draft), before);
    assert.match(html, /id="submitAnswerBtn"[^>]* disabled>AI 批改已停用/);
    assert.ok(html.includes('id="revealBtn" onclick="revealAnswer()">直接看標答'));
    assert.match(html, /歷史 Gemini 批改（非本次結果）/);
    assert.doesNotMatch(html, /Gemini 即時批改|送出後由 Gemini 批改/);
  });
}

test("all shipped disabled-grading pages are identical", () => {
  assert.equal(pages[0][1], pages[1][1]);
  assert.equal(pages[0][1], pages[2][1]);
});
