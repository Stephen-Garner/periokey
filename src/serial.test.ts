import { test } from "node:test";
import assert from "node:assert/strict";
import { createSerialQueue } from "./serial.ts";

test("a failed typing job reports its error and later phrases still run in order", async () => {
  const errors: string[] = [];
  const done: string[] = [];
  const run = createSerialQueue((error) =>
    errors.push(error instanceof Error ? error.message : String(error)),
  );
  void run(async () => {
    done.push("first");
  });
  void run(() => Promise.reject(new Error("helper stopped")));
  await run(async () => {
    done.push("third");
  });
  assert.deepEqual(done, ["first", "third"]);
  assert.deepEqual(errors, ["helper stopped"]);
});
