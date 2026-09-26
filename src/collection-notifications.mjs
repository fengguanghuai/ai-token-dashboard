/** Bounded long polling: finish immediately when a collection changes state.
 * The normal authenticated status endpoint is retained for reconnects and
 * clients that cannot keep a request open. No separate token-bearing URL. */
export function collectionNotifications(readState, send, { timeoutMs = 25_000 } = {}) {
  const waiting = new Set();
  return {
    wait(res) {
      if (readState().status !== 'running') { send(res, readState()); return; }
      const cleanup = () => {
        clearTimeout(timer);
        waiting.delete(finish);
        res.off('close', cleanup);
      };
      const finish = () => {
        cleanup();
        if (!res.destroyed && !res.writableEnded) send(res, readState());
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
      waiting.add(finish);
      res.once('close', cleanup);
    },
    publish() { for (const finish of [...waiting]) finish(); },
    get pending() { return waiting.size; }
  };
}
