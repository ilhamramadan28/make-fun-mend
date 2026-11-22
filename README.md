# mend

One patch tool for every AI edit format. `mend` applies AI-written edits in
four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE
blocks, V4A patches, and text-editor tool calls as JSON — to a tree of text
files, to the specification in the make.fun kit. It finds the lines an edit
names at the first of three matching tiers (exact, trailing whitespace,
leading and trailing whitespace), and changes every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Node 22, standard library only. See SPEC.md in the kit for the contract.
