// Worker entry. Wave 1 (Task 4) keeps this as a no-op. Wave 2 fills worker-loop,
// handlers and the adapter-bundle factory. The module MUST remain side-effect free
// at import time so unit tests can `import "@tk/worker"` without spawning loops.

export const workerPackageName = "@tk/worker";
export const workerReady = false as const;
