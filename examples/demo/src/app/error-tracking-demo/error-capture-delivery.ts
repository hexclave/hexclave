export async function deliverErrorCapture<TResult>(
  capture: () => TResult,
  flush: () => Promise<void>,
): Promise<TResult> {
  const captured = capture();
  await flush();
  return captured;
}
