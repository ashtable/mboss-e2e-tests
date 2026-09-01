// The code-behind's own types.
//
// A scaffolded handler is typed from the block
// that asked for it, and the block names these —
// so what `workflow_scaffold_step` writes is only
// as good as the scan that found them here.

export type Visitor = { name: string; email: string };

export type Greeting = { subject: string; body: string };
