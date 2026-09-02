// The code-behind's own types.
//
// Every block in the sermon-helper spec is typed
// against a name in here. Core refuses to validate
// a graph whose code-behind exports no type a block
// names, so a missing name turns the agent's dry
// run into an error rather than a preview — which
// is why these eleven are the load-bearing part of
// this file and the members are not.
//
// The nine handler functions the same spec names
// are deliberately absent. A graph whose code
// behind does not exist yet is exactly what the
// propose-approve-scaffold loop is for, and core
// says so with a warning rather than an error.

export type SermonRequest = { requestId: string; email: string };

export type UploadedDocs = { files: string[] };

export type DocumentText = { text: string };

export type TextChunks = { chunks: string[] };

export type EmbeddedChunks = { vectors: number[][] };

export type EmbeddingIndex = { indexId: string; readings: string[] };

export type LectionaryReadings = { readings: string[] };

export type SermonOutline = { points: string[] };

export type ScoredOutline = { points: string[]; score: number };

export type SermonDraft = { markdown: string };

export type PublishedSermon = { url: string };
