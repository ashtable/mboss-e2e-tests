// The code-behind's own types.
//
// Every block in this project's workflow is typed
// against a name in here. Core refuses to validate
// a graph whose code-behind exports no type a block
// names, so leaving these out would put an error on
// the canvas in a spec that is not about errors.
//
// A claim is a flag and nothing else. The spec that
// runs this types the input by hand, and every
// field it would have to fill in besides the one
// that decides the outcome is a field that can be
// mistyped for no gain.

export type Claim = { fail: boolean };

export type Settlement = { note: string };
