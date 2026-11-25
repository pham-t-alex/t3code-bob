import type { ServerProviderSlashCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { parse as parseYaml } from "yaml";

export interface BobMode {
  readonly slug: string;
  readonly name: string;
}

export const BOB_BUILT_IN_MODES: ReadonlyArray<BobMode> = [
  { slug: "agent", name: "Agent" },
  { slug: "plan", name: "Plan" },
  { slug: "ask", name: "Ask" },
];

const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function parseYamlRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = parseYaml(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const trimmedString = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

interface BobSkill extends ServerProviderSlashCommand {
  readonly hidden: boolean;
}

/** `user-invocable: false` hides a skill, at the top level or under `metadata`. */
function parseSkill(folder: string, contents: string): BobSkill {
  const frontmatter = parseYamlRecord(FRONTMATTER.exec(contents)?.[1] ?? "") ?? {};
  const metadata = frontmatter.metadata;
  const hidden =
    frontmatter["user-invocable"] === false ||
    (typeof metadata === "object" &&
      metadata !== null &&
      (metadata as Record<string, unknown>)["user-invocable"] === false);
  const description = trimmedString(frontmatter.description);
  return { name: folder, hidden, ...(description ? { description } : {}) };
}

const readText = Effect.fn("BobDiscovery.readText")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(path).pipe(Effect.option);
});

const readSkills = Effect.fn("BobDiscovery.readSkills")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folders = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
  const skills: Array<BobSkill> = [];
  for (const folder of folders.toSorted()) {
    const contents = yield* readText(path.join(directory, folder, "SKILL.md"));
    if (contents._tag === "Some") skills.push(parseSkill(folder, contents.value));
  }
  return skills;
});

const readModes = Effect.fn("BobDiscovery.readModes")(function* (file: string) {
  const contents = yield* readText(file);
  if (contents._tag === "None") return [];
  const entries = parseYamlRecord(contents.value)?.customModes;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown): Array<BobMode> => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const slug = trimmedString(record.slug);
    return slug ? [{ slug, name: trimmedString(record.name) ?? slug }] : [];
  });
});

function firstBy<A>(items: ReadonlyArray<A>, key: (item: A) => string): ReadonlyArray<A> {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(key(item))) return false;
    seen.add(key(item));
    return true;
  });
}

/**
 * Bob's custom modes and skills, read from its global (`~/.bob`) and project (`<cwd>/.bob`)
 * files. Modes keep Bob's order, built-in then global then project, with the first slug winning
 * (observed on Bob 2.1). Skills are `/name` commands, as Bob's own command list names them.
 */
export const discoverBobCatalog = Effect.fn("BobDiscovery.discoverBobCatalog")(function* (
  home: string,
  cwd?: string,
) {
  const path = yield* Path.Path;
  const globalDir = path.join(home, ".bob");
  const projectDir = cwd === undefined ? undefined : path.join(cwd, ".bob");
  const [globalModes, projectModes, projectSkills, globalSkills] = yield* Effect.all(
    [
      readModes(path.join(globalDir, "settings", "custom_modes.yaml")),
      projectDir ? readModes(path.join(projectDir, "custom_modes.yaml")) : Effect.succeed([]),
      projectDir ? readSkills(path.join(projectDir, "skills")) : Effect.succeed([]),
      readSkills(path.join(globalDir, "skills")),
    ],
    { concurrency: "unbounded" },
  );
  return {
    modes: firstBy([...BOB_BUILT_IN_MODES, ...globalModes, ...projectModes], (mode) => mode.slug),
    skills: firstBy([...projectSkills, ...globalSkills], (skill) => skill.name).flatMap(
      ({ hidden, ...command }): Array<ServerProviderSlashCommand> => (hidden ? [] : [command]),
    ),
  };
});
