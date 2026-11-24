export function createSerialQueue(
  onError: (error: unknown) => void,
): (job: () => Promise<void>) => Promise<void> {
  let tail: Promise<void> = Promise.resolve();
  return (job) => {
    tail = tail.then(job).catch(onError);
    return tail;
  };
}
