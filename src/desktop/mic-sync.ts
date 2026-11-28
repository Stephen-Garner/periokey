export type MicHandle = { start(): void; close(): void };

export type MicSync = { sync(): void; stop(): void; isOpen(): boolean };

// why: Start, Stop, Start while the mic opens must end with it on, so each open rechecks.
export function createMicSync(deps: {
  wanted(): boolean;
  open(): Promise<MicHandle>;
  onBlocked(): void;
}): MicSync {
  let mic: MicHandle | null = null;
  let opening = false;
  let token = 0;
  // why: after a failure, wait for the next Start (wanted goes false, then true) before trying again.
  let failed = false;

  function stop(): void {
    token += 1;
    mic?.close();
    mic = null;
  }

  function blocked(): void {
    stop();
    failed = true;
    deps.onBlocked();
  }

  function sync(): void {
    if (!deps.wanted()) {
      failed = false;
      return stop();
    }
    if (mic || opening || failed) return;
    opening = true;
    const mine = token;
    deps
      .open()
      .then(
        (handle) => {
          // why: Stop may have come while the mic was opening; a late stream is closed, never kept.
          if (mine !== token || !deps.wanted()) return handle.close();
          try {
            handle.start();
          } catch {
            // why: audio setup failed after the mic opened; close it now so it is not left on.
            handle.close();
            return blocked();
          }
          mic = handle;
        },
        () => {
          if (mine === token) blocked();
        },
      )
      .finally(() => {
        opening = false;
        sync();
      });
  }

  return { sync, stop, isOpen: () => mic !== null };
}
