# Pi Continuity: identity and naming

[Documentation](./README.md) · [Project overview](../README.md)

## Product name

**Pi Continuity** describes the goal: keep a useful working context and a way
back to evidence through long coding sessions. Context hygiene, recoverable
research, compaction and optional project memory support that goal.

The name does not promise lossless compression, perfect recall, persistent model
attention or an independent session engine. Pi owns the session lifecycle.

## What changed—and what did not

This is a product-identity and documentation change, not a package migration.

| Surface | Current name |
| --- | --- |
| Product identity and visual assets | **Pi Continuity** |
| npm package | `pi-smart-compact` |
| Repository | `alpertarhan/pi-smart-compact` |
| Command and current TUI title | `/smart-compact` / Smart Compact |
| Agent tools | `smart_compact`, `smart_context`, `smart_recall`, `smart_save_memory` |
| Settings namespace | `smartCompact` |
| Runtime directories, record types and reference formats | Unchanged |

Install with `pi install npm:pi-smart-compact`. Do not install `pi-continuity`
or rename settings, directories, memory tags or references on the strength of
this new branding. Existing state needs no migration for this change.

As checked on 2026-09-27, the npm registry returned no package for
`pi-continuity` or `pi-context-keeper`; `pi-context` was an existing project.
This was an availability observation, not a reservation, trademark clearance,
publication or guarantee of future availability.

## Visual language

Three page-like panels represent earlier, middle and recent work. One continuous
thread connects them: reduce noise while keeping the relationship between
constraints, decisions and the next step. This is a visual metaphor, not a
claim that the implementation samples only three parts of a conversation.

| Role | Color |
| --- | --- |
| Ink | `#203746` |
| Continuity teal | `#24766C` |
| Thread gold | `#D6A34B` |
| Supporting text | `#50687A` |
| Paper | `#F4F6F7` |

The PNG mark was generated with OpenAI `gpt-image-1` and resized to 512×512.
The banner is an editable vector adaptation with live text; it uses Avenir Next
with system sans-serif fallbacks. Documentation body type follows the reader's
GitHub/npm renderer. There are no external fonts or scripts.

- [PNG mark](./assets/pi-smart-compact.png): the established catalog URL is kept,
  even though the artwork now represents Pi Continuity.
- [SVG banner](./assets/banner.svg): self-contained, with a title and description.

Do not encode essential instructions only in an image. Text documentation remains
the source for installation, controls, warnings and behavior.

## A future full rename would be a separate release

No full rename is scheduled by this document. If one is chosen later:

1. Recheck ownership and availability. An npm package is not renamed in place:
   publishing a different package name and changing the remote repository need
   explicit release-owner approval.
2. Specify the complete new public interface: package, commands, tools, settings,
   extension registration, image URLs, release automation and support links.
   Avoid a partial rename that leaves users guessing which namespace is active.
3. Inventory stored state before changing any identifiers. Test an explicit
   migration against backups, archived output, reload/fork state, memory refs,
   backend/project scopes and existing sessions. Renaming a directory is not a
   sufficient migration.
4. Verify an isolated old-install → new-install transition, publish clear upgrade
   and rollback instructions, and remove obsolete paths only after the cutover
   requirements are satisfied. Do not change daily installations implicitly.

That work is intentionally outside this branding change. There are no new
command aliases, runtime shims, automatic data moves or duplicate packages.
