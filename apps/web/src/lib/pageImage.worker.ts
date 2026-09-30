import { doPageJob, type PageJob } from "./pageImage";

/** Measures or cleans up a drawn page off the main thread (see pageImage). */
self.addEventListener("message", (e: MessageEvent<PageJob>) => {
  void doPageJob(e.data).then(
    (result) => self.postMessage(result),
    (err: unknown) => self.postMessage({ error: String(err) }),
  );
});
