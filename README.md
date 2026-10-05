# Crew

**An always-on team of AI agents on your own computer, built on Claude Code.**

Crew gives you a small team (a CEO, Research, Writer and Builder to start) that lives on your
PC or Mac. You chat with them in the Crew window, and they get on with the work: reading and
writing files, using the web and your apps, running the computer, and remembering everything
in a shared brain that grows with you.

Anything that can't be undone or reaches other people (sending an email, posting, deleting,
paying) waits for your quick OK first. Everything else, they just do.

## Install

You need [Claude Code](https://claude.com/claude-code) with a Claude subscription, on Windows
or macOS. In Claude Code, type:

```
/plugin marketplace add Fahim-2135/crew
/plugin install crew
/crew:setup
```

Claude asks your name and what you work on, then sets everything up: your brain, the starter
team, Crew starting with your computer, a Crew icon on the desktop. The Crew window opens when
it's done. That's the last command you'll type.

## What you can do

- **Talk to any agent** in the Crew window. Attach screenshots, PDFs or documents.
- **Several agents work at once**, each on its own task.
- **Agents use your apps.** Connected apps (Gmail, Calendar, Drive, Notion, Slack…) directly;
  any website through their own browser, signed in where you sign them in; and the screen
  itself when nothing else will do (Windows), asking you before they touch the mouse.
- **They set things up themselves.** Ask for something new and the agent installs what it
  needs. You only do what a person must: approve, sign in, choose.
- **New agents** with the **New agent** button: describe what you need, and the CEO drafts it
  for your OK.
- **They learn.** Agents keep notes and playbooks in the brain (`~/crew-brain`), and a thumbs
  down makes an agent review how it works.
- **Links and files** in replies are clickable.
- **claude-face** (optional, Windows): a small floating face that shows when an agent is
  working, done, or needs you. Click it to jump to that agent.

## How it stays safe

- Crew runs on your computer. Your brain, chats and files stay there; nothing is sent anywhere
  except the Claude conversations themselves.
- A short list of actions always asks first: sending, posting, inviting, sharing, deleting,
  pushing to main, publishing, paying, changing live databases, and the clicks on websites that
  do those things. You get a notification and approve or deny in the window.
- A run started by an email treats it as data: it gets no web tools and asks before anything
  beyond reading.
- **Stop everything** with the switch in the window (or `crew off`).

## Good to know

- Agents use your Claude plan. Several agents working at once use it faster.
- The brain is a folder of Markdown notes in git: read it, edit it, back it up.
- Run `/crew:setup` again after updating the plugin: it installs the new version and keeps
  everything you have.

## Uninstall

In Claude Code: `/plugin uninstall crew`. Then delete the Crew folder
(`%LOCALAPPDATA%\crew` on Windows, `~/.local/share/crew` on a Mac), the desktop icon, and your
brain (`~/crew-brain`) if you don't want to keep it.

## License

MIT
