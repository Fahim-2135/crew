# How this brain works

This folder is the shared memory of a Crew team. Every agent reads and writes it, so the team
remembers across chats, days and agents. Crew commits it to git after every run, so nothing is
ever lost and every change can be traced.

## Map

| Path                             | What lives there                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `BRIEF.md`                       | Who the team works for, what they are working on, and the current priorities. Every agent reads it. The CEO keeps it current. |
| `departments/<agent>/memory/`    | That agent's notes. `MEMORY.md` is its index.                                                                                 |
| `departments/<agent>/inbox/`     | Requests from other agents. One file per request.                                                                             |
| `departments/<agent>/outputs/`   | Drafts and finished work.                                                                                                     |
| `departments/<agent>/playbooks/` | Step-by-step procedures the agent has worked out and reuses.                                                                  |
| `lessons/`                       | Things that were tried and later undone: what, why, and what it taught.                                                       |
| `config/agents.json`             | Where each agent may write inside the brain.                                                                                  |
| `system/agents/`                 | Each agent's definition (Crew installs a copy for Claude Code).                                                               |

## Writing a note

- One fact, decision, preference or open question per file.
- File name: `<agent>--<slug>.md`, for example `writer--no-exclamation-marks.md`.
- Start with front matter:

```yaml
---
id: writer--no-exclamation-marks
title: No exclamation marks in anything we publish
type: decision # decision | fact | preference | playbook | open-question | lesson
created: 2026-10-05
status: active # active | superseded
---
```

- Then the rule or fact in one line, then **Why:** and **How to apply:**.
- Use absolute dates (`2026-10-05`, never "yesterday").
- Add a one-line pointer to the note in your `MEMORY.md`.

## Changing your mind

Never keep two notes that disagree. Mark the old one `status: superseded`, point to the new
one, and say in the new one what changed and why. If something was actually built or done and
then undone, also write a lesson in `lessons/`.

## Asking another agent

Write a file in its inbox: `departments/<agent>/inbox/<date>-<from>-<slug>.md` with front matter
`from`, `to`, `created`, `status: open`, then the request in a few lines. Crew wakes that agent.
When it is handled, the agent sets `status: done`. Never edit another agent's notes.

## Never

- Write passwords, API keys, tokens or other secrets anywhere in the brain.
- Delete notes. Supersede them.
