---
name: skill-installer
description: Use this skill only when the user explicitly wants to install, add, copy, update, modify, or register Pi Desktop skill files. Do not use it merely to invoke or follow an already available skill. Handles conversational installation of local skill directories into either ~/.pi/agent/skills for user-wide use or the current project's .pi/skills for project-local use, preserves versions before edits, lets the user list and restore older versions, and reloads Pi Desktop skills after changes.
---

# Skill Installer

Use this skill to install or edit local Pi Desktop skill directories through conversation.

Do not use this skill for ordinary user tasks. If a user asks to search, browse, write, analyze, or otherwise complete work using an already available skill, follow that skill directly instead of installing it.

## Install Targets

- Project install: `<current project>/.pi/skills`
- User install: `~/.pi/agent/skills`

Default to a project install unless the user clearly asks for a global, user-wide, or all-projects install.
Built-in skills under the bundled `skills/` directory are read-only. If the user wants to change one, copy it into a user or project skill first.

## Workflow

1. Identify the local source directory for the skill. It must contain `SKILL.md`.
2. If the source path is ambiguous, ask for the path instead of guessing.
3. Decide the scope:
   - Use `project` for the current project.
   - Use `user` for `~/.pi/agent/skills`.
4. Call `install_skill` with the source path and scope.
5. Leave `reload` enabled so the newly installed skill is available immediately.
6. If the user asks to update an existing installed skill, call `install_skill` with `overwrite: true`.
7. If the user wants to change a single file inside an installed skill, use `write_skill_file`.
8. If the user wants to roll back, call `list_skill_versions` first, then `restore_skill_version` with the chosen version id.

## Tool Use

These tools are only for installing, editing, versioning, restoring, or reloading skill files. Never use them for ordinary documents, including bidding/tender documents (招标文件), reports, source code, or application files.

Prefer `install_skill` over manual shell copying. It validates that the source is a skill directory, copies it to the selected skill directory, and reloads skills by default.

Use `write_skill_file` only for conversational edits to an installed skill. It saves a version before writing and reloads by default.

Use `list_skill_versions` and `restore_skill_version` when the user wants to inspect or recover an earlier version.

Use `reload_skills` after manual edits to installed skills, or when the user only asks to refresh/reload skill definitions.

## User-Facing Confirmation

After installation, tell the user:

- Which skill directory was installed.
- Whether it was installed to project or user scope.
- Whether skills were reloaded successfully.
- Whether a version was saved or restored.
