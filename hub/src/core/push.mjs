// Which hub events reach the user's phone as a notification, and what it says. Pure.
//
// Notifications carry as little as possible: who wants them and why in one or two words, never
// what an approval would do or what an agent wrote. The app fetches the details over the
// private network once they open it.

const TITLES = {
  ceo: "CEO",
  product: "Product",
  engineering: "Engineering",
  growth: "Growth",
  social: "Social",
  ops: "Ops",
  learning: "Learning",
  coder: "Coder",
};

/**
 * `ring` sends it on the phone's "calls-v2" channel (a ringtone instead of a ping): for an agent
 * that needs the user outside quiet hours, and for a call they asked to be called back on.
 * @param {{ type: string, data: any }} event
 * @param {{ job?: { kind: string, origin: string } | null, callBack?: boolean, quiet?: boolean }} context
 * @returns {{ title: string, body: string, data: Record<string, string>, urgent: boolean,
 *   ring: boolean } | null}
 */
export function pushFor(event, context = {}) {
  const message = rule(event, context);
  // The app opens the call screen for a ringing notification, the chat for the rest.
  if (message?.ring) message.data = { ...message.data, ring: "1" };
  return message;
}

function rule(event, { job = null, callBack = false, quiet = false, titles = {} }) {
  // Agents the user created carry their own names.
  const title = (agent) => titles[agent] ?? TITLES[agent] ?? "Crew";
  const { type, data } = event;
  switch (type) {
    case "approval.requested":
      return {
        title: `${title(data.agent)} needs you`,
        body: data.tainted
          ? "A request that started from an email. Tap to review."
          : "Tap to review.",
        data: { k: "approval", agent: data.agent, code: data.code },
        urgent: true,
        ring: !quiet,
      };
    case "approval.reminder":
      return {
        title: `${title(data.agent)} is still waiting`,
        body: "A request from earlier needs a yes or no.",
        data: { k: "approval", agent: data.agent, code: data.code },
        urgent: false,
        ring: false,
      };
    case "job.done":
    case "job.failed":
      if (callBack) {
        return {
          title: `${title(data.agent)} is calling you back`,
          body: type === "job.done" ? "Tap to answer." : "It hit a problem. Tap to hear it.",
          data: { k: "call", agent: data.agent, jobId: String(data.jobId) },
          urgent: true,
          ring: true,
        };
      }
      // A call they stayed on was heard already.
      if (job?.kind === "call") return null;
      // Only an answer to something the user sent from the phone; replies to the PC stay there.
      if (job?.origin !== "phone") return null;
      return {
        title:
          type === "job.done"
            ? `${title(data.agent)} replied`
            : `${title(data.agent)} hit a problem`,
        body: "Tap to read it.",
        data: { k: "thread", agent: data.agent },
        urgent: false,
        ring: false,
      };
    case "alert":
      if (data.kind === "hub") {
        return {
          title: "Crew restarted",
          body: "The hub on your PC crashed and came back by itself.",
          data: { k: "report" },
          urgent: false,
          ring: false,
        };
      }
      return {
        title: "Crew stopped a run",
        body: `${title(data.agent)}: something looked wrong. Check it on the PC.`,
        data: { k: "thread", agent: data.agent ?? "" },
        urgent: true,
        ring: false,
      };
    case "report":
      return {
        title: "Your Crew report is ready",
        body: "Tap to read today's report.",
        data: { k: "report" },
        urgent: false,
        ring: false,
      };
    default:
      return null;
  }
}
