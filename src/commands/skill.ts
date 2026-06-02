/**
 * `axon skill list|add|run` — discover and run SKILL.md skills.
 *
 *   axon skill list                 table of discoverable skills
 *   axon skill add <name>           scaffold ~/.axon/skills/<name>/SKILL.md
 *   axon skill run <name> [prompt]  run the skill as an agent (tools + per-call
 *                                   permission gate, identical to `chat --agent`)
 *
 * A skill's body becomes part of the agent system prompt, alongside the resolved
 * AXON.md memory. The v0.0.11 workspace-confinement + SSRF guards apply to every
 * tool call the skill makes — the permission gate stays the human boundary.
 */

import chalk from "chalk";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { readConfig } from "../config.js";
import { PermissionStore } from "../permissions.js";
import { runAgentTurn, type ChatMessage } from "../agent.js";
import { resolveMemory, withMemory } from "../axonmd.js";
import {
  discoverSkills, findSkill, isValidSkillName, newSkillPath, type Skill,
} from "../skills/discovery.js";

const SKILL_RUNNER_PROMPT = [
  "You are AXON, a terminal-native coding assistant running on the user's machine.",
  "The user invoked a SKILL — saved instructions, included below. Carry it out using",
  "your tools (read_file, glob, grep, ls, bash, write_file, edit_file, web_fetch).",
  "Mutating tools ask for permission per call and file access is confined to the",
  "workspace. Follow the skill's instructions, but never exceed what the user asked",
  "for. Be concise; finish the task and stop.",
].join(" ");

function skillTemplate(name: string): string {
  return [
    "---",
    `name: ${name}`,
    "description: One-line summary of what this skill does.",
    "---",
    "",
    `# ${name}`,
    "",
    "Describe the steps the agent should take when this skill runs. Be specific.",
    "Use the available tools (read_file, glob, grep, ls, bash, write_file, edit_file,",
    "web_fetch) to do real work — mutating tools ask the user for permission per call.",
    "",
  ].join("\n");
}

export interface RunSkillOpts {
  model?:    string;
  mode?:     "auto" | "coding" | "chat";
  maxTurns?: number;
  /** Reuse an existing permission store (so the REPL's allowlist persists). */
  perms?:    PermissionStore;
}

/** Run a resolved skill as an agent turn. Shared by the CLI command and the REPL. */
export async function runSkill(skill: Skill, userPrompt: string, opts: RunSkillOpts = {}): Promise<void> {
  const cfg = readConfig();
  if (!cfg.apiKey) {
    console.error(chalk.yellow("Not logged in.") + " Run " + chalk.bold("axon login") + " first.");
    process.exitCode = 1;
    return;
  }

  const memory = resolveMemory();
  const system = withMemory(
    `${SKILL_RUNNER_PROMPT}\n\n# Skill: ${skill.name}\n${skill.body}`,
    memory,
  );
  const messages: ChatMessage[] = [{ role: "system", content: system }];
  messages.push({
    role:    "user",
    content: userPrompt.trim() || `Carry out the "${skill.name}" skill.`,
  });

  console.log(chalk.dim(`  ▶ running skill ${chalk.bold(skill.name)} ${chalk.dim(`(${skill.source})`)}`));

  const ctl = new AbortController();
  const onSignal = () => ctl.abort(new Error("user cancelled"));
  process.on("SIGINT", onSignal);
  try {
    await runAgentTurn(messages, opts.perms ?? new PermissionStore(), {
      apiBase:  cfg.apiBase,
      apiKey:   cfg.apiKey,
      model:    opts.model ?? cfg.defaultModel ?? "auto",
      mode:     opts.mode ?? "coding",
      signal:   ctl.signal,
      maxTurns: opts.maxTurns ?? 25,
      showMeta: true,
    });
  } finally {
    process.off("SIGINT", onSignal);
  }
}

/** Print the discoverable-skills table (also used by the REPL `/skills`). */
export function printSkillList(cwd: string = process.cwd()): void {
  const skills = discoverSkills(cwd);
  if (skills.length === 0) {
    console.log(chalk.dim("  no skills found. Create one with ") + chalk.bold("axon skill add <name>"));
    console.log(chalk.dim("  (searched ~/.axon/skills, ./.axon/skills, ./.claude/skills)"));
    return;
  }
  const width = Math.max(...skills.map((s) => s.name.length), 4);
  console.log("");
  for (const s of skills) {
    const desc = s.description || chalk.dim("(no description)");
    console.log(`  ${chalk.cyan(s.name.padEnd(width))}  ${chalk.dim(`[${s.scope}]`)}  ${desc}`);
  }
  console.log("");
}

export function registerSkill(program: Command): void {
  const skill = program
    .command("skill")
    .description("Discover and run SKILL.md skills (Claude-Code compatible).");

  skill.command("list")
    .alias("ls")
    .description("List discoverable skills (~/.axon/skills, ./.axon/skills, ./.claude/skills).")
    .action(() => printSkillList());

  skill.command("add <name>")
    .description("Scaffold a new skill at ~/.axon/skills/<name>/SKILL.md.")
    .action((name: string) => {
      if (!isValidSkillName(name)) {
        console.error(chalk.red(`✗ invalid skill name "${name}" — use letters, digits, - and _ only.`));
        process.exitCode = 1;
        return;
      }
      const file = newSkillPath(name);
      if (existsSync(file)) {
        console.error(chalk.yellow(`Skill already exists: ${file}`));
        process.exitCode = 1;
        return;
      }
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, skillTemplate(name), "utf-8");
      } catch (err) {
        console.error(chalk.red(`✗ could not create skill: ${(err as Error).message}`));
        process.exitCode = 1;
        return;
      }
      console.log(chalk.green("✓") + ` created ${file}`);
      console.log(chalk.dim(`  edit it, then run: `) + chalk.bold(`axon skill run ${name} "…"`));
    });

  skill.command("run <name> [prompt...]")
    .description("Run a skill as an agent (same tools + permissions as `chat --agent`).")
    .option("-m, --model <model>", "Specific model id (default: auto — let AXON route).")
    .option("-M, --mode <mode>",   "Session mode: auto | coding | chat", "coding")
    .option("--max-turns <n>",     "Cap LLM round-trips (default 25).", (v: string) => parseInt(v, 10))
    .action(async (name: string, promptParts: string[] | undefined, opts: RunSkillOpts) => {
      const s = findSkill(name);
      if (!s) {
        console.error(chalk.red(`✗ skill not found: ${name}`));
        console.error(chalk.dim("  run ") + chalk.bold("axon skill list") + chalk.dim(" to see what's available."));
        process.exitCode = 1;
        return;
      }
      await runSkill(s, (promptParts ?? []).join(" "), {
        model:    opts.model,
        mode:     opts.mode,
        maxTurns: opts.maxTurns,
      });
    });
}
