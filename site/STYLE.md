# Writing the isolane documentation

The site in `site/` is built with [Blume](https://useblume.dev). Pages live
in `site/docs/`, one file per page, grouped into the four kinds that
[Diátaxis](https://diataxis.fr) describes. This file says what goes where,
how dense each kind of page is, and how to write so that the text reads as
if a careful engineer wrote it.

## The four sections

| Section | Reader's question | A page is | Never contains |
|---|---|---|---|
| `tutorials/` | "Teach me." | A lesson with one path from nothing to a working result, run end to end | Choices, alternatives, option tables |
| `guides/` | "How do I do X?" | A recipe for one task the reader already has | Background, history, teaching basics |
| `reference/` | "What exactly is X?" | A description of one part of the API, complete and in the code's order | Instructions, opinions, narratives |
| `concepts/` | "Why is it like this?" | An explanation of one idea, with its reasons and trade-offs | Steps to follow, option lists |

When a page starts to need another kind's content, link to that page
instead. A guide that needs every `fetch` option links to
`reference/capabilities#fetch`; it does not copy the table.

## Density

- **Tutorials** show complete, runnable code at every step and the output
  it prints. One new idea per step. Around 1,000 to 2,000 words.
- **Guides** open with one sentence that names the task and the result,
  then the code. Prose explains only what the code does not make obvious.
  Most fit on two screens. End with the failure the reader is most likely
  to hit, if there is one.
- **Reference** pages are complete: every option, its type, its default,
  its unit, and what happens at the edge (null, 0, past the limit). Use a
  table for anything with more than three entries of the same shape. One
  sentence per row is usual; two is the most.
- **Concepts** pages are prose. Each paragraph makes one claim and gives
  its reason. Use measured numbers where we have them, with the machine
  they were measured on. Around 800 to 1,500 words.

A sentence that could be deleted without the reader losing a fact gets
deleted.

## Voice

Write plain, formal, technical English in the present tense and the second
person ("you pass", "the worker refuses"). Say what the software does, not
what it "allows" or "enables" you to do. State limitations directly, in the
same tone as features.

## What not to write

These patterns are the ones the Wikipedia guide "Signs of AI writing"
lists. None of them belongs in these pages.

Words and phrases:

- Inflated significance: "plays a crucial/pivotal/key role", "serves as a
  testament", "underscores", "highlights the importance", "in today's
  landscape", "evolving", "cutting-edge", "seamless", "robust",
  "powerful", "comprehensive", "effortless", "blazing fast".
- The vocabulary list: additionally, delve, leverage, foster, enhance,
  showcase, streamline, intricate, multifaceted, holistic, ensure (when
  "make sure" or a plain verb works), crucial, vital, vibrant, tapestry.
- Replacing "is" with "serves as", "stands as", "functions as",
  "represents", "boasts", "features", "offers".
- Negative parallelisms: "not just X, but Y", "it's not X, it's Y",
  "no X, no Y, just Z", and openings that correct a misconception nobody
  stated.
- Participle tails that add a vague claim: "..., ensuring reliability",
  "..., making it ideal for".
- Hedges and disclaimers: "it's worth noting", "it is important to
  note", "generally", "typically" without a reason, "based on available
  information".
- Chat residue: "Let's", "Here's how", "In this guide, we'll",
  "Certainly", "I hope this helps", "Happy coding".
- Summaries of what was just said: "In summary", "In conclusion",
  "Overall", and closing paragraphs that restate the page.
- "Challenges and future outlook" endings. Put plans in the roadmap.

Structure and formatting:

- No bold-lead bullet lists ("**Fast:** ..."). Write a sentence, or use a
  table with a header row.
- No reflexive groups of three. List as many items as there are.
- Bold only for a term at the point it is defined, and rarely then.
- Headings in sentence case. No heading made only of other headings. No
  skipped levels. The page title is the frontmatter `title`; the body
  starts at `##`.
- No emoji. No horizontal rules between sections.
- Straight quotes and apostrophes.
- Callouts (`:::note`, `:::warning`) only for something the reader would
  regret missing: data loss, a security consequence, a platform
  difference. At most two per page.
- Tables only for data with columns. A two-row table is a sentence.

Facts:

- Every default, limit, and error code comes from the source (`ts/`,
  `crates/worker/`, `runtime/`), not from memory. Check it.
- Every number has a unit and, for measurements, the conditions.
- Code examples run. Prefer the smallest complete example to a fragment;
  when a fragment is clearer, it uses names already introduced on the
  page.
- Say "Linux only" wherever a limit or protection is Linux only.

## Names and terms

Use these terms the same way everywhere, and link the first use on a page
to the concept page that defines it.

| Term | Meaning |
|---|---|
| runtime | The `Runtime` object in the host process, and the supervisor it runs |
| host process | The Node.js process that imports isolane |
| tenant | A name the host chooses; one worker process per tenant |
| worker | The `isolane-worker` process that runs a tenant's V8 |
| isolate | One V8 isolate in a worker |
| guest code | The untrusted JavaScript isolane runs |
| eval | One `tenant.run`, `isolate.eval`, or `isolate.call` |
| program | What `tenant.load` returns: modules loaded into warm instances |
| instance | One isolate of a program, after its setup |
| setup | A program's top-level module evaluation |
| call | One `program.call` or `program.fetch` |
| host function | A function in the host process that guest code can call |
| broker | The host-process code that performs `fetch`, `connect`, or `fs` for guest code |
| retire | Stop using an isolate or instance after it was stopped part-way |

Write "isolane" in lower case, also at the start of a sentence.
