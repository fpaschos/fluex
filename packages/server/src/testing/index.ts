// The virtual modules' types, for projects that import only the testing entry (see ../index.ts).
// oxlint-disable-next-line typescript/triple-slash-reference
/// <reference path="../flue-virtual.d.ts" />

export { type Admission, type Chunk, type TestApp, useApp } from './app.ts'
export { submits, useFauxCodex } from './model.ts'
