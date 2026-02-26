import { config } from "../config";
import { registerTool } from "./registry";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || "";

async function githubApi(path: string): Promise<any> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Farid/1.0",
  };
  if (GITHUB_TOKEN) headers.Authorization = `token ${GITHUB_TOKEN}`;

  const resp = await fetch(`https://api.github.com${path}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`GitHub API ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

registerTool({
  name: "github_activity",
  description: "Check recent GitHub activity — commits, PRs, repos. Shows what you've been coding on.",
  parameters: {
    username: { type: "string", description: "GitHub username (uses default if not specified)" },
    repo: { type: "string", description: "Filter by repo name (e.g. 'Farid')" },
    limit: { type: "number", description: "Max events to show (default 10)" },
  },
  async execute(args) {
    const user = args.username || GITHUB_USERNAME;
    if (!user) return "No GitHub username configured. Set GITHUB_USERNAME in env.";

    const limit = args.limit || 10;

    try {
      if (args.repo) {
        // Get recent commits for a specific repo
        const commits = await githubApi(`/repos/${user}/${args.repo}/commits?per_page=${limit}`);
        if (!commits.length) return `No recent commits in ${user}/${args.repo}.`;

        const lines = commits.map((c: any) => {
          const date = new Date(c.commit.author.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          const msg = c.commit.message.split("\n")[0].slice(0, 60);
          return `• ${date}: ${msg}`;
        });

        return `Recent commits in ${args.repo} (${commits.length}):\n${lines.join("\n")}`;
      }

      // Get recent events for the user
      const events = await githubApi(`/users/${user}/events?per_page=30`);

      const relevant = events
        .filter((e: any) => ["PushEvent", "PullRequestEvent", "CreateEvent", "IssuesEvent"].includes(e.type))
        .slice(0, limit);

      if (relevant.length === 0) return `No recent GitHub activity for ${user}.`;

      const lines = relevant.map((e: any) => {
        const repo = e.repo.name.replace(`${user}/`, "");
        const date = new Date(e.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });

        switch (e.type) {
          case "PushEvent": {
            const count = e.payload.commits?.length || 0;
            return `• ${date}: Pushed ${count} commit(s) to ${repo}`;
          }
          case "PullRequestEvent":
            return `• ${date}: PR ${e.payload.action} in ${repo}: "${e.payload.pull_request?.title?.slice(0, 40)}"`;
          case "CreateEvent":
            return `• ${date}: Created ${e.payload.ref_type} ${e.payload.ref || ""} in ${repo}`;
          case "IssuesEvent":
            return `• ${date}: Issue ${e.payload.action} in ${repo}: "${e.payload.issue?.title?.slice(0, 40)}"`;
          default:
            return `• ${date}: ${e.type} in ${repo}`;
        }
      });

      // Group by repo for summary
      const byRepo: Record<string, number> = {};
      for (const e of relevant) {
        const repo = e.repo.name.replace(`${user}/`, "");
        byRepo[repo] = (byRepo[repo] || 0) + 1;
      }
      const repoSummary = Object.entries(byRepo)
        .sort((a, b) => b[1] - a[1])
        .map(([r, c]) => `${r} (${c})`)
        .join(", ");

      return `GitHub activity for ${user}:\nActive repos: ${repoSummary}\n\n${lines.join("\n")}`;
    } catch (err: any) {
      return `GitHub API error: ${err.message}`;
    }
  },
});
