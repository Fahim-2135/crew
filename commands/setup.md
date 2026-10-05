---
description: Set up Crew, your always-on team of AI agents (run once, and again after an update)
---

Set up Crew for the user. They should never have to type a command: you run everything, and
ask them only for what a person has to answer.

1. **Node.js.** Run `node -v`. Crew needs Node.js 22.5 or newer. If it is missing or older, install
   it yourself (Windows: `winget install OpenJS.NodeJS.LTS`; macOS: `brew install node`), then
   check again. If neither works, tell the user to install the LTS version from nodejs.org and
   say "set up Crew" again.

2. **New or update?** Run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/hub/bin/crew.mjs" setup --check
   ```

   If it says `"installed": true`, this is an update: skip the questions and go to step 3 with
   no `--name` or `--focus`. Otherwise ask two short questions (in one message, or with the
   question tool):
   - What should the agents call you?
   - In a sentence, what do you work on? (Projects, job, what you'd like help with.)

   Use only their answers, never what you know about them from elsewhere.

3. **Run the setup** with their answers, quoting each value (for an update, with neither flag):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/hub/bin/crew.mjs" setup --name "<their name>" --focus "<what they work on>"
   ```

   It creates their brain (`~/crew-brain`), the starter team (CEO, Research, Writer, Builder),
   starts Crew with the computer, puts a Crew icon on the desktop, and opens the Crew window.
   Running it again is safe: it keeps everything and installs the newer version.

4. **claude-face (Windows).** Ask if they'd like the floating face that shows when an agent is
   working, done or needs them. If yes, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/hub/bin/crew.mjs" face install
   ```

5. **Tell them, in four short lines:**
   - The Crew window is open; the icon on the desktop brings it back.
   - Talk to any agent there. They can use the computer, the web and their apps; anything that
     can't be undone (sending, posting, deleting) asks for a quick OK first.
   - For anything an agent needs from them (signing in to a site, an OK), a notification pops up.
   - New agents: the **New agent** button in the window.

If a step fails, read the error, fix what you can yourself, and run it again. Only ask the user
when it needs a person.
