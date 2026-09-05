// The code-behind's one type.
//
// Both handlers take it and give it back, so the
// two are alike in every way the rules look at
// except one: what they do. That is deliberate —
// a spec about a handler being put away wants
// nothing else that could have put it away.

export type Claim = {
  reference: string;
  pence: number;
  settled: boolean;
};
