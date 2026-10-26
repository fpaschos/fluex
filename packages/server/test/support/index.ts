// The virtual modules' types, for the tests (see ../../src/index.ts).
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../../src/flue-virtual.d.ts" />

export { type Admission, type Chunk, type TestApp, useApp } from './app.ts'
export { submits, useFauxCodex } from './model.ts'
