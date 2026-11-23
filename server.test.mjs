import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

let server;
let base;
before(async () => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(base);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Текст заявки/);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error("Server did not start");
});
after(async () => {
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
});

async function post(body) {
  return fetch(`${base}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

for (const [text, topic] of [["Где доставка?", "delivery"], ["Какая стоимость?", "pricing"], ["Здравствуйте", "other"]]) {
  test(`ready: ${topic}`, async () => {
    const response = await post(JSON.stringify({ text }));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.status, "ready");
    assert.equal(data.topic, topic);
    assert.ok(typeof data.draft === "string" && data.draft.trim());
    assert.deepEqual(Object.keys(data).sort(), ["draft", "status", "topic"]);
  });
}

for (const marker of ["[error]", "[timeout]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`manual review: ${marker}`, async () => {
    const start = performance.now();
    const response = await post(JSON.stringify({ text: marker }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "manual_review", topic: null, draft: null });
    if (marker === "[timeout]") {
      // Allow scheduling overhead, but reject waiting for the mock's 1200 ms delay.
      assert.ok(performance.now() - start < 1000);
    }
  });
}

for (const body of ["{", "", "null", "[]", "{}", ...[null, 42, false, [], {}, "", "   ", "\n\t"].map((text) => JSON.stringify({ text }))]) {
  test(`invalid input: ${body}`, async () => {
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { status: "invalid_input" });
  });
}
