import { test } from "node:test";
import assert from "node:assert/strict";
import { createMicSync, type MicHandle } from "./mic-sync.ts";

type Request = {
  give(): void;
  fail(): void;
  handle: MicHandle & { started: boolean; closed: boolean };
};

function fakeMic(): {
  requests: Request[];
  open(): Promise<MicHandle>;
} {
  const requests: Request[] = [];
  return {
    requests,
    open() {
      return new Promise((resolve, reject) => {
        const handle = {
          started: false,
          closed: false,
          start() {
            handle.started = true;
          },
          close() {
            handle.closed = true;
          },
        };
        requests.push({
          give: () => resolve(handle),
          fail: () => reject(new Error("blocked")),
          handle,
        });
      });
    },
  };
}

const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

test("Start, Stop, Start while the mic is opening ends with the mic on", async () => {
  const fake = fakeMic();
  let listening = true;
  const mic = createMicSync({
    wanted: () => listening,
    open: fake.open,
    onBlocked() {},
  });
  mic.sync();
  listening = false;
  mic.sync();
  listening = true;
  mic.sync();
  fake.requests[0]?.give();
  await settle();
  assert.equal(fake.requests[0]?.handle.closed, true);
  assert.equal(fake.requests.length, 2);
  fake.requests[1]?.give();
  await settle();
  assert.equal(mic.isOpen(), true);
  assert.equal(fake.requests[1]?.handle.started, true);
});

test("a mic that opens after Stop is closed and never started", async () => {
  const fake = fakeMic();
  let listening = true;
  const mic = createMicSync({
    wanted: () => listening,
    open: fake.open,
    onBlocked() {},
  });
  mic.sync();
  listening = false;
  mic.sync();
  fake.requests[0]?.give();
  await settle();
  assert.equal(mic.isOpen(), false);
  assert.equal(fake.requests[0]?.handle.started, false);
  assert.equal(fake.requests[0]?.handle.closed, true);
  assert.equal(fake.requests.length, 1);
});

test("a blocked mic reports once and does not retry on its own", async () => {
  const fake = fakeMic();
  let listening = true;
  let blocked = 0;
  const mic = createMicSync({
    wanted: () => listening,
    open: fake.open,
    onBlocked() {
      blocked += 1;
      listening = false;
    },
  });
  mic.sync();
  fake.requests[0]?.fail();
  await settle();
  assert.equal(blocked, 1);
  assert.equal(fake.requests.length, 1);
  assert.equal(mic.isOpen(), false);
});

test("audio setup failing after the mic opens closes it, reports once, and waits for the next Start", async () => {
  const fake = fakeMic();
  let blocked = 0;
  const mic = createMicSync({
    wanted: () => true,
    open: fake.open,
    onBlocked() {
      blocked += 1;
    },
  });
  mic.sync();
  const first = fake.requests[0];
  assert.ok(first);
  first.handle.start = () => {
    throw new Error("audio setup failed");
  };
  first.give();
  await settle();
  mic.sync();
  await settle();
  assert.equal(first.handle.closed, true);
  assert.equal(fake.requests.length, 1);
  assert.equal(blocked, 1);
  assert.equal(mic.isOpen(), false);
});
