// The code-behind's own types.
//
// Both blocks in this project's workflow are typed
// against a name in here. Core refuses to validate
// a graph whose code-behind exports no type a block
// names, so leaving these out would put an error on
// the canvas in a spec that is not about errors.

export type Enquiry = { question: string };

export type Answer = { text: string };
