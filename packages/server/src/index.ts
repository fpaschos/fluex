// Types the flue() plugin's virtual modules for every project that imports this package. Ambient module
// declarations only load through a reference: the file cannot be a module, so there is nothing to import.
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="./flue-virtual.d.ts" />

export { flowRoutes } from './flows/runs.ts'
export type { Flow, FlowRun } from './flows/run-types.ts'
export type { RunStatus } from '@fluex/sdk'
export { ask, type AskOptions } from './ask.ts'
export { describeError } from './errors.ts'
export { type SandboxRoutes, sandboxRoutes } from './sandboxes.ts'
