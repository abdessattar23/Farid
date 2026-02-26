import { LinearClient } from "@linear/sdk";
import { config } from "../config";
import { registerTool } from "./registry";

const linear = new LinearClient({ apiKey: config.linear.apiKey });

const PROJECT_LABELS = ["Sofrecom", "YouCode", "Hack-Nation", "HR Platform", "Learning"];

// ─── Helpers ───

async function getTeamId(): Promise<string> {
  const teams = await linear.teams();
  if (teams.nodes.length === 0) throw new Error("No Linear teams found");
  return teams.nodes[0].id;
}

async function findStateId(teamId: string, statusName: string): Promise<string | undefined> {
  const states = await linear.workflowStates({
    filter: { team: { id: { eq: teamId } } },
  });
  const match = states.nodes.find(
    (s) => s.name.toLowerCase() === statusName.toLowerCase()
  );
  return match?.id;
}

async function findOrCreateLabel(name: string): Promise<string> {
  const labels = await linear.issueLabels({
    filter: { name: { eq: name } },
  });
  if (labels.nodes.length > 0) return labels.nodes[0].id;

  const created = await linear.createIssueLabel({ name, color: "#6B7280" });
  const label = await created.issueLabel;
  if (!label) throw new Error(`Failed to create label: ${name}`);
  return label.id;
}

// ─── Tools ───

registerTool({
  name: "create_task",
  description: "Create a new task (Linear issue) in your project tracker",
  parameters: {
    title: { type: "string", description: "Task title", required: true },
    description: { type: "string", description: "Task description (markdown supported)" },
    priority: { type: "number", description: "1=urgent, 2=high, 3=medium, 4=low" },
    project: { type: "string", description: "Project label", enum: PROJECT_LABELS },
  },
  async execute(args) {
    const teamId = await getTeamId();
    const input: any = { title: args.title, teamId };

    if (args.description) input.description = args.description;
    if (args.priority) input.priority = Number(args.priority);

    if (args.project) {
      const labelId = await findOrCreateLabel(args.project);
      input.labelIds = [labelId];
    }

    const result = await linear.createIssue(input);
    const issue = await result.issue;
    return `Task created: [${issue?.identifier}] "${issue?.title}" — ${issue?.url}`;
  },
});

registerTool({
  name: "list_my_tasks",
  description: "List your open tasks from Linear, optionally filtered by project or priority",
  parameters: {
    project: { type: "string", description: "Filter by project label", enum: PROJECT_LABELS },
    priority: { type: "number", description: "Filter by priority (1-4)" },
    limit: { type: "number", description: "Max results (default 15)" },
  },
  async execute(args) {
    const me = await linear.viewer;
    const filter: any = {
      assignee: { id: { eq: me.id } },
      state: { type: { nin: ["completed", "canceled"] } },
    };

    if (args.priority) {
      filter.priority = { eq: Number(args.priority) };
    }
    if (args.project) {
      filter.labels = { name: { eq: args.project } };
    }

    const issues = await linear.issues({
      filter,
      first: args.limit || 15,
    });

    if (issues.nodes.length === 0) {
      return args.project
        ? `No open tasks found for ${args.project}.`
        : "No open tasks found. You're all caught up!";
    }

    const lines = await Promise.all(
      issues.nodes.map(async (issue) => {
        const state = await issue.state;
        const labels = await issue.labels();
        const labelNames = labels.nodes.map((l) => l.name).join(", ");
        const priority = ["None", "Urgent", "High", "Medium", "Low"][issue.priority ?? 0];
        return `• [${issue.identifier}] ${issue.title} | ${priority} | ${state?.name || "?"} | ${labelNames || "No label"}`;
      })
    );

    return `Open tasks (${issues.nodes.length}):\n${lines.join("\n")}`;
  },
});

