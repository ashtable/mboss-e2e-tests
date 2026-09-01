# Conventions

Handlers live in `lib/`, one exported function per block, named for what the
block does. Types the blocks pass along go in `lib/types.ts`.

`src/workflows/` is written by the compiler. Nothing here edits it.
