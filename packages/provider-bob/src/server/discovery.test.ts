import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverBobCatalog } from "./discovery.ts";

const write = Effect.fn(function* (file: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, contents);
});

const skill = (frontmatter: string) => `---\n${frontmatter}\n---\n\nReply with OK.\n`;

describe("Bob catalog discovery", () => {
  it.effect("merges global and project skills and modes the way Bob does", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bob-home-" });
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bob-project-" });
      yield* write(
        path.join(home, ".bob", "settings", "custom_modes.yaml"),
        "customModes:\n  - slug: clash\n    name: Global clash\n  - slug: global-only\n    name: Global only\n  - name: No slug\n",
      );
      yield* write(
        path.join(cwd, ".bob", "custom_modes.yaml"),
        "customModes:\n  - slug: clash\n    name: Project clash\n  - slug: project-only\n",
      );
      const skills = [
        [home, "shared", "description: Global version"],
        [cwd, "shared", "description: Project version"],
        [home, "hidden-top", "user-invocable: false"],
        [cwd, "hidden-metadata", "metadata:\n  user-invocable: false"],
        [cwd, "hidden-either", "user-invocable: false\nmetadata:\n  user-invocable: true"],
        [home, "masked", "description: Global masked"],
        [cwd, "masked", "user-invocable: false"],
        [cwd, "plain", "name: plain"],
      ] as const;
      for (const [root, name, frontmatter] of skills) {
        yield* write(path.join(root, ".bob", "skills", name, "SKILL.md"), skill(frontmatter));
      }

      const catalog = yield* discoverBobCatalog(home, cwd);
      assert.deepEqual(catalog.modes, [
        { slug: "agent", name: "Agent" },
        { slug: "plan", name: "Plan" },
        { slug: "ask", name: "Ask" },
        { slug: "clash", name: "Global clash" },
        { slug: "global-only", name: "Global only" },
        { slug: "project-only", name: "project-only" },
      ]);
      assert.deepEqual(catalog.skills, [
        { name: "plain" },
        { name: "shared", description: "Project version" },
      ]);

      // Without a project, and with a malformed global file, only the built-ins remain.
      yield* write(path.join(home, ".bob", "settings", "custom_modes.yaml"), "customModes: [");
      const global = yield* discoverBobCatalog(home);
      assert.deepEqual(
        global.modes.map((mode) => mode.slug),
        ["agent", "plan", "ask"],
      );
      assert.deepEqual(global.skills, [
        { name: "masked", description: "Global masked" },
        { name: "shared", description: "Global version" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