registerTool({
  name: "update_task",
  description: "Update an existing task's title, description, status, or priority",
  parameters: {
    id: { type: "string", description: "Issue identifier (e.g., 'ENG-123')", required: true },
    title: { type: "string", description: "New title" },
    description: { type: "string", description: "New description" },
    status: { type: "string", description: "New status name (e.g., 'In Progress', 'Done')" },
    priority: { type: "number", description: "New priority (1-4)" },
  },
  async execute(args) {
    const issues = await linear.searchIssues(args.id, { first: 1 });
    if (issues.nodes.length === 0) return `Task "${args.id}" not found.`;

    const issue = issues.nodes[0];
    const update: any = {};

    if (args.title) update.title = args.title;
    if (args.description) update.description = args.description;
    if (args.priority) update.priority = Number(args.priority);
    if (args.status) {
      const team = await issue.team;
      if (team) {
        const stateId = await findStateId(team.id, args.status);
        if (stateId) update.stateId = stateId;
        else return `Status "${args.status}" not found. Check available statuses.`;
      }
    }

    if (Object.keys(update).length === 0) return "Nothing to update — no fields provided.";

    await linear.updateIssue(issue.id, update);
    return `Task [${issue.identifier}] updated successfully.`;
  },
});

registerTool({
  name: "search_tasks",
  description: "Search tasks by text query across titles and descriptions",
  parameters: {
    query: { type: "string", description: "Search text", required: true },
    limit: { type: "number", description: "Max results (default 10)" },
  },
  async execute(args) {
    const results = await linear.searchIssues(args.query, {
      first: args.limit || 10,
    });

    if (results.nodes.length === 0) return `No tasks found matching "${args.query}".`;

    const lines = await Promise.all(
      results.nodes.map(async (issue) => {
        const state = await issue.state;
        const priority = ["None", "Urgent", "High", "Medium", "Low"][issue.priority ?? 0];
        return `• [${issue.identifier}] ${issue.title} | ${priority} | ${state?.name || "?"}`;
      })
    );

    return `Search results for "${args.query}" (${results.nodes.length}):\n${lines.join("\n")}`;
  },
});

registerTool({
  name: "complete_task",
  description: "Mark a task as completed",
  parameters: {
    id: { type: "string", description: "Issue identifier (e.g., 'ENG-123')", required: true },
  },
  async execute(args) {
    const issues = await linear.searchIssues(args.id, { first: 1 });
    if (issues.nodes.length === 0) return `Task "${args.id}" not found.`;

    const issue = issues.nodes[0];
    const team = await issue.team;
    if (!team) return "Could not determine the team for this task.";

    const states = await linear.workflowStates({
      filter: { team: { id: { eq: team.id } }, type: { eq: "completed" } },
    });

    if (states.nodes.length === 0) return "No 'completed' status found for this team.";

    await linear.updateIssue(issue.id, { stateId: states.nodes[0].id });
    return `Task [${issue.identifier}] "${issue.title}" marked as done!`;
  },
});

registerTool({
  name: "get_task_summary",
  description: "Get a summary of all tasks grouped by project and status — useful for daily briefs",
  parameters: {},
  async execute() {
    const me = await linear.viewer;
    const issues = await linear.issues({
      filter: {
        assignee: { id: { eq: me.id } },
        state: { type: { nin: ["completed", "canceled"] } },
      },
      first: 100,
    });

    if (issues.nodes.length === 0) return "No open tasks. Clean slate!";

    const byProject: Record<string, { urgent: number; high: number; medium: number; low: number; total: number }> = {};
    let totalCount = 0;

    for (const issue of issues.nodes) {
      const labels = await issue.labels();
      const projectLabel = labels.nodes.find((l) => PROJECT_LABELS.includes(l.name))?.name || "Other";

      if (!byProject[projectLabel]) {
        byProject[projectLabel] = { urgent: 0, high: 0, medium: 0, low: 0, total: 0 };
      }

      const p = issue.priority ?? 0;
      if (p === 1) byProject[projectLabel].urgent++;
      else if (p === 2) byProject[projectLabel].high++;
      else if (p === 3) byProject[projectLabel].medium++;
      else byProject[projectLabel].low++;

      byProject[projectLabel].total++;
      totalCount++;
    }

    const lines = Object.entries(byProject).map(([project, counts]) => {
      const parts: string[] = [];
      if (counts.urgent > 0) parts.push(`${counts.urgent} urgent`);
      if (counts.high > 0) parts.push(`${counts.high} high`);
      if (counts.medium > 0) parts.push(`${counts.medium} medium`);
      if (counts.low > 0) parts.push(`${counts.low} low`);
      return `  ${project}: ${counts.total} tasks (${parts.join(", ")})`;
    });

    return `Task Summary — ${totalCount} open tasks:\n${lines.join("\n")}`;
  },
});
