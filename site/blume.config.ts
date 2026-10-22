import { defineConfig } from "blume";

export default defineConfig({
  title: "isolane",
  description:
    "Run untrusted, multi-tenant JavaScript from Node.js in sandboxed V8 worker processes.",
  content: {
    root: "docs",
  },
  github: {
    owner: "ethndotsh",
    repo: "isolane",
    dir: "site",
  },
  theme: {
    accent: "teal",
    radius: "md",
    mode: "system",
  },
  markdown: {
    code: {
      icons: true,
    },
  },
  agents: {
    llmsTxt: true,
  },
});
