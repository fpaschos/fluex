// The flue() plugin's virtual modules that we import: the plugin ships no declarations for them
// (these mirror its own, `src/bootstrap/virtual-modules.d.ts`). `.md` imports are typed by
// @flue/runtime itself (`types/markdown-md.d.ts`).

/** The agents an app's src/app.ts mounts. */
declare module 'virtual:flue/agents' {
  import type { Agent } from '@flue/runtime'
  export interface ScannedAgent {
    /** The exported function name, or its `agentName` static: keys the agent's durable storage. */
    readonly identity: string
    /** The agent function. */
    readonly agent: Agent
  }
  /** Every agent of the `'use agent'` modules under src/, path-ordered. */
  export const scannedAgents: readonly ScannedAgent[]
}

/** The app loader `useApp` uses (src/testing/app.ts). */
declare module 'virtual:flue/server' {
  import type { LoadedFlueNodeApplication, LoadFlueNodeApplicationOptions } from '@flue/vite'
  /** Assembles the runtime around app.ts, with no listener (what `vite dev` serves). */
  export function loadFlueNodeApplication(
    options?: LoadFlueNodeApplicationOptions
  ): Promise<LoadedFlueNodeApplication>
}
